import { randomUUID } from 'node:crypto'

import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { buildApp } from '../../app.js'
import { hashSecret } from '../../shared/auth/session.js'
import { applyMigrations } from '../../shared/db/migrate.js'

const connectionString = process.env['TEST_DATABASE_URL']
if (!connectionString) throw new Error('TEST_DATABASE_URL is required for PostgreSQL integration tests.')

describe('purchase orders HTTP flow', () => {
  const adminPool = new Pool({ connectionString, max: 1 })
  const schema = `erp2_test_${randomUUID().replaceAll('-', '')}`
  const sessionToken = randomUUID()
  const csrfToken = randomUUID()
  const managerId = randomUUID()
  const supplierId = randomUUID()
  let pool: Pool
  let app: ReturnType<typeof buildApp>

  beforeAll(async () => {
    const current = await adminPool.query<{ current_database: string }>('SELECT current_database()')
    if (current.rows[0]?.current_database !== 'erp2_test') throw new Error('Integration tests refuse to run outside erp2_test.')
    await adminPool.query(`CREATE SCHEMA "${schema}"`)
    pool = new Pool({ connectionString, max: 8, options: `-c search_path=${schema}` })
    await applyMigrations(pool)
    await pool.query(
      `INSERT INTO users (id, username, display_name, password_hash, role_id)
       VALUES ($1, 'gestor.compras', 'Gestor Compras', 'unused-in-this-test', $2)`,
      [managerId, '00000000-0000-4000-8000-000000000003'],
    )
    await pool.query('INSERT INTO suppliers (id, name) VALUES ($1, $2)', [supplierId, 'Fornecedor Sintético'])
    await pool.query(
      `INSERT INTO sessions (id, user_id, token_hash, csrf_hash, expires_at)
       VALUES ($1, $2, $3, $4, now() + interval '1 hour')`,
      [randomUUID(), managerId, hashSecret(sessionToken), hashSecret(csrfToken)],
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

  it('requires authentication for purchase order creation', async () => {
    const response = await app.inject({ method: 'POST', url: '/purchase-orders', payload: {} })
    expect(response.statusCode).toBe(401)
    expect(response.json()).toMatchObject({ code: 'UNAUTHENTICATED' })
  })

  it('creates an order and reconciles two idempotent partial receipts through full receipt', async () => {
    const variantId = await insertVariant(0, '0.00')
    const orderKey = randomUUID()
    const orderPayload = {
      supplierId,
      orderedOn: '2026-08-30',
      importFeeAmount: '20.00',
      items: [{ variantId, orderedQuantity: 4, supplierUnitCost: '50.00' }],
    }
    const order = await postOrder(orderKey, orderPayload)
    const orderReplay = await postOrder(orderKey, orderPayload)
    expect(order.statusCode).toBe(201)
    expect(orderReplay.json()).toEqual(order.json())
    expect(order.json()).toMatchObject({ status: 'placed', estimatedItemsAmount: '200.00', importFeeAmount: '20.00', finalAmount: '220.00' })
    const orderItemId = order.json().items[0].id
    expect(order.json().items[0]).toMatchObject({ variantId, orderedQuantity: 4, receivedQuantity: 0, finalUnitCost: '55.00' })
    const changedOrder = await postOrder(orderKey, { ...orderPayload, importFeeAmount: '30.00' })
    expect(changedOrder.statusCode).toBe(409)
    expect(changedOrder.json()).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' })

    const firstKey = randomUUID()
    const first = await postReceipt(order.json().id, firstKey, { items: [{ purchaseOrderItemId: orderItemId, quantity: 2 }], notes: 'Primeiro lote' })
    const replay = await postReceipt(order.json().id, firstKey, { items: [{ purchaseOrderItemId: orderItemId, quantity: 2 }], notes: 'Primeiro lote' })
    expect(first.statusCode).toBe(201)
    expect(replay.json()).toEqual(first.json())
    expect(first.json()).toMatchObject({ status: 'partially_received' })

    const changedReceipt = await postReceipt(order.json().id, firstKey, { items: [{ purchaseOrderItemId: orderItemId, quantity: 1 }] })
    expect(changedReceipt.statusCode).toBe(409)
    expect(changedReceipt.json()).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' })
    const overReceipt = await postReceipt(order.json().id, randomUUID(), { items: [{ purchaseOrderItemId: orderItemId, quantity: 3 }] })
    expect(overReceipt.statusCode).toBe(409)
    expect(overReceipt.json()).toMatchObject({ code: 'RECEIPT_QUANTITY_EXCEEDED' })

    const second = await postReceipt(order.json().id, randomUUID(), { items: [{ purchaseOrderItemId: orderItemId, quantity: 2 }] })
    expect(second.statusCode).toBe(201)
    expect(second.json()).toMatchObject({ status: 'fully_received' })

    const detail = await app.inject({ method: 'GET', url: `/purchase-orders/${order.json().id}`, headers: { cookie: authCookie() } })
    expect(detail.statusCode).toBe(200)
    expect(detail.json().items[0]).toMatchObject({ orderedQuantity: 4, receivedQuantity: 4, pendingQuantity: 0 })
    expect(detail.json().receipts).toHaveLength(2)

    const state = await pool.query<{ stock_quantity: number; current_cost: string; movements: string; receipts: string; audits: string }>(
      `SELECT v.stock_quantity, v.current_cost::text,
              (SELECT count(*) FROM inventory_movements WHERE variant_id = v.id AND type = 'purchase_receipt') AS movements,
              (SELECT count(*) FROM goods_receipts WHERE purchase_order_id = $2) AS receipts,
              (SELECT count(*) FROM audit_log WHERE entity_id = $2::text AND action = 'purchase_order.receive') AS audits
       FROM product_variants v WHERE v.id = $1`,
      [variantId, order.json().id],
    )
    expect(state.rows[0]).toEqual({ stock_quantity: 4, current_cost: '55.00', movements: '2', receipts: '2', audits: '2' })
  })

  it('serializes receipts so received quantity never exceeds ordered quantity', async () => {
    const variantId = await insertVariant(0, '0.00')
    const order = await postOrder(randomUUID(), {
      supplierId,
      orderedOn: '2026-08-30',
      importFeeAmount: '0.00',
      items: [{ variantId, orderedQuantity: 1, supplierUnitCost: '40.00' }],
    })
    expect(order.statusCode).toBe(201)
    const orderItemId = order.json().items[0].id
    const request = () => postReceipt(order.json().id, randomUUID(), { items: [{ purchaseOrderItemId: orderItemId, quantity: 1 }] })

    const responses = await Promise.all([request(), request()])
    expect(responses.map(({ statusCode }) => statusCode).sort()).toEqual([201, 409])
    expect(responses.find(({ statusCode }) => statusCode === 409)?.json()).toMatchObject({ code: 'PURCHASE_ORDER_NOT_RECEIVABLE' })

    const state = await pool.query<{ stock_quantity: number; received_quantity: number; receipts: string }>(
      `SELECT v.stock_quantity, poi.received_quantity,
              (SELECT count(*) FROM goods_receipts WHERE purchase_order_id = poi.purchase_order_id) AS receipts
       FROM purchase_order_items poi JOIN product_variants v ON v.id = poi.variant_id
       WHERE poi.id = $1`,
      [orderItemId],
    )
    expect(state.rows[0]).toEqual({ stock_quantity: 1, received_quantity: 1, receipts: '1' })
  })

  it('rejects missing references and totals that cannot be allocated', async () => {
    const variantId = await insertVariant(0, '0.00')
    const base = {
      orderedOn: '2026-08-30',
      importFeeAmount: '0.00',
      items: [{ variantId, orderedQuantity: 1, supplierUnitCost: '10.00' }],
    }
    const missingSupplier = await postOrder(randomUUID(), { ...base, supplierId: randomUUID() })
    expect(missingSupplier.statusCode).toBe(404)
    expect(missingSupplier.json()).toMatchObject({ code: 'SUPPLIER_NOT_FOUND' })

    const missingVariant = await postOrder(randomUUID(), {
      ...base,
      supplierId,
      items: [{ variantId: randomUUID(), orderedQuantity: 1, supplierUnitCost: '10.00' }],
    })
    expect(missingVariant.statusCode).toBe(404)
    expect(missingVariant.json()).toMatchObject({ code: 'VARIANT_NOT_FOUND' })

    const unallocatable = await postOrder(randomUUID(), {
      ...base,
      supplierId,
      importFeeAmount: '1.00',
      items: [{ variantId, orderedQuantity: 1, supplierUnitCost: '0.00' }],
    })
    expect(unallocatable.statusCode).toBe(400)
    expect(unallocatable.json()).toMatchObject({ code: 'INVALID_PURCHASE_TOTAL' })

    const missingOrder = await postReceipt(randomUUID(), randomUUID(), {
      items: [{ purchaseOrderItemId: randomUUID(), quantity: 1 }],
    })
    expect(missingOrder.statusCode).toBe(404)
    expect(missingOrder.json()).toMatchObject({ code: 'PURCHASE_ORDER_NOT_FOUND' })
  })

  function postOrder(key: string, payload: Record<string, unknown>) {
    return app.inject({ method: 'POST', url: '/purchase-orders', payload, headers: authHeaders(key) })
  }

  function postReceipt(orderId: string, key: string, payload: Record<string, unknown>) {
    return app.inject({ method: 'POST', url: `/purchase-orders/${orderId}/receipts`, payload, headers: authHeaders(key) })
  }

  function authHeaders(key: string) {
    return { cookie: authCookie(), 'x-csrf-token': csrfToken, 'idempotency-key': key }
  }

  function authCookie() {
    return `erp_session=${encodeURIComponent(sessionToken)}; erp_csrf=${encodeURIComponent(csrfToken)}`
  }

  async function insertVariant(stock: number, cost: string): Promise<string> {
    const productId = randomUUID()
    const variantId = randomUUID()
    await pool.query('INSERT INTO products (id, club, model) VALUES ($1, $2, $3)', [productId, 'Compra FC', randomUUID()])
    await pool.query(
      `INSERT INTO product_variants
         (id, product_id, type, size, sku, sale_price, current_cost, stock_quantity)
       VALUES ($1, $2, 'Masculina', 'M', $3, 100.00, $4, $5)`,
      [variantId, productId, randomUUID(), cost, stock],
    )
    return variantId
  }
})
