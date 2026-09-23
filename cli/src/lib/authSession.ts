import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { env } from '../config/env.js'

export interface AuthSession {
  version: 1
  accessToken: string
  refreshToken?: string
  expiresAt?: number
  autonomousEnv: 'prod' | 'stag'
  computerId: string
  machineId?: string
  updatedAt: number
  /** The relay a self-hosted enrollment was issued by (its BACKEND_WS_URL). Absent on an SSO session.
   *  A session is only read back while the CLI points at that same relay, see readAuthSession. */
  relay?: string
  /** Never on disk. Set only on the in-memory identity a HARNESS_LOCAL_ONLY daemon runs on, so the
   *  daemon can tell an account-free run from a signed-in one whose machine is not resolved yet. */
  local?: true
}

export class AuthSessionError extends Error {
  constructor(message: string, readonly code: 'MISSING' | 'INVALID_REFRESH' | 'UNAVAILABLE') {
    super(message)
    this.name = 'AuthSessionError'
  }
}

// HARNESS_AUTH_DIR exists for isolated test processes. Product installs always use ~/.harness/auth.
export const AUTH_DIR = process.env.HARNESS_AUTH_DIR?.trim() || join(homedir(), '.harness', 'auth')
export const AUTH_SESSION_FILE = join(AUTH_DIR, 'session.json')
const LOCK_FILE = join(AUTH_DIR, 'session.lock')
const LOCK_STALE_MS = 30_000
const REFRESH_SKEW_MS = 60_000

function parse(raw: string): AuthSession | null {
  try {
    const value = JSON.parse(raw) as Partial<AuthSession>
    if (value.version !== 1 || typeof value.accessToken !== 'string' || !value.accessToken ||
      typeof value.computerId !== 'string' || !value.computerId ||
      (value.autonomousEnv !== 'prod' && value.autonomousEnv !== 'stag')) return null
    return {
      version: 1,
      accessToken: value.accessToken,
      ...(typeof value.refreshToken === 'string' && value.refreshToken ? { refreshToken: value.refreshToken } : {}),
      ...(typeof value.expiresAt === 'number' && Number.isFinite(value.expiresAt) ? { expiresAt: value.expiresAt } : {}),
      autonomousEnv: value.autonomousEnv,
      computerId: value.computerId,
      ...(typeof value.machineId === 'string' && value.machineId ? { machineId: value.machineId } : {}),
      updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : 0,
      ...(typeof value.relay === 'string' && value.relay ? { relay: value.relay } : {}),
    }
  } catch { return null }
}

/**
 * Does this session belong to the relay the CLI is configured for? A self-hosted session carries
 * the relay that issued it; an SSO session carries none. Handing one to the other only gets the
 * token refused, and the daemon would retry it forever, so a mismatch reads as no session at all.
 */
export function sessionMatchesRelay(session: AuthSession): boolean {
  if (env.HARNESS_SELF_HOSTED) return session.relay === env.BACKEND_WS_URL
  return session.relay == null
}

export function readAuthSession(): AuthSession | null {
  let session: AuthSession | null
  try { session = parse(readFileSync(AUTH_SESSION_FILE, 'utf8')) } catch { return null }
  return session && sessionMatchesRelay(session) ? session : null
}

export function hasAuthSession(): boolean { return readAuthSession() !== null }

function ensureDir(): void {
  mkdirSync(AUTH_DIR, { recursive: true, mode: 0o700 })
  try { chmodSync(AUTH_DIR, 0o700) } catch { /* best effort on non-POSIX */ }
}

export function writeAuthSession(session: AuthSession): void {
  ensureDir()
  const temp = join(AUTH_DIR, `.session.${process.pid}.${Date.now()}.tmp`)
  try {
    writeFileSync(temp, JSON.stringify(session) + '\n', { mode: 0o600 })
    try { chmodSync(temp, 0o600) } catch { /* best effort on non-POSIX */ }
    renameSync(temp, AUTH_SESSION_FILE)
    try { chmodSync(AUTH_SESSION_FILE, 0o600) } catch { /* best effort on non-POSIX */ }
  } finally {
    try { rmSync(temp, { force: true }) } catch { /* ignore */ }
  }
}

export function clearAuthSession(): void {
  try { rmSync(AUTH_SESSION_FILE, { force: true }) } catch { /* ignore */ }
}

async function withLock<T>(action: () => Promise<T>): Promise<T> {
  ensureDir()
  let deadline = Date.now() + LOCK_STALE_MS
  let reclaimedStaleLock = false
  while (true) {
    let fd: number
    try {
      fd = openSync(LOCK_FILE, 'wx', 0o600)
    } catch {
      if (Date.now() >= deadline) {
        let removed = false
        try {
          const age = Date.now() - statSync(LOCK_FILE).mtimeMs
          if (age >= LOCK_STALE_MS) {
            rmSync(LOCK_FILE, { force: true })
            removed = true
          }
        } catch { /* lock disappeared or is unreadable */ }
        if (removed && !reclaimedStaleLock) {
          reclaimedStaleLock = true
          deadline = Date.now() + LOCK_STALE_MS
          continue
        }
        throw new AuthSessionError('Another Harness process is refreshing SSO credentials. Please retry.', 'UNAVAILABLE')
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 40))
      continue
    }
    try {
      return await action()
    } finally {
      closeSync(fd)
      try { rmSync(LOCK_FILE, { force: true }) } catch { /* ignore */ }
    }
  }
}

type RefreshResult = { token: string; refreshToken?: string; expiresIn?: number }

/**
 * The sentence an `UNAVAILABLE` refresh failure carries — and why it names `harness login` even
 * though it is classified as a service problem.
 *
 * Measured 2026-09-06 against the live backend: an unusable refresh token comes back as
 * `503 {"error":{"code":"AUTH_SERVICE_UNAVAILABLE"}}` — **not** 401 and **not**
 * `REFRESH_TOKEN_INVALID`, so it never reaches the branch below whose whole job is to say the
 * sign-in is dead. Passing the upstream's own words through verbatim then tells somebody whose
 * sign-in has lapsed to wait for a service that is perfectly healthy, and that wait never ends.
 *
 * ⚠️ **It cannot simply be reclassified as `INVALID_REFRESH`.** The identical answer is what a
 * genuine outage gives, and that branch DELETES the session — destroying a refresh token nothing
 * can bring back, on a blip. Ambiguous means keep the credential and say both things. So the
 * classification stays `UNAVAILABLE`, nothing is deleted, and only the wording changes: the
 * upstream's reading first because it is the likelier one, the actionable one last because it is
 * the one that ends the loop.
 */
function unavailableMessage(said?: string): string {
  return `Could not renew this computer's sign-in${said ? ` (${said})` : ''}. `
    + 'That is usually the SSO service having a moment, but it is also what a lapsed sign-in looks '
    + 'like here — if it keeps happening, run `harness login` to sign in again.'
}

// A refresh that never answers must fail, not hang: the daemon's backend reconnect waits on it, and
// the desktop app never restarts a daemon that is alive — so an unbounded fetch here was a machine
// that stayed "connected" in status and disconnected in fact until someone ran `harness stop`.
const REFRESH_TIMEOUT_MS = 15_000

async function refreshRequest(baseUrl: string, current: AuthSession, timeoutMs = REFRESH_TIMEOUT_MS): Promise<RefreshResult> {
  if (!current.refreshToken) throw new AuthSessionError('No SSO refresh token. Run `harness login`.', 'MISSING')
  let response: Response
  try {
    response = await fetch(`${baseUrl.replace(/\/$/, '')}/api/auth/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: current.refreshToken, autonomousEnv: current.autonomousEnv }),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch {
    throw new AuthSessionError(unavailableMessage(), 'UNAVAILABLE')
  }
  const body = await response.json().catch(() => ({})) as {
    success?: boolean; data?: { token?: unknown; refreshToken?: unknown; expiresIn?: unknown }; error?: { code?: unknown; message?: unknown }
  }
  if (response.status === 401 || body.error?.code === 'REFRESH_TOKEN_INVALID') {
    throw new AuthSessionError('SSO refresh token is invalid. Run `harness login`.', 'INVALID_REFRESH')
  }
  if (!response.ok || body.success === false || typeof body.data?.token !== 'string' || !body.data.token) {
    throw new AuthSessionError(
      unavailableMessage(typeof body.error?.message === 'string' && body.error.message ? body.error.message : undefined),
      'UNAVAILABLE',
    )
  }
  return {
    token: body.data.token,
    ...(typeof body.data.refreshToken === 'string' && body.data.refreshToken ? { refreshToken: body.data.refreshToken } : {}),
    ...(typeof body.data.expiresIn === 'number' && body.data.expiresIn > 0 ? { expiresIn: body.data.expiresIn } : {}),
  }
}

/** One in-process refresh plus a file lock for daemon/command races. */
export class AuthSessionManager {
  private refreshInFlight: Promise<string> | null = null
  constructor(
    private readonly backendBaseUrl: string,
    private readonly opts: { refreshTimeoutMs?: number } = {},
  ) {}

  session(): AuthSession | null { return readAuthSession() }

  async accessToken(opts: { force?: boolean; failedToken?: string } = {}): Promise<string> {
    const current = readAuthSession()
    if (!current) throw new AuthSessionError('Not signed in. Run `harness login`.', 'MISSING')
    // A self-hosted machine key does not expire and is not an SSO refresh token. Refreshing it
    // would call the Autonomous token endpoint. The key in the session file is the credential.
    if (env.HARNESS_SELF_HOSTED) return current.accessToken
    if (opts.failedToken && current.accessToken !== opts.failedToken) return current.accessToken
    const needsRefresh = opts.force === true || (current.expiresAt != null && current.expiresAt <= Date.now() + REFRESH_SKEW_MS)
    if (!needsRefresh) return current.accessToken
    if (this.refreshInFlight) return this.refreshInFlight
    const running = withLock(async () => {
      const latest = readAuthSession()
      if (!latest) throw new AuthSessionError('Not signed in. Run `harness login`.', 'MISSING')
      if (opts.failedToken && latest.accessToken !== opts.failedToken) return latest.accessToken
      const stillNeedsRefresh = opts.force === true || (latest.expiresAt != null && latest.expiresAt <= Date.now() + REFRESH_SKEW_MS)
      if (!stillNeedsRefresh) return latest.accessToken
      try {
        const refreshed = await refreshRequest(this.backendBaseUrl, latest, this.opts.refreshTimeoutMs)
        const next: AuthSession = {
          ...latest,
          accessToken: refreshed.token,
          ...(refreshed.refreshToken ? { refreshToken: refreshed.refreshToken } : {}),
          ...(refreshed.expiresIn ? { expiresAt: Date.now() + refreshed.expiresIn * 1000 } : {}),
          updatedAt: Date.now(),
        }
        writeAuthSession(next)
        return next.accessToken
      } catch (err) {
        if (err instanceof AuthSessionError && err.code === 'INVALID_REFRESH') clearAuthSession()
        throw err
      }
    })
    this.refreshInFlight = running
    try { return await running } finally { if (this.refreshInFlight === running) this.refreshInFlight = null }
  }

  updateMachineId(machineId: string): void {
    const current = readAuthSession()
    if (!current || current.machineId === machineId) return
    writeAuthSession({ ...current, machineId, updatedAt: Date.now() })
  }
}
