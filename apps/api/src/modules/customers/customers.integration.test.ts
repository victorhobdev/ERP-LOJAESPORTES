import { randomUUID } from 'node:crypto'

import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { buildApp } from '../../app.js'
import { hashSecret } from '../../shared/auth/session.js'
import { applyMigrations } from '../../shared/db/migrate.js'

const connectionString = process.env['TEST_DATABASE_URL']
if (!connectionString) throw new Error('TEST_DATABASE_URL is required for PostgreSQL integration tests.')

describe('customers HTTP flow', () => {
  const adminPool = new Pool({ connectionString, max: 1 })
  const schema = `erp2_test_${randomUUID().replaceAll('-', '')}`
  const sellerToken = randomUUID()
  const sellerCsrf = randomUUID()
  const sellerId = randomUUID()
  const stockToken = randomUUID()
  const stockCsrf = randomUUID()
  const stockId = randomUUID()
  let pool: Pool
  let app: ReturnType<typeof buildApp>

  beforeAll(async () => {
    const current = await adminPool.query<{ current_database: string }>('SELECT current_database()')
    if (current.rows[0]?.current_database !== 'erp2_test') {
      throw new Error('Integration tests refuse to run outside the dedicated erp2_test database.')
    }
    await adminPool.query(`CREATE SCHEMA "${schema}"`)
    pool = new Pool({ connectionString, max: 8, options: `-c search_path=${schema}` })
    await applyMigrations(pool)
    await pool.query(
      `INSERT INTO users (id, username, display_name, password_hash, role_id)
       VALUES ($1, 'vendedor.cliente', 'Vendedor Cliente', 'unused-in-this-test', '00000000-0000-4000-8000-000000000001'),
              ($2, 'estoque.cliente', 'Estoque Cliente', 'unused-in-this-test', '00000000-0000-4000-8000-000000000002')`,
      [sellerId, stockId],
    )
    await pool.query(
      `INSERT INTO sessions (id, user_id, token_hash, csrf_hash, expires_at)
       VALUES ($1, $2, $3, $4, now() + interval '1 hour'),
              ($5, $6, $7, $8, now() + interval '1 hour')`,
      [randomUUID(), sellerId, hashSecret(sellerToken), hashSecret(sellerCsrf), randomUUID(), stockId, hashSecret(stockToken), hashSecret(stockCsrf)],
    )
    app = buildApp({ pool, logger: false, secureCookies: false })
    await app.ready()
  }, 120_000)

  afterAll(async () => {
    await app?.close()
    await pool?.end()
    if (schema.startsWith('erp2_test_')) await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`)
    await adminPool.end()
  })

  it('requires authentication and customer permissions', async () => {
    expect((await app.inject({ method: 'GET', url: '/customers' })).statusCode).toBe(401)

    const reader = await app.inject({ method: 'GET', url: '/customers', headers: { cookie: sellerCookie() } })
    expect(reader.statusCode).toBe(200)

    const deniedRead = await app.inject({ method: 'GET', url: '/customers', headers: { cookie: stockCookie() } })
    expect(deniedRead.statusCode).toBe(403)

    const deniedWrite = await app.inject({
      method: 'POST', url: '/customers', payload: { name: 'X' }, headers: stockHeaders(),
    })
    expect(deniedWrite.statusCode).toBe(403)

    const badCsrf = await app.inject({
      method: 'POST', url: '/customers', payload: { name: 'X' },
      headers: { cookie: sellerCookie(), 'x-csrf-token': 'invalido' },
    })
    expect(badCsrf.statusCode).toBe(403)
    expect(badCsrf.json()).toMatchObject({ code: 'INVALID_CSRF' })
  })

  it('creates a customer idempotently with audit and validates input', async () => {
    const key = randomUUID()
    const payload = { name: 'Cliente Sintetico', contact: 'contato' }
    const first = await app.inject({ method: 'POST', url: '/customers', payload, headers: { ...sellerHeaders(), 'idempotency-key': key } })
    const repeated = await app.inject({ method: 'POST', url: '/customers', payload, headers: { ...sellerHeaders(), 'idempotency-key': key } })
    expect(first.statusCode).toBe(201)
    expect(repeated.json()).toEqual(first.json())
    expect(first.json()).toMatchObject({ name: 'Cliente Sintetico', contact: 'contato' })

    const changed = await app.inject({
      method: 'POST', url: '/customers', payload: { ...payload, contact: 'outro' },
      headers: { ...sellerHeaders(), 'idempotency-key': key },
    })
    expect(changed.statusCode).toBe(409)
    expect(changed.json()).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' })

    const empty = await app.inject({
      method: 'POST', url: '/customers', payload: { name: '   ' },
      headers: { ...sellerHeaders(), 'idempotency-key': randomUUID() },
    })
    expect(empty.statusCode).toBe(400)

    const audits = await pool.query<{ count: string }>(
      `SELECT count(*) AS count FROM audit_log WHERE entity_id = $1::text AND action = 'customer.create'`,
      [first.json().id],
    )
    expect(audits.rows[0]?.count).toBe('1')
  })

  it('searches customers with limits', async () => {
    const created = await app.inject({
      method: 'POST', url: '/customers', payload: { name: `Busca ${randomUUID().slice(0, 8)}` },
      headers: { ...sellerHeaders(), 'idempotency-key': randomUUID() },
    })
    expect(created.statusCode).toBe(201)

    const search = await app.inject({
      method: 'GET', url: `/customers?search=${encodeURIComponent((created.json() as { name: string }).name)}`,
      headers: { cookie: sellerCookie() },
    })
    expect(search.json().items.map((item: { id: string }) => item.id)).toContain(created.json().id)

    const limited = await app.inject({ method: 'GET', url: '/customers?limit=1', headers: { cookie: sellerCookie() } })
    expect(limited.json().items.length).toBeLessThanOrEqual(1)

    const badLimit = await app.inject({ method: 'GET', url: '/customers?limit=51', headers: { cookie: sellerCookie() } })
    expect(badLimit.statusCode).toBe(400)
  })

  function sellerHeaders() {
    return { cookie: sellerCookie(), 'x-csrf-token': sellerCsrf }
  }

  function stockHeaders() {
    return { cookie: stockCookie(), 'x-csrf-token': stockCsrf }
  }

  function sellerCookie() {
    return `erp_session=${encodeURIComponent(sellerToken)}; erp_csrf=${encodeURIComponent(sellerCsrf)}`
  }

  function stockCookie() {
    return `erp_session=${encodeURIComponent(stockToken)}; erp_csrf=${encodeURIComponent(stockCsrf)}`
  }
})
