import { afterEach, describe, expect, it } from 'vitest'

import { buildApp } from './app.js'

describe('API foundation', () => {
  const apps: Array<ReturnType<typeof buildApp>> = []

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()))
  })

  it('exposes a versioned health response and request id', async () => {
    const app = buildApp({ logger: false })
    apps.push(app)

    const response = await app.inject({ method: 'GET', url: '/health' })

    expect(response.statusCode).toBe(200)
    expect(response.headers['x-request-id']).toBeTruthy()
    expect(response.json()).toEqual({ status: 'ok', service: 'erp-api' })
  })

  it('does not expose stack traces for unknown routes', async () => {
    const app = buildApp({ logger: false })
    apps.push(app)

    const response = await app.inject({ method: 'GET', url: '/does-not-exist' })

    expect(response.statusCode).toBe(404)
    expect(response.json()).toMatchObject({ code: 'NOT_FOUND' })
    expect(response.body).not.toContain('stack')
  })

  it('sets restrictive browser security headers', async () => {
    const app = buildApp({ logger: false })
    apps.push(app)

    const response = await app.inject({ method: 'GET', url: '/health' })

    expect(response.headers['content-security-policy']).toContain("default-src 'self'")
    expect(response.headers['content-security-policy']).not.toContain("'unsafe-eval'")
    expect(response.headers['x-frame-options']).toBe('SAMEORIGIN')
    expect(response.headers['x-content-type-options']).toBe('nosniff')
  })

  it('allows only explicitly configured cross-origin callers', async () => {
    const app = buildApp({ logger: false, allowedOrigins: ['https://erp.local'] })
    apps.push(app)

    const allowed = await app.inject({ method: 'GET', url: '/health', headers: { origin: 'https://erp.local' } })
    const denied = await app.inject({ method: 'GET', url: '/health', headers: { origin: 'https://evil.invalid' } })

    expect(allowed.headers['access-control-allow-origin']).toBe('https://erp.local')
    expect(denied.headers['access-control-allow-origin']).toBeUndefined()
  })

  it('maps rate-limit failures without exposing internals', async () => {
    const app = buildApp({ logger: false })
    apps.push(app)
    app.get('/limited', async () => {
      throw Object.assign(new Error('internal limiter detail'), { statusCode: 429 })
    })

    const response = await app.inject({ method: 'GET', url: '/limited' })

    expect(response.statusCode).toBe(429)
    expect(response.json()).toMatchObject({ code: 'RATE_LIMITED' })
    expect(response.body).not.toContain('internal limiter detail')
  })

  it('maps unexpected failures to a generic request-scoped error', async () => {
    const app = buildApp({ logger: false })
    apps.push(app)
    app.get('/failure', async () => {
      throw new Error('sensitive internal detail')
    })

    const response = await app.inject({ method: 'GET', url: '/failure' })

    expect(response.statusCode).toBe(500)
    expect(response.json()).toMatchObject({ code: 'INTERNAL_ERROR', requestId: expect.any(String) })
    expect(response.body).not.toContain('sensitive internal detail')
  })
})
