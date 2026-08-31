import { randomUUID } from 'node:crypto'

import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { buildApp } from '../../app.js'
import { hashSecret } from '../../shared/auth/session.js'
import { applyMigrations } from '../../shared/db/migrate.js'

const connectionString = process.env['TEST_DATABASE_URL']
if (!connectionString) throw new Error('TEST_DATABASE_URL is required for PostgreSQL integration tests.')

describe('sales HTTP flow', () => {
  const adminPool = new Pool({ connectionString, max: 1 })
  const schema = `erp2_test_${randomUUID().replaceAll('-', '')}`
  const sessionToken = randomUUID()
  const csrfToken = randomUUID()
  const operatorId = randomUUID()
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
       VALUES ($1, 'operador.vendas', 'Operador Vendas', 'unused-in-this-test', $2)`,
      [operatorId, '00000000-0000-4000-8000-000000000003'],
    )
    await pool.query(
      `INSERT INTO sessions (id, user_id, token_hash, csrf_hash, expires_at)
       VALUES ($1, $2, $3, $4, now() + interval '1 hour')`,
      [randomUUID(), operatorId, hashSecret(sessionToken), hashSecret(csrfToken)],
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

  it('requires authentication for sale creation', async () => {
    const response = await app.inject({ method: 'POST', url: '/sales', payload: {} })
    expect(response.statusCode).toBe(401)
    expect(response.json()).toMatchObject({ code: 'UNAUTHENTICATED' })
  })

  it('creates one paid sale with authoritative totals, stock movement and idempotent replay', async () => {
    const variantId = await insertVariant(3)
    const key = randomUUID()
    const payload = {
      items: [{ variantId, quantity: 2 }],
      discountAmount: '10.00',
      payment: { amount: '290.00', method: 'pix' },
    }
    const first = await postSale(key, payload)
    const repeated = await postSale(key, payload)

    expect(first.statusCode).toBe(201)
    expect(repeated.statusCode).toBe(201)
    expect(repeated.json()).toEqual(first.json())
    expect(first.json()).toMatchObject({ status: 'paid', subtotalAmount: '300.00', discountAmount: '10.00', finalAmount: '290.00', amountDue: '0.00' })

    const detail = await app.inject({ method: 'GET', url: `/sales/${first.json().id}`, headers: { cookie: authCookie() } })
    expect(detail.statusCode).toBe(200)
    expect(detail.json()).toMatchObject({ id: first.json().id, items: [{ variantId, quantity: 2, unitPrice: '150.00', unitCost: '80.00' }] })
    expect(detail.json().payments).toHaveLength(1)

    const changed = await postSale(key, { ...payload, items: [{ variantId, quantity: 1 }] })
    expect(changed.statusCode).toBe(409)
    expect(changed.json()).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' })

    const state = await pool.query<{
      stock_quantity: number
      sales: string
      items: string
      payments: string
      movements: string
      audits: string
    }>(
      `SELECT v.stock_quantity,
              (SELECT count(*) FROM sales WHERE id = $2) AS sales,
              (SELECT count(*) FROM sale_items WHERE sale_id = $2) AS items,
              (SELECT count(*) FROM payments WHERE sale_id = $2) AS payments,
              (SELECT count(*) FROM inventory_movements WHERE source_entity_id = $2) AS movements,
              (SELECT count(*) FROM audit_log WHERE entity_id = $2::text AND action = 'sale.create') AS audits
       FROM product_variants v WHERE v.id = $1`,
      [variantId, first.json().id],
    )
    expect(state.rows[0]).toEqual({ stock_quantity: 1, sales: '1', items: '1', payments: '1', movements: '1', audits: '1' })
  })

  it('requires an identified customer and due date for a pending sale', async () => {
    const variantId = await insertVariant(2)
    const invalid = await postSale(randomUUID(), { items: [{ variantId, quantity: 1 }], discountAmount: '0.00' })
    expect(invalid.statusCode).toBe(400)
    expect(invalid.json()).toMatchObject({ code: 'PENDING_SALE_REQUIRES_CUSTOMER' })

    const customerId = randomUUID()
    await pool.query('INSERT INTO customers (id, name) VALUES ($1, $2)', [customerId, 'Cliente Sintético'])
    const pending = await postSale(randomUUID(), {
      customerId,
      paymentDueDate: '2026-09-30',
      items: [{ variantId, quantity: 1 }],
      discountAmount: '0.00',
    })
    expect(pending.statusCode).toBe(201)
    expect(pending.json()).toMatchObject({ status: 'pending', finalAmount: '150.00', amountDue: '150.00' })
  })

  it('serializes concurrent sales of the last item without partial writes', async () => {
    const variantId = await insertVariant(1)
    const request = () => postSale(randomUUID(), {
      items: [{ variantId, quantity: 1 }],
      discountAmount: '0.00',
      payment: { amount: '150.00', method: 'cash' },
    })

    const responses = await Promise.all([request(), request()])
    expect(responses.map(({ statusCode }) => statusCode).sort()).toEqual([201, 409])
    expect(responses.find(({ statusCode }) => statusCode === 409)?.json()).toMatchObject({ code: 'INSUFFICIENT_STOCK' })

    const state = await pool.query<{ stock_quantity: number; sales: string; movements: string }>(
      `SELECT v.stock_quantity,
              (SELECT count(*) FROM sale_items WHERE variant_id = $1) AS sales,
              (SELECT count(*) FROM inventory_movements WHERE variant_id = $1 AND type = 'sale') AS movements
       FROM product_variants v WHERE v.id = $1`,
      [variantId],
    )
    expect(state.rows[0]).toEqual({ stock_quantity: 0, sales: '1', movements: '1' })
  })

  it('appends idempotent later payments and transitions pending through partially paid to paid', async () => {
    const variantId = await insertVariant(2)
    const customerId = await insertCustomer()
    const sale = await postSale(randomUUID(), {
      customerId,
      paymentDueDate: '2026-09-30',
      items: [{ variantId, quantity: 1 }],
      discountAmount: '0.00',
    })
    const firstKey = randomUUID()
    const first = await postPayment(sale.json().id, firstKey, { amount: '50.00', method: 'pix' })
    const repeated = await postPayment(sale.json().id, firstKey, { amount: '50.00', method: 'pix' })

    expect(first.statusCode).toBe(201)
    expect(repeated.json()).toEqual(first.json())
    expect(first.json()).toMatchObject({ saleId: sale.json().id, status: 'partially_paid', amountDue: '100.00' })

    const changed = await postPayment(sale.json().id, firstKey, { amount: '60.00', method: 'pix' })
    expect(changed.statusCode).toBe(409)
    expect(changed.json()).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' })

    const final = await postPayment(sale.json().id, randomUUID(), { amount: '100.00', method: 'cash' })
    expect(final.statusCode).toBe(201)
    expect(final.json()).toMatchObject({ status: 'paid', amountDue: '0.00' })

    const detail = await app.inject({ method: 'GET', url: `/sales/${sale.json().id}`, headers: { cookie: authCookie() } })
    expect(detail.json().payments).toHaveLength(2)
    expect(detail.json()).toMatchObject({ status: 'paid', amountDue: '0.00' })

    const list = await app.inject({ method: 'GET', url: '/sales?status=paid&limit=20', headers: { cookie: authCookie() } })
    expect(list.statusCode).toBe(200)
    expect(list.json().items).toEqual(expect.arrayContaining([expect.objectContaining({ id: sale.json().id, status: 'paid' })]))

    const invalidList = await app.inject({ method: 'GET', url: '/sales?limit=101', headers: { cookie: authCookie() } })
    expect(invalidList.statusCode).toBe(400)
    expect(invalidList.json()).toMatchObject({ code: 'VALIDATION_ERROR' })

    const state = await pool.query<{ payments: string; audits: string; stock_quantity: number }>(
      `SELECT
         (SELECT count(*) FROM payments WHERE sale_id = $1) AS payments,
         (SELECT count(*) FROM audit_log WHERE entity_id = $1::text AND action = 'sale.payment') AS audits,
         (SELECT stock_quantity FROM product_variants WHERE id = $2) AS stock_quantity`,
      [sale.json().id, variantId],
    )
    expect(state.rows[0]).toEqual({ payments: '2', audits: '2', stock_quantity: 1 })
  })

  it('serializes concurrent later payments so confirmed value never exceeds the amount due', async () => {
    const variantId = await insertVariant(1)
    const customerId = await insertCustomer()
    const sale = await postSale(randomUUID(), {
      customerId,
      paymentDueDate: '2026-09-30',
      items: [{ variantId, quantity: 1 }],
      discountAmount: '0.00',
    })
    const request = () => postPayment(sale.json().id, randomUUID(), { amount: '100.00', method: 'pix' })

    const responses = await Promise.all([request(), request()])
    expect(responses.map(({ statusCode }) => statusCode).sort()).toEqual([201, 409])
    expect(responses.find(({ statusCode }) => statusCode === 409)?.json()).toMatchObject({ code: 'PAYMENT_EXCEEDS_AMOUNT_DUE' })

    const totals = await pool.query<{ paid: string; payments: string; status: string }>(
      `SELECT coalesce(sum(p.amount), 0)::text AS paid, count(p.id)::text AS payments, max(s.status) AS status
       FROM sales s LEFT JOIN payments p ON p.sale_id = s.id AND p.status = 'confirmed'
       WHERE s.id = $1`,
      [sale.json().id],
    )
    expect(totals.rows[0]).toEqual({ paid: '100.00', payments: '1', status: 'partially_paid' })

    const missing = await postPayment(randomUUID(), randomUUID(), { amount: '10.00', method: 'cash' })
    expect(missing.statusCode).toBe(404)
    expect(missing.json()).toMatchObject({ code: 'SALE_NOT_FOUND' })
  })

  function postSale(key: string, payload: Record<string, unknown>) {
    return app.inject({
      method: 'POST',
      url: '/sales',
      payload,
      headers: { cookie: authCookie(), 'x-csrf-token': csrfToken, 'idempotency-key': key },
    })
  }

  function authCookie() {
    return `erp_session=${encodeURIComponent(sessionToken)}; erp_csrf=${encodeURIComponent(csrfToken)}`
  }

  function postPayment(saleId: string, key: string, payload: Record<string, unknown>) {
    return app.inject({
      method: 'POST',
      url: `/sales/${saleId}/payments`,
      payload,
      headers: { cookie: authCookie(), 'x-csrf-token': csrfToken, 'idempotency-key': key },
    })
  }

  async function insertCustomer(): Promise<string> {
    const id = randomUUID()
    await pool.query('INSERT INTO customers (id, name) VALUES ($1, $2)', [id, `Cliente ${id}`])
    return id
  }

  async function insertVariant(stock: number): Promise<string> {
    const productId = randomUUID()
    const variantId = randomUUID()
    await pool.query('INSERT INTO products (id, club, model) VALUES ($1, $2, $3)', [productId, 'Venda FC', randomUUID()])
    await pool.query(
      `INSERT INTO product_variants
         (id, product_id, type, size, sku, sale_price, current_cost, stock_quantity)
       VALUES ($1, $2, 'Masculina', 'M', $3, 150.00, 80.00, $4)`,
      [variantId, productId, randomUUID(), stock],
    )
    return variantId
  }
})
