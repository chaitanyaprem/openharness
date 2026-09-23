import { createPublicKey, verify as cryptoVerify } from 'crypto'
import { spawn, type ChildProcess } from 'child_process'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
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

describe('self-host enrollment', () => {
  it('signs the same message the relay verifies', () => {
    expect(Buffer.from(enrollMessage('n', 'computer', 'pub')).toString()).toBe(
      'harness-self-host-enroll\nn\ncomputer\npub',
    )
  })

  it('harness login enrolls against the configured relay and does not open SSO', async () => {
    const root = mkdtempSync(join(tmpdir(), 'harness-enroll-'))
    dirs.push(root)
    let sawAutonomous = false
    const bodies: Array<Record<string, unknown>> = []
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const host = req.headers.host ?? ''
      if (host.includes('autonomous')) sawAutonomous = true
      const url = req.url ?? ''
      if (req.method === 'GET' && url.startsWith('/api/self-host/challenge')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ success: true, data: { nonce: 'nonce-1' } }))
        return
      }
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString() || '{}') as Record<string, unknown>
        bodies.push({ url, body })
        if (url.startsWith('/api/self-host/enroll')) {
          const pub = Buffer.from(String(body.pubkey), 'base64')
          const sig = Buffer.from(String(body.signature), 'base64')
          const ok = verifyEd25519(pub, Buffer.from(enrollMessage('nonce-1', String(body.computerId), String(body.pubkey))), sig)
          res.writeHead(ok ? 200 : 401, { 'content-type': 'application/json' })
          res.end(JSON.stringify(ok
            ? { success: true, data: { accessToken: 'machine-key', machineId: 'm_enrolled' } }
            : { success: false, error: { message: 'bad signature' } }))
          return
        }
        if (url.startsWith('/api/machines/resolve-computer')) {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ success: true, data: { machine: { machineId: 'm_enrolled' } } }))
          return
        }
        res.writeHead(404)
        res.end()
      })
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    const child = spawn(process.execPath, [TSX, CLI_SOURCE, 'login', '--json'], {
      cwd: CLI_ROOT,
      env: {
        ...process.env,
        HOME: root,
        HARNESS_AUTH_DIR: join(root, 'auth'),
        ADAPTER_DATA_DIR: join(root, 'data'),
        ADAPTER_COMPUTER_ID_FILE: join(root, 'computer-id'),
        HARNESS_SELF_HOSTED: 'true',
        BACKEND_WS_URL: `ws://127.0.0.1:${port}`,
        HARNESS_ENROLLMENT_TOKEN: 'root-secret',
        ADAPTER_UPDATE_DISABLE: 'true',
        DISABLE_GRID_INSTALL: 'true',
      },
    })
    children.push(child)
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    const status = await new Promise<number | null>((resolve) => child.once('close', resolve))
    expect(status, stderr + stdout).toBe(0)
    expect(sawAutonomous).toBe(false)
    expect(stdout).not.toContain('auth.autonomous.ai')
    const enroll = bodies.find((row) => String(row.url).startsWith('/api/self-host/enroll'))
    expect(enroll?.body).toMatchObject({ enrollmentToken: 'root-secret', nonce: 'nonce-1' })
    const session = JSON.parse(readFileSync(join(root, 'auth', 'session.json'), 'utf8')) as { accessToken: string; machineId: string }
    expect(session.accessToken).toBe('machine-key')
    expect(session.machineId).toBe('m_enrolled')
  }, 30_000)
})
