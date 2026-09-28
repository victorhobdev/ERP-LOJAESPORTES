import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex')
}

export function createSessionSecrets() {
  const token = randomBytes(32).toString('base64url')
  const csrfToken = randomBytes(32).toString('base64url')

  return {
    token,
    csrfToken,
    tokenHash: hashSecret(token),
    csrfHash: hashSecret(csrfToken),
  }
}

export function verifySecret(secret: string, expectedHash: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(expectedHash)) return false

  const actual = Buffer.from(hashSecret(secret), 'hex')
  const expected = Buffer.from(expectedHash, 'hex')
  return timingSafeEqual(actual, expected)
}
