import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { applySelfHostEnv, toBackendWsUrl } from './selfHost.js'

describe('self-host config', () => {
  it('leaves the environment alone when nothing is configured', () => {
    const env: NodeJS.ProcessEnv = { NODE_ENV: 'test' }
    applySelfHostEnv(env, '/no/such/home')
    expect(env.BACKEND_WS_URL).toBeUndefined()
    expect(env.HARNESS_SELF_HOSTED).toBeUndefined()
    expect(env.DISABLE_GRID_INSTALL).toBeUndefined()
  })

  it('points the daemon at the configured relay and turns egress off', () => {
    const home = mkdtempSync(join(tmpdir(), 'harness-self-host-'))
    writeFileSync(join(home, 'self-host.json'), JSON.stringify({
      selfHosted: true,
      backendUrl: 'http://10.0.0.8:8085',
      enrollmentToken: 'root-secret',
    }))
    const env: NodeJS.ProcessEnv = { NODE_ENV: 'test', HARNESS_CONFIG: join(home, 'self-host.json') }
    applySelfHostEnv(env, home)
    expect(env.BACKEND_WS_URL).toBe('ws://10.0.0.8:8085')
    expect(env.HARNESS_SELF_HOSTED).toBe('true')
    expect(env.HARNESS_ENROLLMENT_TOKEN).toBe('root-secret')
    expect(env.DISABLE_GRID_INSTALL).toBe('true')
    expect(env.ADAPTER_UPDATE_DISABLE).toBe('true')
    expect(env.HARNESS_ANALYTICS_DISABLED).toBe('true')
    expect(env.HARNESS_STORE_OFFLINE).toBe('true')
    expect(env.CABLE_FW_DISABLE).toBe('true')
  })

  it('does not override an explicit backend URL or an explicit egress switch', () => {
    const env: NodeJS.ProcessEnv = {
      NODE_ENV: 'test',
      HARNESS_SELF_HOSTED: 'true',
      HARNESS_BACKEND_URL: 'https://relay.example',
      BACKEND_WS_URL: 'wss://already.example',
      DISABLE_GRID_INSTALL: 'false',
    }
    applySelfHostEnv(env, '/no/such/home')
    expect(env.BACKEND_WS_URL).toBe('wss://already.example')
    expect(env.DISABLE_GRID_INSTALL).toBe('false')
  })

  it('rejects a backend URL that is not http or ws', () => {
    expect(() => toBackendWsUrl('relay.example:8085')).toThrow(/http/)
  })
})
