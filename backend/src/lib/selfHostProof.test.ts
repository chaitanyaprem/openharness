import { generateKeyPairSync, sign } from 'crypto'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ed25519 } from '@noble/curves/ed25519.js'
import { describe, expect, it } from 'vitest'
import { allowlistHas, decodePubkey, enrollMessage, issueChallenge, takeChallenge, tokenMatches, verifyEd25519 } from './selfHostProof.js'

function rawPublic(derOrSpki: Buffer): Buffer {
  return derOrSpki.subarray(-32)
}

describe('self-host enrollment proof', () => {
  it('accepts a Node ed25519 signature and a noble one, and rejects a tampered message', () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    const pub = rawPublic(publicKey.export({ format: 'der', type: 'spki' }) as Buffer)
    const message = enrollMessage('nonce', 'computer', pub.toString('base64'))
    const signature = sign(null, message, privateKey)
    expect(verifyEd25519(pub, message, signature)).toBe(true)
    expect(verifyEd25519(pub, Buffer.from('other'), signature)).toBe(false)

    const secret = ed25519.utils.randomSecretKey()
    const noblePub = Buffer.from(ed25519.getPublicKey(secret))
    const nobleSig = Buffer.from(ed25519.sign(message, secret))
    expect(verifyEd25519(noblePub, message, nobleSig)).toBe(true)
  })

  it('uses a challenge once', () => {
    const nonce = issueChallenge()
    expect(takeChallenge(nonce)).toBe(true)
    expect(takeChallenge(nonce)).toBe(false)
  })

  it('compares the enrollment token without accepting a different length', () => {
    expect(tokenMatches('root-secret', 'root-secret')).toBe(true)
    expect(tokenMatches('root-secret', 'root-secreT')).toBe(false)
    expect(tokenMatches('short', 'root-secret')).toBe(false)
    expect(tokenMatches(undefined, 'root-secret')).toBe(false)
  })

  it('reads base64 and hex pubkeys from an allowlist', () => {
    const secret = ed25519.utils.randomSecretKey()
    const pub = Buffer.from(ed25519.getPublicKey(secret))
    const dir = mkdtempSync(join(tmpdir(), 'harness-allow-'))
    const path = join(dir, 'allow')
    writeFileSync(path, `# comment\n${pub.toString('hex')}\n`)
    expect(allowlistHas(pub, path)).toBe(true)
    expect(allowlistHas(Buffer.alloc(32, 1), path)).toBe(false)
    expect(decodePubkey(pub.toString('base64'))?.equals(pub)).toBe(true)
  })

  it('builds the enroll message the CLI signs', () => {
    expect(enrollMessage('n', 'computer', 'pub').toString()).toBe('harness-self-host-enroll\nn\ncomputer\npub')
  })
})
