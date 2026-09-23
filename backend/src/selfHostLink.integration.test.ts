/**
 * Two daemons, one self-hosted relay. Enrollment is a machine key. Linking is the
 * existing password PAKE. The relay's Redis bus must carry the handshake and must
 * not carry the password.
 */
import { spawn, spawnSync, type ChildProcess } from 'child_process'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { createServer } from 'http'
import type { AddressInfo } from 'net'
import { tmpdir } from 'os'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { Redis } from 'ioredis'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import { RedisMemoryServer } from 'redis-memory-server'
import { afterAll, describe, expect, it } from 'vitest'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const REPO = fileURLToPath(new URL('../..', import.meta.url))
const CLI = join(REPO, 'cli', 'src', 'cli.ts')
const TSX = join(REPO, 'cli', 'node_modules', 'tsx', 'dist', 'cli.mjs')
const PASSWORD = 'plaintext-sentinel-password'
const TOKEN = 'enroll-token-for-test'

const children: ChildProcess[] = []
const dirs: string[] = []

function track(child: ChildProcess): ChildProcess {
  children.push(child)
  return child
}

function cliEnv(root: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: root,
    HARNESS_AUTH_DIR: join(root, 'auth'),
    ADAPTER_DATA_DIR: join(root, 'data'),
    ADAPTER_COMPUTER_ID_FILE: join(root, 'computer-id'),
    HARNESS_SELF_HOSTED: 'true',
    HARNESS_ENROLLMENT_TOKEN: TOKEN,
    ADAPTER_UPDATE_DISABLE: 'true',
    DISABLE_GRID_INSTALL: 'true',
    DISABLE_HOOK_INSTALL: 'true',
    HARNESS_STORE_OFFLINE: 'true',
    CABLE_FW_DISABLE: 'true',
    ...extra,
  }
}

function runCli(root: string, args: string[], extra: NodeJS.ProcessEnv = {}, stdin?: string): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = track(spawn(process.execPath, [TSX, CLI, ...args], {
      cwd: join(REPO, 'cli'),
      env: cliEnv(root, extra),
      stdio: ['pipe', 'pipe', 'pipe'],
    }))
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    child.on('close', (status) => resolve({ status, stdout, stderr }))
    if (stdin != null) {
      child.stdin?.end(stdin)
    } else {
      child.stdin?.end()
    }
  })
}

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

async function waitFor(url: string, predicate: (body: string) => boolean, timeoutMs: number): Promise<string> {
  const until = Date.now() + timeoutMs
  let last = ''
  while (Date.now() < until) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1000) })
      last = await res.text()
      if (res.ok && predicate(last)) return last
    } catch (err) {
      last = err instanceof Error ? err.message : String(err)
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`timed out waiting for ${url}: ${last}`)
}

describe('two daemons on a self-hosted relay', () => {
  let mongo: MongoMemoryReplSet | undefined
  let redisServer: RedisMemoryServer | undefined
  let backend: ChildProcess | undefined
  let backendLog = ''

  afterAll(async () => {
    for (const child of children) {
      if (child.exitCode == null) child.kill('SIGTERM')
    }
    if (backend && backend.exitCode == null) backend.kill('SIGTERM')
    await new Promise((r) => setTimeout(r, 500))
    for (const child of children) {
      if (child.exitCode == null) child.kill('SIGKILL')
    }
    if (backend && backend.exitCode == null) backend.kill('SIGKILL')
    for (const dir of dirs) {
      spawnSync('chmod', ['-R', 'u+w', dir])
      rmSync(dir, { recursive: true, force: true })
    }
    await redisServer?.stop()
    await mongo?.stop()
  })

  it('links them, and the relay bus does not see the password', async () => {
    mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } })
    redisServer = new RedisMemoryServer()
    const redisHost = await redisServer.getHost()
    const redisPort = await redisServer.getPort()
    const redisUrl = `redis://${redisHost}:${redisPort}`
    const backendPort = await freePort()
    backend = spawn(process.execPath, [join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'), join(ROOT, 'src', 'server.ts')], {
      cwd: ROOT,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        PORT: String(backendPort),
        DATABASE_URL: mongo.getUri('harness'),
        REDIS_URL: redisUrl,
        HARNESS_SELF_HOSTED: 'true',
        HARNESS_ENROLLMENT_TOKEN: TOKEN,
        HARNESS_BILLING_ENABLED: 'false',
        HARNESS_CREDENTIAL_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    backend.stdout?.on('data', (chunk: Buffer) => { backendLog += chunk.toString() })
    backend.stderr?.on('data', (chunk: Buffer) => { backendLog += chunk.toString() })
    await waitFor(`http://127.0.0.1:${backendPort}/api/health`, (body) => body.includes('"ok"'), 30_000)

    const homeA = mkdtempSync(join(tmpdir(), 'harness-a-'))
    const homeB = mkdtempSync(join(tmpdir(), 'harness-b-'))
    dirs.push(homeA, homeB)
    const ws = `ws://127.0.0.1:${backendPort}`
    const loginA = await runCli(homeA, ['login', '--json'], { BACKEND_WS_URL: ws })
    expect(loginA.status, loginA.stderr + loginA.stdout + backendLog).toBe(0)
    const loginB = await runCli(homeB, ['login', '--json'], { BACKEND_WS_URL: ws })
    expect(loginB.status, loginB.stderr + loginB.stdout).toBe(0)
    const sessionA = JSON.parse(readFileSync(join(homeA, 'auth', 'session.json'), 'utf8')) as { machineId: string }
    const setPw = await runCli(homeA, ['remote-password', 'set', '--stdin'], { BACKEND_WS_URL: ws }, `${PASSWORD}\n`)
    expect(setPw.status, setPw.stderr + setPw.stdout).toBe(0)

    const portA = await freePort()
    const portB = await freePort()
    const daemonA = track(spawn(process.execPath, [TSX, CLI, 'start'], {
      cwd: join(REPO, 'cli'),
      env: cliEnv(homeA, { BACKEND_WS_URL: ws, PORT: String(portA) }),
      stdio: ['ignore', 'pipe', 'pipe'],
    }))
    const daemonB = track(spawn(process.execPath, [TSX, CLI, 'start'], {
      cwd: join(REPO, 'cli'),
      env: cliEnv(homeB, { BACKEND_WS_URL: ws, PORT: String(portB) }),
      stdio: ['ignore', 'pipe', 'pipe'],
    }))
    let daemonLog = ''
    daemonA.stdout?.on('data', (chunk: Buffer) => { daemonLog += chunk.toString() })
    daemonA.stderr?.on('data', (chunk: Buffer) => { daemonLog += chunk.toString() })
    daemonB.stdout?.on('data', (chunk: Buffer) => { daemonLog += chunk.toString() })
    daemonB.stderr?.on('data', (chunk: Buffer) => { daemonLog += chunk.toString() })
    await waitFor(`http://127.0.0.1:${portA}/api/status`, (body) => body.includes('"connected":true'), 40_000)
    await waitFor(`http://127.0.0.1:${portB}/api/status`, (body) => body.includes('"connected":true'), 40_000)

    const tap = new Redis(redisUrl)
    const frames: string[] = []
    await tap.psubscribe('*')
    tap.on('pmessage', (_pattern: string, _channel: string, message: string) => { frames.push(message) })
    const link = await runCli(homeB, ['link', 'connect', sessionA.machineId, '--stdin', '--json'], { BACKEND_WS_URL: ws }, `${PASSWORD}\n`)
    await new Promise((r) => setTimeout(r, 500))
    await tap.quit()

    expect(link.status, link.stderr + link.stdout + daemonLog + backendLog).toBe(0)
    expect(link.stdout).toContain('"ok":true')
    const bus = frames.join('\n')
    expect(bus.length).toBeGreaterThan(0)
    expect(bus.includes(PASSWORD)).toBe(false)
    expect(backendLog.includes(PASSWORD)).toBe(false)
    expect(daemonLog.includes(PASSWORD)).toBe(false)
  }, 300_000)
})
