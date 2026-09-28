import { describe, expect, it } from 'vitest'

import { hashPassword, verifyPassword } from './password.js'

describe('password hashing', () => {
  it('uses a random salt and verifies only the matching password', async () => {
    const first = await hashPassword('uma senha longa e válida')
    const second = await hashPassword('uma senha longa e válida')

    expect(first).not.toBe(second)
    await expect(verifyPassword('uma senha longa e válida', first)).resolves.toBe(true)
    await expect(verifyPassword('senha errada', first)).resolves.toBe(false)
  })
})
