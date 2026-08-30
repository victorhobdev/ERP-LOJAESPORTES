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
})
