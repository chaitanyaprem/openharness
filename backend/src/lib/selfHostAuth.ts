/**
 * Self-hosted enrollment. One user, many machines. The credential a daemon dials with
 * is one user token stored on the user row. It is not a machine api key: web-ws pins a
 * 64-hex key to a single machine, and linking has to select the other one.
 * The relay never learns an E2EE private key, and this module does not implement framing or PAKE.
 */
import { randomBytes } from 'crypto'
import { env } from '../config/env.js'
import { prisma } from './prisma.js'
import { normalizeComputerId } from './deviceAuth.js'
import { userService } from '../services/UserService.js'
import { machineService } from '../services/MachineService.js'
import { allowlistHas, decodePubkey, enrollMessage, takeChallenge, tokenMatches, verifyEd25519 } from './selfHostProof.js'

export const SELF_HOST_EMAIL = 'self-hosted@localhost'
export const SELF_HOST_SUBJECT = 'self-hosted'
const TOKEN_PREFIX = 'selfhost:'

/** A 64-hex string is a machine api key and takes the legacy one-machine socket path. The user
 *  token must not look like one, or `link connect` could never select the other machine. */
function newUserToken(): string {
  return randomBytes(32).toString('base64url')
}

export interface SelfHostUser {
  sub: string
  email: string
  role: string
  autonomousEnv: 'prod'
}

/** The daemon's bearer token is one user token, shared by every machine on this relay.
 *  A machine api key must not be accepted here: web-ws treats a 64-hex key as a single machine. */
export async function selfHostUserForToken(token: string): Promise<SelfHostUser | null> {
  if (!env.HARNESS_SELF_HOSTED || !token || /^[a-f0-9]{64}$/i.test(token)) return null
  const user = await prisma.user.findFirst({ where: { passwordHash: TOKEN_PREFIX + token } })
  if (!user) return null
  return { sub: user.id, email: user.email, role: user.role, autonomousEnv: 'prod' }
}

async function userToken(userId: string): Promise<string> {
  return prisma.$transaction(async (tx) => {
    const row = await tx.user.findUnique({ where: { id: userId } })
    if (!row) throw Object.assign(new Error('self-hosted user disappeared'), { statusCode: 500 })
    if (row.passwordHash?.startsWith(TOKEN_PREFIX)) return row.passwordHash.slice(TOKEN_PREFIX.length)
    const token = newUserToken()
    await tx.user.update({ where: { id: userId }, data: { passwordHash: TOKEN_PREFIX + token } })
    return token
  })
}

export interface EnrollInput {
  computerId: string
  pubkey: string
  label?: string
  nonce: string
  signature: string
  enrollmentToken?: string
}

export async function enrollSelfHostedMachine(input: EnrollInput): Promise<{ accessToken: string; machineId: string; computerId: string }> {
  if (!env.HARNESS_SELF_HOSTED) throw Object.assign(new Error('self-hosted mode is off'), { statusCode: 404 })
  const computerId = normalizeComputerId(input.computerId)
  if (!computerId) throw Object.assign(new Error('Invalid computer id'), { statusCode: 400 })
  const pub = decodePubkey(input.pubkey)
  const sig = Buffer.from(input.signature, 'base64')
  if (!pub || !takeChallenge(input.nonce) || !verifyEd25519(pub, enrollMessage(input.nonce, input.computerId, input.pubkey), sig)) {
    throw Object.assign(new Error('Enrollment proof was rejected'), { statusCode: 401 })
  }
  const byToken = tokenMatches(input.enrollmentToken, env.HARNESS_ENROLLMENT_TOKEN)
  const byKey = allowlistHas(pub, env.HARNESS_PUBKEY_ALLOWLIST)
  if (!byToken && !byKey) {
    throw Object.assign(new Error('This machine is not allowed to enroll'), { statusCode: 403 })
  }
  const user = await userService.upsertFromSso({
    externalId: SELF_HOST_SUBJECT,
    email: SELF_HOST_EMAIL,
    autonomousEnv: 'prod',
    name: 'Self-hosted',
  })
  const resolved = await machineService.resolveOrCreateForComputer(user.id, 'prod', computerId, input.label?.trim() || 'computer')
  return { accessToken: await userToken(user.id), machineId: resolved.machine.machineId, computerId }
}
