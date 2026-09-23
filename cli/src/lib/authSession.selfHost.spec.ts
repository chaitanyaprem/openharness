import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

// env.ts reads these once, at import, so they are set before anything under test loads.
const root = await mkdtemp(join(tmpdir(), 'harness-auth-selfhost-'))
const RELAY = 'ws://relay.test:8085'
process.env.HARNESS_AUTH_DIR = join(root, 'auth')
process.env.ADAPTER_DATA_DIR = join(root, 'data')
process.env.ADAPTER_COMPUTER_ID_FILE = join(root, 'computer-id')
process.env.HARNESS_SELF_HOSTED = 'true'
process.env.BACKEND_WS_URL = RELAY
process.env.HARNESS_ENROLLMENT_TOKEN = 'root-secret'

const { AuthSessionError, AuthSessionManager, clearAuthSession, readAuthSession, writeAuthSession } = await import('./authSession.js')

const enrolled = () => ({
  version: 1 as const,
  accessToken: 'rotated-away',
  autonomousEnv: 'prod' as const,
  computerId: 'computer-1',
  machineId: 'm_1',
  updatedAt: Date.now(),
  relay: RELAY,
})

/** The relay's two enrollment routes. `enroll` decides how the enroll POST answers. */
function relayFetch(enroll: () => Response) {
  return vi.fn<typeof fetch>(async (input) => {
    const url = String(input)
    if (url.endsWith('/api/self-host/challenge')) {
      return new Response(JSON.stringify({ success: true, data: { nonce: 'nonce-1' } }))
    }
    if (url.endsWith('/api/self-host/enroll')) return enroll()
    return new Response('', { status: 404 })
  })
}

afterEach(() => {
  clearAuthSession()
  vi.unstubAllGlobals()
})

afterAll(async () => {
  for (const key of ['HARNESS_AUTH_DIR', 'ADAPTER_DATA_DIR', 'ADAPTER_COMPUTER_ID_FILE', 'HARNESS_SELF_HOSTED', 'BACKEND_WS_URL', 'HARNESS_ENROLLMENT_TOKEN']) {
    delete process.env[key]
  }
  await rm(root, { recursive: true, force: true })
})

describe('AuthSessionManager on a self-hosted relay', () => {
  it('hands out the enrolled token without asking anyone', async () => {
    writeAuthSession(enrolled())
    const fetchMock = relayFetch(() => new Response('', { status: 500 }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(new AuthSessionManager('http://relay.test:8085').accessToken()).resolves.toBe('rotated-away')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('enrolls again when the relay refuses the token, and keeps the new one', async () => {
    writeAuthSession(enrolled())
    const fetchMock = relayFetch(() => new Response(JSON.stringify({ success: true, data: { accessToken: 'current', machineId: 'm_1' } })))
    vi.stubGlobal('fetch', fetchMock)
    const manager = new AuthSessionManager('http://relay.test:8085')
    const tokens = await Promise.all([
      manager.accessToken({ force: true, failedToken: 'rotated-away' }),
      manager.accessToken({ force: true, failedToken: 'rotated-away' }),
    ])
    expect(tokens).toEqual(['current', 'current'])
    // One enrollment for both callers: a challenge and an enroll.
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(readAuthSession()).toMatchObject({ accessToken: 'current', relay: RELAY })
  })

  it('does not enroll for a token that is already stale', async () => {
    writeAuthSession({ ...enrolled(), accessToken: 'current' })
    const fetchMock = relayFetch(() => new Response('', { status: 500 }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(new AuthSessionManager('http://relay.test:8085').accessToken({ force: true, failedToken: 'rotated-away' })).resolves.toBe('current')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('ends the session when the relay will not enroll this computer any more', async () => {
    writeAuthSession(enrolled())
    vi.stubGlobal('fetch', relayFetch(() => new Response(
      JSON.stringify({ success: false, error: { message: 'This machine is not allowed to enroll' } }),
      { status: 403 },
    )))
    const error = await new AuthSessionManager('http://relay.test:8085').accessToken({ force: true, failedToken: 'rotated-away' }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(AuthSessionError)
    expect((error as InstanceType<typeof AuthSessionError>).code).toBe('INVALID_REFRESH')
    expect(readAuthSession()).toBeNull()
  })

  it('keeps the session when the relay cannot be reached', async () => {
    writeAuthSession(enrolled())
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockRejectedValue(new TypeError('fetch failed')))
    const error = await new AuthSessionManager('http://relay.test:8085').accessToken({ force: true, failedToken: 'rotated-away' }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(AuthSessionError)
    expect((error as InstanceType<typeof AuthSessionError>).code).toBe('UNAVAILABLE')
    expect(readAuthSession()).toMatchObject({ accessToken: 'rotated-away' })
  })
})
