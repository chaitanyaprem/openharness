/**
 * Enroll this computer with a self-hosted control plane and store the machine key
 * in the same session file a signed-in daemon already reads.
 *
 * The relay then sees this key as the WebSocket credential. Frames after the
 * handshake stay on the existing E2EE path; this file does not touch that code.
 */
import { hostname } from 'os'
import { env } from '../config/env.js'
import { readOrMintComputerId } from './computerIdentity.js'
import { readAuthSession, writeAuthSession, type AuthSession } from './authSession.js'
import { E2eeStore } from './e2ee/store.js'
import { b64e, sign } from './e2ee/core.js'

export function backendHttpBase(): string {
  return env.BACKEND_WS_URL.replace(/\/$/, '').replace(/^wss:/, 'https:').replace(/^ws:/, 'http:')
}

/** The relay answered, and said no. `status` is its HTTP status: 403 means this computer is not
 *  allowed to enroll at all (no valid token, key not on the allowlist). */
export class SelfHostEnrollError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
    this.name = 'SelfHostEnrollError'
  }
}

export function enrollMessage(nonce: string, computerId: string, pubkey: string): Uint8Array {
  return new TextEncoder().encode(`harness-self-host-enroll\n${nonce}\n${computerId}\n${pubkey}`)
}

export async function enrollSelfHosted(opts: { force?: boolean; fetchImpl?: typeof fetch } = {}): Promise<AuthSession> {
  // Only a session this relay issued comes back here (readAuthSession checks `relay`). A sign-in
  // from the upstream relay, or an enrollment with another self-hosted one, is replaced.
  const existing = readAuthSession()
  if (existing && !opts.force) return existing
  const fetchImpl = opts.fetchImpl ?? fetch
  const base = backendHttpBase()
  const store = new E2eeStore()
  const identity = store.init()
  const computerId = readOrMintComputerId(env.ADAPTER_COMPUTER_ID_FILE, env.ADAPTER_COMPUTER_ID)
  const pubkey = b64e(identity.pub)
  const challengeRes = await fetchImpl(`${base}/api/self-host/challenge`)
  if (!challengeRes.ok) {
    throw new SelfHostEnrollError(`self-hosted relay refused a challenge (${challengeRes.status}). Is HARNESS_SELF_HOSTED set on the backend?`, challengeRes.status)
  }
  const challenge = await challengeRes.json() as { data?: { nonce?: string } }
  const nonce = challenge.data?.nonce
  if (!nonce) throw new Error('self-hosted relay returned no challenge')
  const signature = b64e(sign(identity.priv, enrollMessage(nonce, computerId, pubkey)))
  const res = await fetchImpl(`${base}/api/self-host/enroll`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      computerId,
      pubkey,
      label: hostname(),
      nonce,
      signature,
      ...(env.HARNESS_ENROLLMENT_TOKEN ? { enrollmentToken: env.HARNESS_ENROLLMENT_TOKEN } : {}),
    }),
  })
  const body = await res.json().catch(() => null) as { success?: boolean; data?: { accessToken?: string; machineId?: string }; error?: { message?: string } } | null
  if (!res.ok || !body?.success || !body.data?.accessToken || !body.data.machineId) {
    const message = body?.error?.message || `enrollment failed (${res.status})`
    throw new SelfHostEnrollError(message, res.status)
  }
  const session: AuthSession = {
    version: 1,
    accessToken: body.data.accessToken,
    autonomousEnv: 'prod',
    computerId,
    machineId: body.data.machineId,
    updatedAt: Date.now(),
    relay: env.BACKEND_WS_URL,
  }
  writeAuthSession(session)
  return session
}
