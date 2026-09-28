import { describe, expect, it, vi } from 'vitest'

import { registerServiceWorker } from './pwa'

describe('PWA service worker registration', () => {
  it('does not register outside production', () => {
    const register = vi.fn()

    expect(registerServiceWorker({ production: false, serviceWorker: { register } as never })).toBeUndefined()
    expect(register).not.toHaveBeenCalled()
  })

  it('registers the root-scoped worker in production', async () => {
    const registration = { scope: '/' }
    const register = vi.fn().mockResolvedValue(registration)

    await expect(registerServiceWorker({ production: true, serviceWorker: { register } as never })).resolves.toBe(registration)
    expect(register).toHaveBeenCalledWith('/sw.js', { scope: '/' })
  })

  it('tolerates browsers without service worker support', () => {
    expect(registerServiceWorker({ production: true, serviceWorker: undefined })).toBeUndefined()
  })
})
