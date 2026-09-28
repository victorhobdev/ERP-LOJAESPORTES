import { randomUUID } from 'node:crypto'

import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { buildApp } from '../../app.js'
import { hashSecret } from '../../shared/auth/session.js'
import { applyMigrations } from '../../shared/db/migrate.js'

/** Data futura (30 dias) em YYYY-MM-DD, computada na execucao para nao virar bomba-relogio. */
function futureDueDate(): string {
  const d = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const connectionString = process.env['TEST_DATABASE_URL']
if (!connectionString) throw new Error('TEST_DATABASE_URL is required for PostgreSQL integration tests.')

describe('sales HTTP flow', () => {
  const adminPool = new Pool({ connectionString, max: 1 })
  const schema = `erp2_test_${randomUUID().replaceAll('-', '')}`
  const sessionToken = randomUUID()
  const csrfToken = randomUUID()
  const operatorId = randomUUID()
  const adminId = randomUUID()
  const adminToken = randomUUID()
  const adminCsrf = randomUUID()
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
    await pool.query(
      `INSERT INTO users (id, username, display_name, password_hash, role_id)
       VALUES ($1, 'admin.vendas', 'Admin Vendas', 'unused-in-this-test', $2)`,
      [adminId, '00000000-0000-4000-8000-000000000004'],
    )
    await pool.query(
      `INSERT INTO sessions (id, user_id, token_hash, csrf_hash, expires_at)
       VALUES ($1, $2, $3, $4, now() + interval '1 hour')`,
      [randomUUID(), adminId, hashSecret(adminToken), hashSecret(adminCsrf)],
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
    expect(detail.json().items[0]).toMatchObject({ club: 'Venda FC', model: expect.any(String), type: expect.any(String), size: expect.any(String) })

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
      paymentDueDate: futureDueDate(),
      items: [{ variantId, quantity: 1 }],
      discountAmount: '0.00',
    })
    expect(pending.statusCode).toBe(201)
    expect(pending.json()).toMatchObject({ status: 'pending', finalAmount: '150.00', amountDue: '150.00' })
  })

  it('rejeita venda pendente ou parcial com vencimento no passado ou hoje', async () => {
    const variantId = await insertVariant(2)
    const customerId = await insertCustomer()
    const before = await pool.query('SELECT count(*)::int AS total FROM sales')
    const past = await postSale(randomUUID(), {
      customerId, paymentDueDate: '2020-01-01',
      items: [{ variantId, quantity: 1 }], discountAmount: '0.00',
    })
    expect(past.statusCode).toBe(400)
    expect(past.json()).toMatchObject({ code: 'PENDING_SALE_DUE_DATE_PAST' })

    const now = new Date()
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
    const dueToday = await postSale(randomUUID(), {
      customerId, paymentDueDate: today,
      items: [{ variantId, quantity: 1 }], discountAmount: '0.00',
    })
    expect(dueToday.statusCode).toBe(400)
    expect(dueToday.json()).toMatchObject({ code: 'PENDING_SALE_DUE_DATE_PAST' })

    const partial = await postSale(randomUUID(), {
      customerId, paymentDueDate: '2020-01-01',
      items: [{ variantId, quantity: 1 }], discountAmount: '0.00',
      payment: { amount: '60.00', method: 'pix' },
    })
    expect(partial.statusCode).toBe(400)
    expect(partial.json()).toMatchObject({ code: 'PENDING_SALE_DUE_DATE_PAST' })

    const after = await pool.query('SELECT count(*)::int AS total FROM sales')
    expect(after.rows[0]?.total).toBe(before.rows[0]?.total)
    const stock = await pool.query<{ stock_quantity: number }>('SELECT stock_quantity FROM product_variants WHERE id = $1', [variantId])
    expect(stock.rows[0]?.stock_quantity).toBe(2)
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
      paymentDueDate: futureDueDate(),
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

    const openList = await app.inject({ method: 'GET', url: '/sales?status=open&limit=20', headers: { cookie: authCookie() } })
    expect(openList.statusCode).toBe(200)
    expect(openList.json().items).toEqual(expect.not.arrayContaining([expect.objectContaining({ id: sale.json().id })]))

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

  it('lists open sales as pending plus partially paid without touching individual filters', async () => {
    const variantId = await insertVariant(5)
    const customerId = await insertCustomer()
    const pending = await postSale(randomUUID(), {
      customerId,
      paymentDueDate: futureDueDate(),
      items: [{ variantId, quantity: 1 }],
      discountAmount: '0.00',
    })
    const partial = await postSale(randomUUID(), {
      customerId,
      paymentDueDate: futureDueDate(),
      items: [{ variantId, quantity: 1 }],
      discountAmount: '0.00',
      payment: { amount: '50.00', method: 'pix' },
    })
    const paid = await postSale(randomUUID(), {
      items: [{ variantId, quantity: 1 }],
      discountAmount: '0.00',
      payment: { amount: '150.00', method: 'pix' },
    })
    expect(pending.json()).toMatchObject({ status: 'pending' })
    expect(partial.json()).toMatchObject({ status: 'partially_paid' })
    expect(paid.json()).toMatchObject({ status: 'paid' })

    const open = await app.inject({ method: 'GET', url: '/sales?status=open&limit=20', headers: { cookie: authCookie() } })
    expect(open.statusCode).toBe(200)
    const openIds = (open.json().items as Array<{ id: string }>).map((item) => item.id)
    expect(openIds).toEqual(expect.arrayContaining([pending.json().id, partial.json().id]))
    expect(openIds).not.toContain(paid.json().id)

    const pendingOnly = await app.inject({ method: 'GET', url: '/sales?status=pending&limit=20', headers: { cookie: authCookie() } })
    expect((pendingOnly.json().items as Array<{ id: string }>).map((item) => item.id)).toEqual(
      expect.arrayContaining([pending.json().id]),
    )
  })

  it('serializes concurrent later payments so confirmed value never exceeds the amount due', async () => {
    const variantId = await insertVariant(1)
    const customerId = await insertCustomer()
    const sale = await postSale(randomUUID(), {
      customerId,
      paymentDueDate: futureDueDate(),
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

  it('exchanges sold stock atomically without rewriting the original sale item', async () => {
    const returnedVariantId = await insertVariant(5)
    const deliveredVariantId = await insertVariant(2)
    const sale = await postSale(randomUUID(), {
      items: [{ variantId: returnedVariantId, quantity: 1 }],
      discountAmount: '0.00',
      payment: { amount: '150.00', method: 'pix' },
    })
    const key = randomUUID()
    const payload = {
      reason: 'Tamanho incorreto na fixture',
      returned: [{ variantId: returnedVariantId, quantity: 1 }],
      delivered: [{ variantId: deliveredVariantId, quantity: 1 }],
    }
    const first = await postExchange(sale.json().id, key, payload)
    const repeated = await postExchange(sale.json().id, key, payload)

    expect(first.statusCode).toBe(201)
    expect(repeated.json()).toEqual(first.json())
    expect(first.json()).toMatchObject({ saleId: sale.json().id, returnedUnits: 1, deliveredUnits: 1 })

    const changed = await postExchange(sale.json().id, key, { ...payload, reason: 'Outro motivo sintético' })
    expect(changed.statusCode).toBe(409)
    expect(changed.json()).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' })

    const duplicateReturn = await postExchange(sale.json().id, randomUUID(), payload)
    expect(duplicateReturn.statusCode).toBe(409)
    expect(duplicateReturn.json()).toMatchObject({ code: 'RETURN_QUANTITY_EXCEEDED' })

    const detail = await app.inject({ method: 'GET', url: `/sales/${sale.json().id}`, headers: { cookie: authCookie() } })
    expect(detail.json().items).toEqual([expect.objectContaining({ variantId: returnedVariantId })])
    expect(detail.json().exchanges).toHaveLength(1)
    expect(detail.json().exchanges[0].items[0]).toMatchObject({ club: 'Venda FC', model: expect.any(String), type: expect.any(String), size: expect.any(String) })

    const state = await pool.query<{
      returned_stock: number
      delivered_stock: number
      exchanges: string
      exchange_items: string
      movements: string
      audits: string
    }>(
      `SELECT
         (SELECT stock_quantity FROM product_variants WHERE id = $1) AS returned_stock,
         (SELECT stock_quantity FROM product_variants WHERE id = $2) AS delivered_stock,
         (SELECT count(*) FROM exchanges WHERE sale_id = $3) AS exchanges,
         (SELECT count(*) FROM exchange_items ei JOIN exchanges e ON e.id = ei.exchange_id WHERE e.sale_id = $3) AS exchange_items,
         (SELECT count(*) FROM inventory_movements WHERE source_entity_type = 'exchange' AND source_entity_id IN (SELECT id FROM exchanges WHERE sale_id = $3)) AS movements,
         (SELECT count(*) FROM audit_log WHERE entity_id = $3::text AND action = 'sale.exchange') AS audits`,
      [returnedVariantId, deliveredVariantId, sale.json().id],
    )
    expect(state.rows[0]).toEqual({ returned_stock: 5, delivered_stock: 1, exchanges: '1', exchange_items: '2', movements: '2', audits: '1' })
  })

  it('rolls back the returned side when concurrent exchange delivery has no stock', async () => {
    const returnedVariantId = await insertVariant(3)
    const deliveredVariantId = await insertVariant(1)
    const sale = await postSale(randomUUID(), {
      items: [{ variantId: returnedVariantId, quantity: 2 }],
      discountAmount: '0.00',
      payment: { amount: '300.00', method: 'cash' },
    })
    const request = () => postExchange(sale.json().id, randomUUID(), {
      reason: 'Concorrência sintética',
      returned: [{ variantId: returnedVariantId, quantity: 1 }],
      delivered: [{ variantId: deliveredVariantId, quantity: 1 }],
    })

    const responses = await Promise.all([request(), request()])
    expect(responses.map(({ statusCode }) => statusCode).sort()).toEqual([201, 409])
    expect(responses.find(({ statusCode }) => statusCode === 409)?.json()).toMatchObject({ code: 'INSUFFICIENT_STOCK' })

    const state = await pool.query<{ returned_stock: number; delivered_stock: number; exchanges: string }>(
      `SELECT
         (SELECT stock_quantity FROM product_variants WHERE id = $1) AS returned_stock,
         (SELECT stock_quantity FROM product_variants WHERE id = $2) AS delivered_stock,
         (SELECT count(*) FROM exchanges WHERE sale_id = $3) AS exchanges`,
      [returnedVariantId, deliveredVariantId, sale.json().id],
    )
    expect(state.rows[0]).toEqual({ returned_stock: 2, delivered_stock: 0, exchanges: '1' })
  })

  it('redacts unit cost for operators without products:write', async () => {
    const operatorToken = randomUUID()
    const operatorCsrf = randomUUID()
    const operatorId = randomUUID()
    await pool.query(
      `INSERT INTO users (id, username, display_name, password_hash, role_id)
       VALUES ($1, $2, 'Operador Vendas', 'unused-in-this-test', '00000000-0000-4000-8000-000000000001')`,
      [operatorId, `operador.vendas.${randomUUID().slice(0, 8)}`],
    )
    await pool.query(
      `INSERT INTO sessions (id, user_id, token_hash, csrf_hash, expires_at)
       VALUES ($1, $2, $3, $4, now() + interval '1 hour')`,
      [randomUUID(), operatorId, hashSecret(operatorToken), hashSecret(operatorCsrf)],
    )
    const operatorCookie = `erp_session=${encodeURIComponent(operatorToken)}; erp_csrf=${encodeURIComponent(operatorCsrf)}`
    const operatorPost = (key: string, payload: Record<string, unknown>) => app.inject({
      method: 'POST', url: '/sales', payload,
      headers: { cookie: operatorCookie, 'x-csrf-token': operatorCsrf, 'idempotency-key': key },
    })
    const operatorGet = (url: string) => app.inject({ method: 'GET', url, headers: { cookie: operatorCookie } })

    const variantId = await insertVariant(3)
    const created = await operatorPost(randomUUID(), {
      items: [{ variantId, quantity: 1 }],
      discountAmount: '0.00',
      payment: { amount: '150.00', method: 'pix' },
    })
    expect(created.statusCode).toBe(201)
    for (const item of created.json().items as Array<Record<string, unknown>>) {
      expect(item).not.toHaveProperty('unitCost')
    }

    const saleId = created.json().id as string
    const operatorDetail = await operatorGet(`/sales/${saleId}`)
    expect(operatorDetail.statusCode).toBe(200)
    for (const item of operatorDetail.json().items as Array<Record<string, unknown>>) {
      expect(item).not.toHaveProperty('unitCost')
    }

    const managerDetail = await app.inject({ method: 'GET', url: `/sales/${saleId}`, headers: { cookie: authCookie() } })
    expect(managerDetail.json().items[0]).toMatchObject({ unitCost: '80.00' })
  })

  it('aggregates an ordered timeline of sale, payments and exchanges', async () => {
    const variantId = await insertVariant(3)
    const customerId = await insertCustomer()
    const sale = await postSale(randomUUID(), {
      customerId,
      paymentDueDate: futureDueDate(),
      items: [{ variantId, quantity: 1 }],
      discountAmount: '0.00',
    })
    expect(sale.statusCode).toBe(201)
    const saleId = sale.json().id as string
    expect((await postPayment(saleId, randomUUID(), { amount: '50.00', method: 'pix' })).statusCode).toBe(201)
    expect((await postPayment(saleId, randomUUID(), { amount: '100.00', method: 'cash' })).statusCode).toBe(201)
    const exchange = await postExchange(saleId, randomUUID(), {
      reason: 'Timeline sintetica',
      returned: [{ variantId, quantity: 1 }],
      delivered: [{ variantId, quantity: 1 }],
    })
    expect(exchange.statusCode).toBe(201)

    const detail = await app.inject({ method: 'GET', url: `/sales/${saleId}`, headers: { cookie: authCookie() } })
    expect(detail.statusCode).toBe(200)
    expect(typeof detail.json().createdAt).toBe('string')
    const timeline = detail.json().timeline as Array<{ kind: string; id: string; at: string; status?: string; amount?: string; receivedAt?: string }>
    expect(timeline.map((entry) => entry.kind)).toEqual([
      'sale.created', 'payment.confirmed', 'payment.confirmed', 'exchange.created',
    ])
    const timestamps = timeline.map((entry) => new Date(entry.at).getTime())
    expect(timestamps.every((value) => !Number.isNaN(value))).toBe(true)
    expect([...timestamps].sort((a, b) => a - b)).toEqual(timestamps)
    expect(timeline[0]).toMatchObject({ id: saleId, status: 'paid' })
    expect(timeline[1]).toMatchObject({ amount: '50.00' })
    expect(typeof timeline[1]?.receivedAt).toBe('string')
    expect(timeline[3]).toMatchObject({ id: exchange.json().id })
  })

  it('creates a partially paid sale at checkout and rejects overpayment', async () => {
    const variantId = await insertVariant(2)
    const customerId = await insertCustomer()

    const partial = await postSale(randomUUID(), {
      customerId,
      paymentDueDate: futureDueDate(),
      items: [{ variantId, quantity: 1 }],
      discountAmount: '0.00',
      payment: { amount: '60.00', method: 'pix' },
    })
    expect(partial.statusCode).toBe(201)
    expect(partial.json()).toMatchObject({ status: 'partially_paid', finalAmount: '150.00', amountDue: '90.00' })

    const overpaid = await postSale(randomUUID(), {
      customerId,
      paymentDueDate: futureDueDate(),
      items: [{ variantId, quantity: 1 }],
      discountAmount: '0.00',
      payment: { amount: '151.00', method: 'pix' },
    })
    expect(overpaid.statusCode).toBe(400)
    expect(overpaid.json()).toMatchObject({ code: 'PAYMENT_EXCEEDS_TOTAL' })

    const zeroPartial = await postSale(randomUUID(), {
      customerId,
      paymentDueDate: futureDueDate(),
      items: [{ variantId, quantity: 1 }],
      discountAmount: '0.00',
      payment: { amount: '0.00', method: 'pix' },
    })
    expect(zeroPartial.statusCode).toBe(400)
  })

  it('reverses a paid sale restoring stock, reversing payments and auditing', async () => {
    const variantId = await insertVariant(5)
    const sale = await postSale(randomUUID(), {
      items: [{ variantId, quantity: 2 }],
      discountAmount: '0.00',
      payment: { amount: '300.00', method: 'pix' },
    })
    expect(sale.statusCode).toBe(201)
    const saleId = sale.json().id

    const anonymous = await app.inject({ method: 'POST', url: `/sales/${saleId}/reversal`, payload: {} })
    expect(anonymous.statusCode).toBe(401)

    const forbidden = await app.inject({
      method: 'POST', url: `/sales/${saleId}/reversal`, payload: {},
      headers: { cookie: authCookie(), 'x-csrf-token': csrfToken },
    })
    expect(forbidden.statusCode).toBe(403)
    expect(forbidden.json()).toMatchObject({ code: 'FORBIDDEN' })

    const reversed = await postReversal(saleId, { reason: 'Venda digitada errada' })
    expect(reversed.statusCode).toBe(200)
    expect(reversed.json()).toMatchObject({ id: saleId, status: 'reversed', paymentsReversed: 1 })

    const again = await postReversal(saleId, {})
    expect(again.statusCode).toBe(409)
    expect(again.json()).toMatchObject({ code: 'SALE_ALREADY_REVERSED' })

    const state = await pool.query<{ stock_quantity: number; sale_status: string; reversed_payments: string; reversal_movements: string; audits: string }>(
      `SELECT v.stock_quantity,
              (SELECT status FROM sales WHERE id = $2) AS sale_status,
              (SELECT count(*) FROM payments WHERE sale_id = $2 AND status = 'reversed') AS reversed_payments,
              (SELECT count(*) FROM inventory_movements WHERE source_entity_id = $2 AND type = 'reversal') AS reversal_movements,
              (SELECT count(*) FROM audit_log WHERE entity_id = $2::text AND action = 'sale.reverse') AS audits
       FROM product_variants v WHERE v.id = $1`,
      [variantId, saleId],
    )
    expect(state.rows[0]).toEqual({ stock_quantity: 5, sale_status: 'reversed', reversed_payments: '1', reversal_movements: '1', audits: '1' })
    const audit = await pool.query(`SELECT after_data->>'reason' AS reason FROM audit_log WHERE entity_id = $1 AND action = 'sale.reverse'`, [saleId])
    expect(audit.rows[0]?.reason).toBe('Venda digitada errada')
  })

  it('reverses a partially paid sale without a reason', async () => {
    const variantId = await insertVariant(3)
    const customerId = await insertCustomer()
    const sale = await postSale(randomUUID(), {
      customerId,
      paymentDueDate: futureDueDate(),
      items: [{ variantId, quantity: 1 }],
      discountAmount: '0.00',
      payment: { amount: '50.00', method: 'cash' },
    })
    expect(sale.statusCode).toBe(201)
    expect(sale.json()).toMatchObject({ status: 'partially_paid' })
    const saleId = sale.json().id

    const reversed = await postReversal(saleId, {})
    expect(reversed.statusCode).toBe(200)
    expect(reversed.json()).toMatchObject({ id: saleId, status: 'reversed', paymentsReversed: 1 })

    const state = await pool.query<{ stock_quantity: number; sale_status: string }>(
      `SELECT v.stock_quantity, (SELECT status FROM sales WHERE id = $2) AS sale_status
       FROM product_variants v WHERE v.id = $1`,
      [variantId, saleId],
    )
    expect(state.rows[0]).toEqual({ stock_quantity: 3, sale_status: 'reversed' })
  })

  it('refuses reversal of a sale that already has exchanges', async () => {
    const returnedVariantId = await insertVariant(5)
    const deliveredVariantId = await insertVariant(2)
    const sale = await postSale(randomUUID(), {
      items: [{ variantId: returnedVariantId, quantity: 1 }],
      discountAmount: '0.00',
      payment: { amount: '150.00', method: 'pix' },
    })
    expect(sale.statusCode).toBe(201)
    const exchange = await postExchange(sale.json().id, randomUUID(), {
      reason: 'Tamanho incorreto na fixture',
      returned: [{ variantId: returnedVariantId, quantity: 1 }],
      delivered: [{ variantId: deliveredVariantId, quantity: 1 }],
    })
    expect(exchange.statusCode).toBe(201)

    const reversed = await postReversal(sale.json().id, {})
    expect(reversed.statusCode).toBe(409)
    expect(reversed.json()).toMatchObject({ code: 'SALE_HAS_EXCHANGES' })

    const state = await pool.query<{ status: string }>('SELECT status FROM sales WHERE id = $1', [sale.json().id])
    expect(state.rows[0]?.status).toBe('paid')
  })

  it('rejects reversal of an unknown sale', async () => {
    const response = await postReversal(randomUUID(), {})
    expect(response.statusCode).toBe(404)
    expect(response.json()).toMatchObject({ code: 'SALE_NOT_FOUND' })
  })

  it('serializes concurrent reversals so stock is restored exactly once', async () => {
    const variantId = await insertVariant(5)
    const sale = await postSale(randomUUID(), {
      items: [{ variantId, quantity: 2 }],
      discountAmount: '0.00',
      payment: { amount: '300.00', method: 'pix' },
    })
    expect(sale.statusCode).toBe(201)
    const saleId = sale.json().id

    const responses = await Promise.all([postReversal(saleId, {}), postReversal(saleId, {})])
    expect(responses.map(({ statusCode }) => statusCode).sort()).toEqual([200, 409])
    const losing = responses.find(({ statusCode }) => statusCode === 409)
    expect(losing?.json()).toMatchObject({ code: 'SALE_ALREADY_REVERSED' })

    const state = await pool.query<{ stock_quantity: number; reversal_movements: string; audits: string; reversed_payments: string }>(
      `SELECT v.stock_quantity,
              (SELECT count(*) FROM inventory_movements WHERE source_entity_id = $2 AND type = 'reversal') AS reversal_movements,
              (SELECT count(*) FROM audit_log WHERE entity_id = $2::text AND action = 'sale.reverse') AS audits,
              (SELECT count(*) FROM payments WHERE sale_id = $2 AND status = 'reversed') AS reversed_payments
       FROM product_variants v WHERE v.id = $1`,
      [variantId, saleId],
    )
    expect(state.rows[0]).toEqual({ stock_quantity: 5, reversal_movements: '1', audits: '1', reversed_payments: '1' })
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

  function postExchange(saleId: string, key: string, payload: Record<string, unknown>) {
    return app.inject({
      method: 'POST',
      url: `/sales/${saleId}/exchanges`,
      payload,
      headers: { cookie: authCookie(), 'x-csrf-token': csrfToken, 'idempotency-key': key },
    })
  }

  function postReversal(saleId: string, payload: Record<string, unknown>) {
    return app.inject({
      method: 'POST',
      url: `/sales/${saleId}/reversal`,
      payload,
      headers: { cookie: `erp_session=${encodeURIComponent(adminToken)}; erp_csrf=${encodeURIComponent(adminCsrf)}`, 'x-csrf-token': adminCsrf },
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
