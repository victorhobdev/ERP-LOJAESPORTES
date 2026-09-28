import { describe, expect, it } from 'vitest'

import { createSessionSecrets, hashSecret, verifySecret } from './session.js'

describe('session secrets', () => {
  it('creates opaque independent session and CSRF values stored only as hashes', () => {
    const first = createSessionSecrets()
    const second = createSessionSecrets()

    expect(first.token).not.toBe(second.token)
    expect(first.csrfToken).not.toBe(first.token)
    expect(first.tokenHash).toBe(hashSecret(first.token))
    expect(first.csrfHash).toBe(hashSecret(first.csrfToken))
    expect(first.tokenHash).toMatch(/^[a-f0-9]{64}$/)
  })

  it('compares secrets without accepting malformed input', () => {
    const value = 'csrf-value'
    const hash = hashSecret(value)

    expect(verifySecret(value, hash)).toBe(true)
    expect(verifySecret('wrong', hash)).toBe(false)
    expect(verifySecret(value, 'not-a-hash')).toBe(false)
  })
})
