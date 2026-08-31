import { randomUUID } from 'node:crypto'

import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { buildApp } from '../../app.js'
import { hashSecret } from '../../shared/auth/session.js'
import { applyMigrations } from '../../shared/db/migrate.js'

const connectionString = process.env['TEST_DATABASE_URL']
if (!connectionString) throw new Error('TEST_DATABASE_URL is required for PostgreSQL integration tests.')

describe('financial report HTTP flow', () => {
  const adminPool = new Pool({ connectionString, max: 1 })
  const schema = `erp2_test_${randomUUID().replaceAll('-', '')}`
  const userId = randomUUID()
  const sessionToken = randomUUID()
  let pool: Pool
  let app: ReturnType<typeof buildApp>

  beforeAll(async () => {
    const current = await adminPool.query<{ current_database: string }>('SELECT current_database()')
    if (current.rows[0]?.current_database !== 'erp2_test') throw new Error('Integration tests refuse to run outside erp2_test.')
    await adminPool.query(`CREATE SCHEMA "${schema}"`)
    pool = new Pool({ connectionString, max: 4, options: `-c search_path=${schema}` })
    await applyMigrations(pool)
    await seedKnownDataset()
    app = buildApp({ pool, logger: false, secureCookies: false })
    await app.ready()
  }, 60_000)

  afterAll(async () => {
    await app?.close()
    await pool?.end()
    if (schema.startsWith('erp2_test_')) await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`)
    await adminPool.end()
  })

  it('requires report permission', async () => {
    const response = await app.inject({ method: 'GET', url: '/reports/financial?from=2026-08-01&to=2026-08-31' })
    expect(response.statusCode).toBe(401)
    expect(response.json()).toMatchObject({ code: 'UNAUTHENTICATED' })

    for (const url of [
      '/reports/financial?from=2026-09-01&to=2026-08-01',
      '/reports/products?from=invalid&to=2026-08-01',
      '/dashboard?date=invalid',
    ]) {
      const invalid = await app.inject({ method: 'GET', url, headers: { cookie: `erp_session=${encodeURIComponent(sessionToken)}` } })
      expect(invalid.statusCode).toBe(400)
      expect(invalid.json()).toMatchObject({ code: 'VALIDATION_ERROR' })
    }
  })

  it('reconciles sale-date, receipt-date, cost, stock and open-purchase metrics without mixing bases', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/reports/financial?from=2026-08-01&to=2026-08-31',
      headers: { cookie: `erp_session=${encodeURIComponent(sessionToken)}` },
    })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      period: { from: '2026-08-01', to: '2026-08-31', timezone: 'America/Sao_Paulo' },
      bases: { sales: 'sale_created_at', cash: 'payment_received_at' },
      salesBySaleDate: '300.00',
      confirmedPaymentsByReceiptDate: '150.00',
      outstandingForPeriodSales: '150.00',
      historicalCostOfPeriodSales: '160.00',
      grossProfitOnSalesBasis: '140.00',
      grossMarginPercentOnSalesBasis: '46.67',
      averageTicketOnSalesBasis: '150.00',
      inventoryCostValue: '150.00',
      inventoryPotentialValue: '300.00',
      openPurchaseCapital: '60.00',
      paymentsByMethod: [{ method: 'pix', amount: '150.00' }],
      updatedAt: expect.any(String),
    })
  })

  it('ranks product variants from immutable sale snapshots while preserving current stock', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/reports/products?from=2026-08-01&to=2026-08-31',
      headers: { cookie: `erp_session=${encodeURIComponent(sessionToken)}` },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      period: { from: '2026-08-01', to: '2026-08-31', timezone: 'America/Sao_Paulo' },
      items: [{
        club: 'Relatório FC',
        currentStockQuantity: 3,
        grossProfit: '140.00',
        historicalCost: '160.00',
        model: 'Base',
        salesAmount: '300.00',
        size: 'M',
        sku: expect.any(String),
        type: 'Masculina',
        unitsSold: 3,
        variantId: expect.any(String),
      }],
    })
  })

  it('returns an operational dashboard with explicit as-of and event-date bases', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/dashboard?date=2026-08-20',
      headers: { cookie: `erp_session=${encodeURIComponent(sessionToken)}` },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      date: '2026-08-20',
      timezone: 'America/Sao_Paulo',
      bases: { sales: 'sale_created_at', cash: 'payment_received_at', pending: 'current_state_as_of_request' },
      salesCreatedToday: '0.00',
      confirmedPaymentsToday: '50.00',
      pendingSalesCount: 1,
      overdueSalesCount: 0,
      lowStockVariants: 0,
      outOfStockVariants: 0,
      openPurchaseOrders: 1,
      pendingPurchaseUnits: 3,
      openCustomerOrders: 0,
    })
  })

  async function seedKnownDataset() {
    const roleId = '00000000-0000-4000-8000-000000000003'
    await pool.query(
      `INSERT INTO users (id, username, display_name, password_hash, role_id)
       VALUES ($1, 'gestor.relatorios', 'Gestor Relatórios', 'unused', $2)`,
      [userId, roleId],
    )
    await pool.query(
      `INSERT INTO sessions (id, user_id, token_hash, csrf_hash, expires_at)
       VALUES ($1, $2, $3, $4, now() + interval '1 hour')`,
      [randomUUID(), userId, hashSecret(sessionToken), hashSecret(randomUUID())],
    )
    const productId = randomUUID()
    const variantId = randomUUID()
    await pool.query('INSERT INTO products (id, club, model) VALUES ($1, $2, $3)', [productId, 'Relatório FC', 'Base'])
    await pool.query(
      `INSERT INTO product_variants
         (id, product_id, type, size, sku, sale_price, current_cost, stock_quantity)
       VALUES ($1, $2, 'Masculina', 'M', $3, 100.00, 50.00, 3)`,
      [variantId, productId, randomUUID()],
    )
    const sale1 = randomUUID()
    const sale2 = randomUUID()
    const customerId = randomUUID()
    await pool.query('INSERT INTO customers (id, name) VALUES ($1, $2)', [customerId, 'Cliente Relatório'])
    await pool.query(
      `INSERT INTO sales (id, customer_id, operator_id, status, subtotal_amount, final_amount, payment_due_date, created_at)
       VALUES ($1, NULL, $3, 'paid', 100.00, 100.00, NULL, '2026-08-10T12:00:00Z'),
              ($2, $4, $3, 'partially_paid', 200.00, 200.00, '2026-09-30', '2026-08-15T12:00:00Z')`,
      [sale1, sale2, userId, customerId],
    )
    await pool.query(
      `INSERT INTO sale_items (id, sale_id, variant_id, quantity, unit_price, unit_cost)
       VALUES ($1, $2, $5, 1, 100.00, 60.00), ($3, $4, $5, 2, 100.00, 50.00)`,
      [randomUUID(), sale1, randomUUID(), sale2, variantId],
    )
    await pool.query(
      `INSERT INTO payments (id, sale_id, received_by, amount, method, idempotency_key, received_at)
       VALUES ($1, $2, $5, 100.00, 'pix', $6, '2026-08-10T13:00:00Z'),
              ($3, $4, $5, 50.00, 'pix', $7, '2026-08-20T13:00:00Z')`,
      [randomUUID(), sale1, randomUUID(), sale2, userId, randomUUID(), randomUUID()],
    )
    const supplierId = randomUUID()
    const purchaseId = randomUUID()
    await pool.query('INSERT INTO suppliers (id, name) VALUES ($1, $2)', [supplierId, 'Fornecedor Relatório'])
    await pool.query(
      `INSERT INTO purchase_orders (id, supplier_id, created_by, status, ordered_on, estimated_items_amount, final_amount)
       VALUES ($1, $2, $3, 'partially_received', '2026-08-01', 80.00, 80.00)`,
      [purchaseId, supplierId, userId],
    )
    await pool.query(
      `INSERT INTO purchase_order_items
         (id, purchase_order_id, variant_id, ordered_quantity, received_quantity, supplier_unit_cost, final_unit_cost)
       VALUES ($1, $2, $3, 4, 1, 20.00, 20.00)`,
      [randomUUID(), purchaseId, variantId],
    )
  }
})
