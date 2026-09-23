import { createPublicKey, verify as cryptoVerify } from 'crypto'
import { spawn, type ChildProcess } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import type { AddressInfo } from 'net'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import { tmpdir } from 'os'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { afterEach, describe, expect, it } from 'vitest'
import { enrollMessage } from './selfHostEnroll.js'

const CLI_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const CLI_SOURCE = join(CLI_ROOT, 'src', 'cli.ts')
const TSX = join(CLI_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs')
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')

function verifyEd25519(pub: Buffer, message: Buffer, signature: Buffer): boolean {
  const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, pub]), format: 'der', type: 'spki' })
  return cryptoVerify(null, message, key, signature)
}

const dirs: string[] = []
const servers: Server[] = []
const children: ChildProcess[] = []

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode == null) child.kill('SIGKILL')
  }
  for (const server of servers.splice(0)) {
    server.closeAllConnections?.()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function freshRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'harness-enroll-'))
  dirs.push(root)
  return root
}

interface FakeRelay {
  ws: string
  /** Every request the relay saw, in order. */
  requests: Array<{ url: string; host: string; body: Record<string, unknown> }>
}

/** A self-hosted relay that answers the challenge, checks the enroll signature, and resolves the machine. */
async function fakeRelay(): Promise<FakeRelay> {
  const requests: FakeRelay['requests'] = []
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? ''
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}') as Record<string, unknown>
      requests.push({ url, host: req.headers.host ?? '', body })
      res.setHeader('content-type', 'application/json')
      if (req.method === 'GET' && url.startsWith('/api/self-host/challenge')) {
        res.end(JSON.stringify({ success: true, data: { nonce: 'nonce-1' } }))
        return
      }
      if (url.startsWith('/api/self-host/enroll')) {
        const pub = Buffer.from(String(body.pubkey), 'base64')
        const sig = Buffer.from(String(body.signature), 'base64')
        const ok = verifyEd25519(pub, Buffer.from(enrollMessage('nonce-1', String(body.computerId), String(body.pubkey))), sig)
        res.statusCode = ok ? 200 : 401
        res.end(JSON.stringify(ok
          ? { success: true, data: { accessToken: 'machine-key', machineId: 'm_enrolled' } }
          : { success: false, error: { message: 'bad signature' } }))
        return
      }
      if (url.startsWith('/api/machines/resolve-computer')) {
        res.end(JSON.stringify({ success: true, data: { machine: { machineId: 'm_enrolled' } } }))
        return
      }
      res.statusCode = 404
      res.end()
    })
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { ws: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`, requests }
}

function cliEnv(root: string, extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: root,
    HARNESS_AUTH_DIR: join(root, 'auth'),
    ADAPTER_DATA_DIR: join(root, 'data'),
    ADAPTER_CLI_DIR: join(root, 'cli'),
    ADAPTER_COMPUTER_ID_FILE: join(root, 'computer-id'),
    HARNESS_SELF_HOSTED: 'true',
    HARNESS_ENROLLMENT_TOKEN: 'root-secret',
    ADAPTER_UPDATE_DISABLE: 'true',
    DISABLE_GRID_INSTALL: 'true',
    DISABLE_HOOK_INSTALL: 'true',
    PORT: '1',
    ...extra,
  }
}

function runCli(root: string, args: string[], extra: NodeJS.ProcessEnv): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [TSX, CLI_SOURCE, ...args], { cwd: CLI_ROOT, env: cliEnv(root, extra), stdio: ['ignore', 'pipe', 'pipe'] })
    children.push(child)
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    child.once('close', (status) => resolve({ status, stdout, stderr }))
  })
}

function seedSession(root: string, extra: Record<string, unknown> = {}): void {
  mkdirSync(join(root, 'auth'), { recursive: true })
  writeFileSync(join(root, 'auth', 'session.json'), JSON.stringify({
    version: 1, accessToken: 'sso-token', refreshToken: 'refresh', expiresAt: Date.now() + 3_600_000,
    autonomousEnv: 'prod', computerId: 'a'.repeat(32), machineId: 'm_upstream', updatedAt: Date.now(), ...extra,
  }))
}

function readSession(root: string): { accessToken: string; machineId: string; relay?: string } {
  return JSON.parse(readFileSync(join(root, 'auth', 'session.json'), 'utf8')) as { accessToken: string; machineId: string; relay?: string }
}

function lastJson(stdout: string): Record<string, unknown> {
  const lines = stdout.trim().split('\n').filter((l) => l.trim())
  return JSON.parse(lines[lines.length - 1] ?? '{}') as Record<string, unknown>
}

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

describe('self-host enrollment', () => {
  it('signs the same message the relay verifies', () => {
    expect(Buffer.from(enrollMessage('n', 'computer', 'pub')).toString()).toBe(
      'harness-self-host-enroll\nn\ncomputer\npub',
    )
  })

  it('harness login enrolls against the configured relay and does not open SSO', async () => {
    const root = freshRoot()
    const relay = await fakeRelay()
    const result = await runCli(root, ['login', '--json'], { BACKEND_WS_URL: relay.ws })
    expect(result.status, result.stderr + result.stdout).toBe(0)
    expect(relay.requests.some((r) => r.host.includes('autonomous'))).toBe(false)
    expect(result.stdout).not.toContain('auth.autonomous.ai')
    const enroll = relay.requests.find((r) => r.url.startsWith('/api/self-host/enroll'))
    expect(enroll?.body).toMatchObject({ enrollmentToken: 'root-secret', nonce: 'nonce-1' })
    const session = readSession(root)
    expect(session.accessToken).toBe('machine-key')
    expect(session.machineId).toBe('m_enrolled')
    expect(session.relay).toBe(relay.ws)
  }, 30_000)

  it('replaces a sign-in from the upstream relay instead of sending its token to this one', async () => {
    const root = freshRoot()
    seedSession(root)
    const relay = await fakeRelay()
    const result = await runCli(root, ['login', '--json'], { BACKEND_WS_URL: relay.ws })
    expect(result.status, result.stderr + result.stdout).toBe(0)
    expect(relay.requests.some((r) => r.url.startsWith('/api/self-host/enroll'))).toBe(true)
    expect(readSession(root)).toMatchObject({ accessToken: 'machine-key', relay: relay.ws })
  }, 30_000)

  it('re-enrolls when the session was issued by a different self-hosted relay', async () => {
    const root = freshRoot()
    seedSession(root, { accessToken: 'old-relay-token', relay: 'ws://10.9.9.9:8085' })
    const relay = await fakeRelay()
    const result = await runCli(root, ['login', '--json'], { BACKEND_WS_URL: relay.ws })
    expect(result.status, result.stderr + result.stdout).toBe(0)
    expect(readSession(root)).toMatchObject({ accessToken: 'machine-key', relay: relay.ws })
  }, 30_000)

  it('reads a self-hosted session as signed out once self-hosted mode is off', async () => {
    const root = freshRoot()
    seedSession(root, { accessToken: 'machine-key', relay: 'ws://10.9.9.9:8085' })
    const result = await runCli(root, ['auth', 'status', '--json'], { HARNESS_SELF_HOSTED: 'false', BACKEND_WS_URL: 'ws://127.0.0.1:1' })
    expect(result.status, result.stderr + result.stdout).toBe(0)
    expect(lastJson(result.stdout)).toMatchObject({ loggedIn: false })
  }, 30_000)

  it('local mode starts without enrolling, even with a self-host config', async () => {
    const root = freshRoot()
    const relay = await fakeRelay()
    const port = await freePort()
    const child = spawn(process.execPath, [TSX, CLI_SOURCE, 'start'], {
      cwd: CLI_ROOT,
      env: cliEnv(root, { HARNESS_LOCAL_ONLY: 'true', BACKEND_WS_URL: relay.ws, PORT: String(port) }),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    children.push(child)
    let output = ''
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString() })
    child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString() })
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))

    const until = Date.now() + 25_000
    let status: Record<string, unknown> | null = null
    while (!status && Date.now() < until) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/status`, { signal: AbortSignal.timeout(1_000) })
        if (res.ok) status = await res.json() as Record<string, unknown>
      } catch { /* not up yet */ }
      if (!status) await new Promise((r) => setTimeout(r, 250))
    }
    expect(status, output).toMatchObject({ localOnly: true, connected: false })
    child.kill('SIGTERM')
    await exited
    expect(relay.requests).toEqual([])
    expect(existsSync(join(root, 'auth', 'session.json'))).toBe(false)
  }, 40_000)
})
