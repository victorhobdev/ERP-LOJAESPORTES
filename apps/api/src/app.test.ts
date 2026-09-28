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

  it('reports not-ready without a pool and without leaking internals', async () => {
    const previous = process.env['APP_VERSION']
    delete process.env['APP_VERSION']
    try {
      const app = buildApp({ logger: false })
      apps.push(app)

      const response = await app.inject({ method: 'GET', url: '/health/ready' })

      expect(response.statusCode).toBe(503)
      expect(response.headers['x-request-id']).toBeTruthy()
      expect(response.json()).toEqual({
        status: 'not_ready',
        service: 'erp-api',
        version: '0.0.0',
        checks: { database: 'unconfigured' },
        integrations: { catalog: 'not_configured' },
      })
      expect(response.body).not.toContain('SELECT')
    } finally {
      if (previous === undefined) delete process.env['APP_VERSION']
      else process.env['APP_VERSION'] = previous
    }
  })

  it('reports ready with a healthy pool regardless of catalog flag', async () => {
    const previousFlag = process.env['CATALOG_SYNC_ENABLED']
    delete process.env['CATALOG_SYNC_ENABLED']
    try {
      const healthy = buildApp({ logger: false, pool: { query: async () => ({ rows: [] }) } as never })
      apps.push(healthy)
      const ready = await healthy.inject({ method: 'GET', url: '/health/ready' })
      expect(ready.statusCode).toBe(200)
      expect(ready.json()).toMatchObject({ status: 'ready', checks: { database: 'up' }, integrations: { catalog: 'not_configured' } })
    } finally {
      if (previousFlag === undefined) delete process.env['CATALOG_SYNC_ENABLED']
      else process.env['CATALOG_SYNC_ENABLED'] = previousFlag
    }

    const previous = process.env['CATALOG_SYNC_ENABLED']
    process.env['CATALOG_SYNC_ENABLED'] = 'true'
    try {
      const configured = buildApp({ logger: false, pool: { query: async () => ({ rows: [] }) } as never })
      apps.push(configured)
      const ready = await configured.inject({ method: 'GET', url: '/health/ready' })
      expect(ready.statusCode).toBe(200)
      expect(ready.json()).toMatchObject({ status: 'ready', checks: { database: 'up' }, integrations: { catalog: 'configured' } })
    } finally {
      if (previous === undefined) delete process.env['CATALOG_SYNC_ENABLED']
      else process.env['CATALOG_SYNC_ENABLED'] = previous
    }
  })

  it('sanitizes arbitrary APP_VERSION values', async () => {
    const previous = process.env['APP_VERSION']
    try {
      for (const invalid of ['not a version!!', '1.2.3.4.5.6.7.8.9.10.11.12.13', '../secret', '']) {
        process.env['APP_VERSION'] = invalid
        const app = buildApp({ logger: false })
        apps.push(app)
        const response = await app.inject({ method: 'GET', url: '/health/ready' })
        expect(response.json()).toMatchObject({ version: '0.0.0' })
        if (invalid !== '') expect(response.body).not.toContain(invalid)
      }
      process.env['APP_VERSION'] = '2.4.1-rc.1+build.7'
      const app = buildApp({ logger: false })
      apps.push(app)
      const response = await app.inject({ method: 'GET', url: '/health/ready' })
      expect(response.json()).toMatchObject({ version: '2.4.1-rc.1+build.7' })
    } finally {
      if (previous === undefined) delete process.env['APP_VERSION']
      else process.env['APP_VERSION'] = previous
    }
  })

  it('sanitizes pool failures on readiness', async () => {
    const app = buildApp({
      logger: false,
      pool: { query: async () => { throw new Error('postgres://secret-connection-detail') } } as never,
    })
    apps.push(app)

    const response = await app.inject({ method: 'GET', url: '/health/ready' })

    expect(response.statusCode).toBe(503)
    expect(response.json()).toMatchObject({ status: 'not_ready', checks: { database: 'down' } })
    expect(response.body).not.toContain('postgres://')
    expect(response.body).not.toContain('secret-connection-detail')
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
