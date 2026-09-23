/**
 * One config point for a self-hosted relay. Explicit environment variables win over the file.
 * Unset, with no file, this changes nothing: the CLI keeps dialing the upstream relay.
 *
 * The file is `~/.harness/self-host.json`, or whatever `HARNESS_CONFIG` names.
 * Tests do not read the home file unless `HARNESS_CONFIG` is set, so a developer's
 * own config cannot flip the suite into self-hosted mode.
 */
import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

export interface SelfHostFile {
  selfHosted?: boolean
  backendUrl?: string
  enrollmentToken?: string
}

export function selfHostConfigPath(env: NodeJS.ProcessEnv = process.env, home = homedir()): string | null {
  const explicit = env.HARNESS_CONFIG?.trim()
  if (explicit) return explicit
  if (env.NODE_ENV === 'test') return null
  return join(home, '.harness', 'self-host.json')
}

export function readSelfHostFile(path: string | null): SelfHostFile | null {
  if (!path || !existsSync(path)) return null
  let raw: unknown
  try { raw = JSON.parse(readFileSync(path, 'utf8')) } catch { return null }
  if (!raw || typeof raw !== 'object') return null
  const file = raw as Record<string, unknown>
  return {
    ...(file.selfHosted === true ? { selfHosted: true } : {}),
    ...(typeof file.backendUrl === 'string' && file.backendUrl.trim() ? { backendUrl: file.backendUrl.trim() } : {}),
    ...(typeof file.enrollmentToken === 'string' && file.enrollmentToken.trim() ? { enrollmentToken: file.enrollmentToken.trim() } : {}),
  }
}

/** http(s) or ws(s) base → the URL the daemon dials. Rejects anything else. */
export function toBackendWsUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/$/, '')
  if (/^wss?:\/\//i.test(trimmed)) return trimmed
  if (/^https:\/\//i.test(trimmed)) return 'wss:' + trimmed.slice('https:'.length)
  if (/^http:\/\//i.test(trimmed)) return 'ws:' + trimmed.slice('http:'.length)
  throw new Error(`backend URL must start with http://, https://, ws://, or wss://`)
}

/**
 * Copy the config onto `env` before the CLI schema reads it.
 * A variable that is already set is left alone, so a one-off shell override wins.
 */
export function applySelfHostEnv(env: NodeJS.ProcessEnv = process.env, home = homedir()): void {
  const file = readSelfHostFile(selfHostConfigPath(env, home))
  const selfHosted = env.HARNESS_SELF_HOSTED === 'true' || file?.selfHosted === true
  const backendUrl = env.HARNESS_BACKEND_URL?.trim() || file?.backendUrl
  const enrollmentToken = env.HARNESS_ENROLLMENT_TOKEN?.trim() || file?.enrollmentToken
  if (!selfHosted && !backendUrl) return
  if (backendUrl && !env.BACKEND_WS_URL) env.BACKEND_WS_URL = toBackendWsUrl(backendUrl)
  if (enrollmentToken && !env.HARNESS_ENROLLMENT_TOKEN) env.HARNESS_ENROLLMENT_TOKEN = enrollmentToken
  if (!selfHosted) return
  env.HARNESS_SELF_HOSTED = 'true'
  // These are the non-essential egress switches. Set only when unset, so a test or an operator
  // can turn one back on without leaving self-hosted mode.
  if (!env.DISABLE_GRID_INSTALL) env.DISABLE_GRID_INSTALL = 'true'
  if (!env.ADAPTER_UPDATE_DISABLE) env.ADAPTER_UPDATE_DISABLE = 'true'
  if (!env.HARNESS_ANALYTICS_DISABLED) env.HARNESS_ANALYTICS_DISABLED = 'true'
  if (!env.HARNESS_STORE_OFFLINE) env.HARNESS_STORE_OFFLINE = 'true'
  if (!env.CABLE_FW_DISABLE) env.CABLE_FW_DISABLE = 'true'
}
