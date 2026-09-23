/**
 * Enrollment proof: a one-time nonce, an Ed25519 signature over it, and either a
 * shared enrollment token or a pubkey on the allowlist. No database, no relay frames.
 */
import { createPublicKey, randomBytes, timingSafeEqual, verify as cryptoVerify } from 'crypto'
import { existsSync, readFileSync } from 'fs'

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')
const CHALLENGE_TTL_MS = 5 * 60_000
const MAX_CHALLENGES = 1000

const challenges = new Map<string, number>()

export function enrollMessage(nonce: string, computerId: string, pubkey: string): Buffer {
  return Buffer.from(`harness-self-host-enroll\n${nonce}\n${computerId}\n${pubkey}`, 'utf8')
}

export function issueChallenge(now = Date.now()): string {
  const nonce = randomBytes(32).toString('base64url')
  challenges.set(nonce, now + CHALLENGE_TTL_MS)
  if (challenges.size > MAX_CHALLENGES) {
    const oldest = challenges.keys().next().value
    if (oldest) challenges.delete(oldest)
  }
  return nonce
}

/** Single use. A reused or expired nonce is rejected. */
export function takeChallenge(nonce: string, now = Date.now()): boolean {
  const exp = challenges.get(nonce)
  challenges.delete(nonce)
  return exp != null && exp > now
}

export function tokenMatches(presented: string | undefined, expected: string | undefined): boolean {
  if (!presented || !expected) return false
  const a = Buffer.from(presented)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

export function decodePubkey(raw: string): Buffer | null {
  const trimmed = raw.trim()
  if (/^[a-fA-F0-9]{64}$/.test(trimmed)) return Buffer.from(trimmed, 'hex')
  try {
    const buf = Buffer.from(trimmed, 'base64')
    return buf.length === 32 ? buf : null
  } catch {
    return null
  }
}

export function verifyEd25519(pub: Buffer, message: Buffer, signature: Buffer): boolean {
  if (pub.length !== 32 || signature.length !== 64) return false
  try {
    const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, pub]), format: 'der', type: 'spki' })
    return cryptoVerify(null, message, key, signature)
  } catch {
    return false
  }
}

export function allowlistHas(pubkey: Buffer, path: string | undefined): boolean {
  if (!path || !existsSync(path)) return false
  let text = ''
  try { text = readFileSync(path, 'utf8') } catch { return false }
  const want = pubkey.toString('base64')
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const decoded = decodePubkey(trimmed)
    if (decoded && decoded.toString('base64') === want) return true
  }
  return false
}
