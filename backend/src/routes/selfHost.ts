import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { env } from '../config/env.js'
import { enrollSelfHostedMachine } from '../lib/selfHostAuth.js'
import { issueChallenge } from '../lib/selfHostProof.js'
import { sendError, sendSuccess } from '../utils/response.js'

const enrollBody = z.object({
  computerId: z.string().min(1).max(80),
  pubkey: z.string().min(1).max(200),
  label: z.string().max(120).optional(),
  nonce: z.string().min(1).max(200),
  signature: z.string().min(1).max(200),
  enrollmentToken: z.string().max(500).optional(),
})

export async function selfHostRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/self-host/challenge', async (_req, reply) => {
    if (!env.HARNESS_SELF_HOSTED) return sendError(reply, 'Not found', 'NOT_FOUND', 404)
    return sendSuccess(reply, { nonce: issueChallenge() })
  })

  app.post('/api/self-host/enroll', async (req, reply) => {
    if (!env.HARNESS_SELF_HOSTED) return sendError(reply, 'Not found', 'NOT_FOUND', 404)
    const parsed = enrollBody.safeParse(req.body)
    if (!parsed.success) return sendError(reply, 'Invalid enrollment', 'BAD_REQUEST', 400)
    try {
      return sendSuccess(reply, await enrollSelfHostedMachine(parsed.data))
    } catch (err) {
      const status = typeof (err as { statusCode?: number }).statusCode === 'number'
        ? (err as { statusCode: number }).statusCode
        : 500
      const message = err instanceof Error ? err.message : 'enrollment failed'
      const code = status === 401 ? 'UNAUTHORIZED' : status === 403 ? 'FORBIDDEN' : status === 400 ? 'BAD_REQUEST' : 'ENROLL_FAILED'
      return sendError(reply, message, code, status)
    }
  })
}
