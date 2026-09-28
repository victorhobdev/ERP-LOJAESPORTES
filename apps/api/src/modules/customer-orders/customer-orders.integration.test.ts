import { randomUUID } from 'node:crypto'

import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { buildApp } from '../../app.js'
import { hashSecret } from '../../shared/auth/session.js'
import { applyMigrations } from '../../shared/db/migrate.js'

const connectionString = process.env['TEST_DATABASE_URL']
if (!connectionString) throw new Error('TEST_DATABASE_URL is required for PostgreSQL integration tests.')

describe('customer orders HTTP flow', () => {
  const adminPool = new Pool({ connectionString, max: 1 })
  const schema = `erp2_test_${randomUUID().replaceAll('-', '')}`
  const sessionToken = randomUUID()
  const csrfToken = randomUUID()
  const managerId = randomUUID()
  const customerId = randomUUID()
  let pool: Pool
  let app: ReturnType<typeof buildApp>

  beforeAll(async () => {
    const current = await adminPool.query<{ current_database: string }>('SELECT current_database()')
    if (current.rows[0]?.current_database !== 'erp2_test') throw new Error('Integration tests refuse to run outside erp2_test.')
    await adminPool.query(`CREATE SCHEMA "${schema}"`)
    pool = new Pool({ connectionString, max: 6, options: `-c search_path=${schema}` })
    await applyMigrations(pool)
    await pool.query(
      `INSERT INTO users (id, username, display_name, password_hash, role_id)
       VALUES ($1, 'gestor.encomendas', 'Gestor Encomendas', 'unused-in-this-test', $2)`,
      [managerId, '00000000-0000-4000-8000-000000000003'],
    )
    await pool.query('INSERT INTO customers (id, name, contact) VALUES ($1, $2, $3)', [customerId, 'Cliente Encomenda', 'fixture'])
    await pool.query(
      `INSERT INTO sessions (id, user_id, token_hash, csrf_hash, expires_at)
       VALUES ($1, $2, $3, $4, now() + interval '1 hour')`,
      [randomUUID(), managerId, hashSecret(sessionToken), hashSecret(csrfToken)],
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

  it('requires authentication for customer order creation', async () => {
    const response = await app.inject({ method: 'POST', url: '/customer-orders', payload: {} })
    expect(response.statusCode).toBe(401)
    expect(response.json()).toMatchObject({ code: 'UNAUTHENTICATED' })
  })

  it('creates a free-description order and preserves every valid status transition', async () => {
    const key = randomUUID()
    const payload = {
      customerId,
      club: 'Flamengo',
      model: 'Modelo sob encomenda',
      type: 'Masculina',
      size: 'M',
      notes: 'Fixture sem variante associada',
    }
    const created = await postOrder(key, payload)
    const replay = await postOrder(key, payload)
    expect(created.statusCode).toBe(201)
    expect(replay.json()).toEqual(created.json())
    expect(created.json()).toMatchObject({ status: 'pending', variantId: null, linkedPurchaseOrderId: null })
    const changedCreate = await postOrder(key, { ...payload, notes: 'Outro conteúdo' })
    expect(changedCreate.statusCode).toBe(409)
    expect(changedCreate.json()).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' })

    const invalid = await patchStatus(created.json().id, randomUUID(), { status: 'delivered' })
    expect(invalid.statusCode).toBe(409)
    expect(invalid.json()).toMatchObject({ code: 'INVALID_STATUS_TRANSITION' })

    const supplierKey = randomUUID()
    const supplierOrdered = await patchStatus(created.json().id, supplierKey, { status: 'supplier_ordered' })
    const supplierReplay = await patchStatus(created.json().id, supplierKey, { status: 'supplier_ordered' })
    expect(supplierOrdered.statusCode).toBe(200)
    expect(supplierReplay.json()).toEqual(supplierOrdered.json())
    const changedStatus = await patchStatus(created.json().id, supplierKey, { status: 'product_arrived' })
    expect(changedStatus.statusCode).toBe(409)
    expect(changedStatus.json()).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' })

    for (const status of ['product_arrived', 'delivered']) {
      const response = await patchStatus(created.json().id, randomUUID(), { status })
      expect(response.statusCode).toBe(200)
      expect(response.json()).toMatchObject({ status })
    }

    const detail = await app.inject({ method: 'GET', url: `/customer-orders/${created.json().id}`, headers: { cookie: authCookie() } })
    expect(detail.statusCode).toBe(200)
    expect(detail.json()).toMatchObject({ id: created.json().id, status: 'delivered' })
    expect(detail.json().timeline.map((event: { toStatus: string }) => event.toStatus)).toEqual([
      'pending', 'supplier_ordered', 'product_arrived', 'delivered',
    ])
    const list = await app.inject({ method: 'GET', url: '/customer-orders?status=delivered', headers: { cookie: authCookie() } })
    expect(list.statusCode).toBe(200)
    expect(list.json().items).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: created.json().id, status: 'delivered', customerName: 'Cliente Encomenda' }),
    ]))
    const unfiltered = await app.inject({ method: 'GET', url: '/customer-orders', headers: { cookie: authCookie() } })
    expect(unfiltered.statusCode).toBe(200)
    expect(unfiltered.json().items.length).toBeGreaterThan(0)
    const sideEffects = await pool.query<{ purchases: string; movements: string; audits: string }>(
      `SELECT
         (SELECT count(*) FROM purchase_orders) AS purchases,
         (SELECT count(*) FROM inventory_movements) AS movements,
         (SELECT count(*) FROM audit_log WHERE entity_id = $1::text AND action LIKE 'customer_order.%') AS audits`,
      [created.json().id],
    )
    expect(sideEffects.rows[0]).toEqual({ purchases: '0', movements: '0', audits: '4' })
  })

  it('requires a reason when cancelling and records it in the timeline', async () => {
    const created = await postOrder(randomUUID(), {
      customerId,
      club: 'Palmeiras',
      model: 'Away',
      type: 'Feminina',
      size: 'G',
    })
    expect(created.statusCode).toBe(201)
    const withoutReason = await patchStatus(created.json().id, randomUUID(), { status: 'cancelled' })
    expect(withoutReason.statusCode).toBe(400)
    expect(withoutReason.json()).toMatchObject({ code: 'CANCELLATION_REASON_REQUIRED' })

    const cancelled = await patchStatus(created.json().id, randomUUID(), { status: 'cancelled', reason: 'Cliente desistiu na fixture' })
    expect(cancelled.statusCode).toBe(200)
    const detail = await app.inject({ method: 'GET', url: `/customer-orders/${created.json().id}`, headers: { cookie: authCookie() } })
    expect(detail.json().timeline.at(-1)).toMatchObject({ fromStatus: 'pending', toStatus: 'cancelled', reason: 'Cliente desistiu na fixture' })

    const missing = await patchStatus(randomUUID(), randomUUID(), { status: 'supplier_ordered' })
    expect(missing.statusCode).toBe(404)
    expect(missing.json()).toMatchObject({ code: 'CUSTOMER_ORDER_NOT_FOUND' })
  })

  it('searches orders with pre-pagination total and exposes a rich detail', async () => {
    const created = await postOrder(randomUUID(), {
      customerId,
      club: 'Busca FC',
      model: 'Modelo Busca',
      type: 'Masculina',
      size: 'M',
      notes: 'Nota da fixture',
    })
    expect(created.statusCode).toBe(201)
    const orderId = created.json().id as string

    const search = await app.inject({ method: 'GET', url: '/customer-orders?search=Busca%20FC', headers: { cookie: authCookie() } })
    expect(search.statusCode).toBe(200)
    expect(search.json().items.map((item: { id: string }) => item.id)).toContain(orderId)
    expect(search.json().items[0]).toMatchObject({ customerContact: 'fixture' })
    expect(search.json().total).toBeGreaterThanOrEqual(1)

    const second = await app.inject({ method: 'GET', url: '/customer-orders?search=Busca%20FC&page=2&limit=1', headers: { cookie: authCookie() } })
    expect(second.json().items).toHaveLength(0)
    expect(second.json().total).toBe(search.json().total)

    const detail = await app.inject({ method: 'GET', url: `/customer-orders/${orderId}`, headers: { cookie: authCookie() } })
    expect(detail.json()).toMatchObject({
      id: orderId,
      customerName: 'Cliente Encomenda',
      customerContact: 'fixture',
      operatorDisplayName: 'Gestor Encomendas',
      notes: 'Nota da fixture',
    })
    expect(typeof detail.json().createdAt).toBe('string')
    expect(typeof detail.json().updatedAt).toBe('string')
    expect(detail.json().timeline[0]).toMatchObject({ toStatus: 'pending', userDisplayName: 'Gestor Encomendas' })
  })

  it('grants the manager customers:read for the order customer picker', async () => {    const response = await app.inject({ method: 'GET', url: '/customers?search=Encomenda', headers: { cookie: authCookie() } })
    expect(response.statusCode).toBe(200)
    expect(response.json().items.map((item: { name: string }) => item.name)).toContain('Cliente Encomenda')
  })

  it('denies operators without customer_orders:write on every route without effects', async () => {
    const operatorToken = randomUUID()
    const operatorCsrf = randomUUID()
    const operatorId = randomUUID()
    await pool.query(
      `INSERT INTO users (id, username, display_name, password_hash, role_id)
       VALUES ($1, $2, 'Operador Sem Encomendas', 'unused-in-this-test', '00000000-0000-4000-8000-000000000001')`,
      [operatorId, `operador.sem.encomendas.${randomUUID().slice(0, 8)}`],
    )
    await pool.query(
      `INSERT INTO sessions (id, user_id, token_hash, csrf_hash, expires_at)
       VALUES ($1, $2, $3, $4, now() + interval '1 hour')`,
      [randomUUID(), operatorId, hashSecret(operatorToken), hashSecret(operatorCsrf)],
    )
    const cookie = `erp_session=${encodeURIComponent(operatorToken)}; erp_csrf=${encodeURIComponent(operatorCsrf)}`
    const before = await pool.query<{ orders: string; audits: string }>(
      `SELECT (SELECT count(*) FROM customer_orders) AS orders,
              (SELECT count(*) FROM audit_log WHERE action LIKE 'customer_order.%') AS audits`,
    )

    expect((await app.inject({ method: 'GET', url: '/customer-orders', headers: { cookie } })).statusCode).toBe(403)
    expect((await app.inject({ method: 'GET', url: `/customer-orders/${randomUUID()}`, headers: { cookie } })).statusCode).toBe(403)
    expect((await app.inject({
      method: 'POST', url: '/customer-orders', payload: { customerId },
      headers: { cookie, 'x-csrf-token': operatorCsrf, 'idempotency-key': randomUUID() },
    })).statusCode).toBe(403)
    expect((await app.inject({
      method: 'PATCH', url: `/customer-orders/${randomUUID()}/status`,
      payload: { status: 'supplier_ordered' },
      headers: { cookie, 'x-csrf-token': operatorCsrf, 'idempotency-key': randomUUID() },
    })).statusCode).toBe(403)

    const after = await pool.query<{ orders: string; audits: string }>(
      `SELECT (SELECT count(*) FROM customer_orders) AS orders,
              (SELECT count(*) FROM audit_log WHERE action LIKE 'customer_order.%') AS audits`,
    )
    expect(after.rows[0]).toEqual(before.rows[0])
  })

  it('rejects missing or invalid CSRF on writes without effects', async () => {
    const before = await pool.query<{ orders: string }>(`SELECT count(*) AS orders FROM customer_orders`)
    const noCsrf = await app.inject({
      method: 'POST', url: '/customer-orders',
      payload: { customerId, club: 'A', model: 'B', type: 'Masculina', size: 'M' },
      headers: { cookie: authCookie(), 'idempotency-key': randomUUID() },
    })
    expect(noCsrf.statusCode).toBe(403)
    expect(noCsrf.json()).toMatchObject({ code: 'INVALID_CSRF' })

    const badCsrf = await app.inject({
      method: 'PATCH', url: `/customer-orders/${randomUUID()}/status`,
      payload: { status: 'supplier_ordered' },
      headers: { cookie: authCookie(), 'x-csrf-token': 'invalido', 'idempotency-key': randomUUID() },
    })
    expect(badCsrf.statusCode).toBe(403)

    const after = await pool.query<{ orders: string }>(`SELECT count(*) AS orders FROM customer_orders`)
    expect(after.rows[0]).toEqual(before.rows[0])
  })

  it('accepts explicit nulls as the same semantic payload without duplicating', async () => {
    const base = {
      customerId, club: 'Nulo FC', model: 'Modelo Nulo', type: 'Masculina', size: 'M',
    }
    const omitted = await postOrder(randomUUID(), base)
    expect(omitted.statusCode).toBe(201)
    expect(omitted.json()).toMatchObject({ variantId: null, linkedPurchaseOrderId: null })

    const explicit = await postOrder(randomUUID(), { ...base, variantId: null, linkedPurchaseOrderId: null, notes: null })
    expect(explicit.statusCode).toBe(201)

    const sharedKey = randomUUID()
    const replayOmitted = await postOrder(sharedKey, base)
    expect(replayOmitted.statusCode).toBe(201)
    const replayNull = await postOrder(sharedKey, { ...base, variantId: null, linkedPurchaseOrderId: null, notes: null })
    expect(replayNull.statusCode).toBe(201)
    expect(replayNull.json()).toEqual(replayOmitted.json())
  })

  function postOrder(key: string, payload: Record<string, unknown>) {
    return app.inject({ method: 'POST', url: '/customer-orders', payload, headers: authHeaders(key) })
  }

  function patchStatus(id: string, key: string, payload: Record<string, unknown>) {
    return app.inject({ method: 'PATCH', url: `/customer-orders/${id}/status`, payload, headers: authHeaders(key) })
  }

  function authHeaders(key: string) {
    return { cookie: authCookie(), 'x-csrf-token': csrfToken, 'idempotency-key': key }
  }

  function authCookie() {
    return `erp_session=${encodeURIComponent(sessionToken)}; erp_csrf=${encodeURIComponent(csrfToken)}`
  }
})
