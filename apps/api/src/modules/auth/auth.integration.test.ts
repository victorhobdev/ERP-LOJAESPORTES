import { randomUUID } from 'node:crypto'

import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { buildApp } from '../../app.js'
import { hashPassword } from '../../shared/auth/password.js'
import { hashSecret } from '../../shared/auth/session.js'
import { applyMigrations } from '../../shared/db/migrate.js'

const connectionString = process.env['TEST_DATABASE_URL']
if (!connectionString) throw new Error('TEST_DATABASE_URL is required for PostgreSQL integration tests.')

describe('authentication HTTP flow', () => {
  const adminPool = new Pool({ connectionString, max: 1 })
  const schema = `erp2_test_${randomUUID().replaceAll('-', '')}`
  let pool: Pool
  let app: ReturnType<typeof buildApp>

  beforeAll(async () => {
    const current = await adminPool.query<{ current_database: string }>('SELECT current_database()')
    if (current.rows[0]?.current_database !== 'erp2_test') {
      throw new Error('Integration tests refuse to run outside the dedicated erp2_test database.')
    }
    await adminPool.query(`CREATE SCHEMA "${schema}"`)
    pool = new Pool({ connectionString, max: 4, options: `-c search_path=${schema}` })
    await applyMigrations(pool)
    await pool.query(
      `INSERT INTO users (id, username, display_name, password_hash, role_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        randomUUID(),
        'gestor.teste',
        'Gestor de Teste',
        await hashPassword('senha local segura'),
        '00000000-0000-4000-8000-000000000003',
      ],
    )
    app = buildApp({ pool, logger: false, secureCookies: false })
    await app.ready()
  }, 30_000)

  afterAll(async () => {
    await app?.close()
    await pool?.end()
    if (schema.startsWith('erp2_test_')) await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`)
    await adminPool.end()
  })

  it('rejects invalid credentials without revealing which field failed', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { username: 'gestor.teste', password: 'senha incorreta' },
    })

    expect(response.statusCode).toBe(401)
    expect(response.json()).toMatchObject({ code: 'INVALID_CREDENTIALS' })
    expect(response.body).not.toContain('username')
    expect(response.headers['set-cookie']).toBeUndefined()
  })

  it('creates an opaque session, enforces CSRF, returns RBAC and invalidates logout', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { username: 'gestor.teste', password: 'senha local segura' },
    })

    expect(login.statusCode).toBe(200)
    const setCookies = asArray(login.headers['set-cookie'])
    const sessionCookie = requiredCookie(setCookies, 'erp_session')
    const csrfCookie = requiredCookie(setCookies, 'erp_csrf')
    expect(setCookies.find((value) => value.startsWith('erp_session='))).toContain('HttpOnly')
    expect(setCookies.every((value) => value.includes('SameSite=Strict'))).toBe(true)

    const stored = await pool.query<{ token_hash: string }>('SELECT token_hash FROM sessions')
    const rawSessionToken = cookieValue(sessionCookie)
    expect(stored.rows[0]?.token_hash).toBe(hashSecret(rawSessionToken))
    expect(stored.rows[0]?.token_hash).not.toBe(rawSessionToken)

    const cookie = `${sessionCookie}; ${csrfCookie}`
    const session = await app.inject({ method: 'GET', url: '/auth/session', headers: { cookie } })
    expect(session.statusCode).toBe(200)
    expect(session.json()).toMatchObject({
      user: { username: 'gestor.teste', role: 'manager' },
      permissions: expect.arrayContaining(['reports:read', 'sales:payment']),
    })

    const rejectedLogout = await app.inject({ method: 'POST', url: '/auth/logout', headers: { cookie } })
    expect(rejectedLogout.statusCode).toBe(403)
    expect(rejectedLogout.json()).toMatchObject({ code: 'INVALID_CSRF' })

    const logout = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: { cookie, 'x-csrf-token': cookieValue(csrfCookie) },
    })
    expect(logout.statusCode).toBe(204)
    const remaining = await pool.query<{ count: string }>('SELECT count(*) FROM sessions')
    expect(remaining.rows[0]?.count).toBe('0')
  })
})

function asArray(value: string | string[] | undefined): string[] {
  if (!value) return []
  return Array.isArray(value) ? value : [value]
}

function requiredCookie(values: string[], name: string): string {
  const cookie = values.find((value) => value.startsWith(`${name}=`))?.split(';')[0]
  if (!cookie) throw new Error(`Expected ${name} cookie.`)
  return cookie
}

function cookieValue(cookie: string): string {
  return decodeURIComponent(cookie.slice(cookie.indexOf('=') + 1))
}
