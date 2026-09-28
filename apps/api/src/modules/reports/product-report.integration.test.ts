import { randomUUID } from 'node:crypto'

import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { buildApp } from '../../app.js'
import { hashSecret } from '../../shared/auth/session.js'
import { applyMigrations } from '../../shared/db/migrate.js'

const connectionString = process.env['TEST_DATABASE_URL']
if (!connectionString) throw new Error('TEST_DATABASE_URL is required for PostgreSQL integration tests.')

type ProductItem = {
  variantId: string
  club: string
  model: string
  type: string
  size: string
  sku: string
  currentStockQuantity: number
  lowStockThreshold: number
  unitsSold: string
  salesAmount: string
  historicalCost: string
  grossProfit: string
  noTurnover: boolean
  lowStock: boolean
}
type Ranking = { name: string; unitsSold: string; salesAmount: string; sharePercent: string }
type ProductReportBody = {
  period: { from: string; to: string; timezone: string }
  filters: { club: string | null; type: string | null; size: string | null }
  timezone: string
  bases: { sales: string; stock: string }
  items: ProductItem[]
  summary: {
    variantCount: number
    totalUnitsSold: string
    totalSalesAmount: string
    totalGrossProfit: string
    noTurnoverCount: number
    lowStockCount: number
    salesByClub: Ranking[]
    salesByType: Ranking[]
    salesBySize: Ranking[]
  }
  updatedAt: string
  stockAsOf: string
}

describe('product report per variant with turnover flags', () => {
  const adminPool = new Pool({ connectionString, max: 1 })
  const schema = `erp2_test_${randomUUID().replaceAll('-', '')}`
  const userId = randomUUID()
  const sessionToken = randomUUID()
  const operatorId = randomUUID()
  const operatorToken = randomUUID()
  let pool: Pool
  let app: ReturnType<typeof buildApp>

  beforeAll(async () => {
    const current = await adminPool.query<{ current_database: string }>('SELECT current_database()')
    if (current.rows[0]?.current_database !== 'erp2_test') throw new Error('Integration tests refuse to run outside erp2_test.')
    await adminPool.query(`CREATE SCHEMA "${schema}"`)
    pool = new Pool({ connectionString, max: 4, options: `-c search_path=${schema}` })
    await applyMigrations(pool)
    await seed()
    app = buildApp({ pool, logger: false, secureCookies: false })
    await app.ready()
  }, 60_000)

  afterAll(async () => {
    await app?.close()
    await pool?.end()
    if (schema.startsWith('erp2_test_')) await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`)
    await adminPool.end()
  })

  it('lists active variants with snapshots, turnover flags, bases and a coherent summary', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/reports/products?from=2026-08-01&to=2026-08-31',
      headers: { cookie: `erp_session=${encodeURIComponent(sessionToken)}` },
    })
    expect(response.statusCode).toBe(200)
    const body = response.json() as unknown as ProductReportBody
    expect(body.period).toEqual({ from: '2026-08-01', to: '2026-08-31', timezone: 'America/Sao_Paulo' })
    expect(body.filters).toEqual({ club: null, type: null, size: null })
    expect(body.bases).toEqual({ sales: 'sale_created_at', stock: 'current_state_as_of_request' })
    expect(new Date(body.updatedAt).toISOString()).toBe(body.updatedAt)
    expect(new Date(body.stockAsOf).toISOString()).toBe(body.stockAsOf)
    expect(body.items).toHaveLength(5)
    const [first, second] = body.items
    expect(first!.club).toBe('Atlas FC')
    expect(first!.unitsSold).toBe('2')
    expect(first!).toMatchObject({
      salesAmount: '200.00',
      historicalCost: '120.00',
      grossProfit: '80.00',
      currentStockQuantity: 2,
      lowStockThreshold: 5,
      noTurnover: false,
      lowStock: true,
    })
    expect(second!.club).toBe('Boreal SC')
    expect(second!).toMatchObject({ unitsSold: '1', salesAmount: '50.00', noTurnover: false, lowStock: false })
    const idle = body.items.slice(2)
    expect(idle).toHaveLength(3)
    for (const row of idle) {
      expect(row).toMatchObject({ unitsSold: '0', salesAmount: '0.00', noTurnover: true })
    }
    expect(idle.map((row) => row.club).sort()).toEqual(['Atlas FC', 'Ticket EC', 'Volume EC'])
    expect(body.summary).toMatchObject({
      variantCount: 5,
      totalUnitsSold: '3',
      totalSalesAmount: '250.00',
      totalGrossProfit: '110.00',
      noTurnoverCount: 3,
      lowStockCount: 1,
    })
    expect(body.summary.salesByClub).toEqual([
      { name: 'Atlas FC', unitsSold: '2', salesAmount: '200.00', sharePercent: '80.00' },
      { name: 'Boreal SC', unitsSold: '1', salesAmount: '50.00', sharePercent: '20.00' },
      { name: 'Ticket EC', unitsSold: '0', salesAmount: '0.00', sharePercent: '0.00' },
      { name: 'Volume EC', unitsSold: '0', salesAmount: '0.00', sharePercent: '0.00' },
    ])
    expect(body.summary.salesByType).toEqual([
      { name: 'Masculina', unitsSold: '2', salesAmount: '200.00', sharePercent: '80.00' },
      { name: 'Infantil', unitsSold: '1', salesAmount: '50.00', sharePercent: '20.00' },
      { name: 'Feminina', unitsSold: '0', salesAmount: '0.00', sharePercent: '0.00' },
    ])
    expect(body.summary.salesBySize).toEqual([
      { name: 'M', unitsSold: '2', salesAmount: '200.00', sharePercent: '80.00' },
      { name: '10', unitsSold: '1', salesAmount: '50.00', sharePercent: '20.00' },
      { name: 'G', unitsSold: '0', salesAmount: '0.00', sharePercent: '0.00' },
      { name: 'P', unitsSold: '0', salesAmount: '0.00', sharePercent: '0.00' },
    ])
  })

  it('ranks by units sold even when the revenue leader differs', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/reports/products?from=2025-10-01&to=2025-10-02',
      headers: { cookie: `erp_session=${encodeURIComponent(sessionToken)}` },
    })
    expect(response.statusCode).toBe(200)
    const body = response.json() as unknown as ProductReportBody
    expect(body.summary.totalUnitsSold).toBe('101')
    expect(body.summary.totalSalesAmount).toBe('600.00')
    expect(body.summary.salesByClub).toEqual([
      { name: 'Volume EC', unitsSold: '100', salesAmount: '100.00', sharePercent: '16.67' },
      { name: 'Ticket EC', unitsSold: '1', salesAmount: '500.00', sharePercent: '83.33' },
      { name: 'Atlas FC', unitsSold: '0', salesAmount: '0.00', sharePercent: '0.00' },
      { name: 'Boreal SC', unitsSold: '0', salesAmount: '0.00', sharePercent: '0.00' },
    ])
    expect(body.summary.salesBySize).toEqual([
      { name: 'P', unitsSold: '100', salesAmount: '100.00', sharePercent: '16.67' },
      { name: 'G', unitsSold: '1', salesAmount: '500.00', sharePercent: '83.33' },
      { name: '10', unitsSold: '0', salesAmount: '0.00', sharePercent: '0.00' },
      { name: 'M', unitsSold: '0', salesAmount: '0.00', sharePercent: '0.00' },
    ])
  })

  it('preserves exact counts above the 32-bit integer range', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/reports/products?from=2025-09-01&to=2025-09-02',
      headers: { cookie: `erp_session=${encodeURIComponent(sessionToken)}` },
    })
    expect(response.statusCode).toBe(200)
    const body = response.json() as unknown as ProductReportBody
    const bulk = body.items.find((item) => item.club === 'Volume EC' && item.size === 'P')
    expect(bulk).toMatchObject({ unitsSold: '3000000000', salesAmount: '3000000000.00' })
    expect(body.summary.totalUnitsSold).toBe('3000000000')
    expect(body.summary.totalSalesAmount).toBe('3000000000.00')
  })

  it('applies optional club, type and size filters without interpolating input', async () => {
    const session = { cookie: `erp_session=${encodeURIComponent(sessionToken)}` }
    const club = await app.inject({ method: 'GET', url: '/reports/products?from=2026-08-01&to=2026-08-31&club=atlas', headers: session })
    expect(club.statusCode).toBe(200)
    const clubBody = club.json() as unknown as ProductReportBody
    expect(clubBody.filters).toMatchObject({ club: 'atlas', type: null, size: null })
    expect(clubBody.items.map((item) => item.type).sort()).toEqual(['Feminina', 'Masculina'])
    expect(clubBody.summary.variantCount).toBe(2)

    const type = await app.inject({ method: 'GET', url: '/reports/products?from=2026-08-01&to=2026-08-31&type=Infantil', headers: session })
    const typeBody = type.json() as unknown as ProductReportBody
    expect(typeBody.items).toHaveLength(2)
    expect(typeBody.items.find((item) => item.club === 'Boreal SC')).toMatchObject({ unitsSold: '1' })

    const size = await app.inject({ method: 'GET', url: '/reports/products?from=2026-08-01&to=2026-08-31&size=M', headers: session })
    expect((size.json() as unknown as ProductReportBody).items).toHaveLength(1)

    const injection = await app.inject({
      method: 'GET',
      url: `/reports/products?from=2026-08-01&to=2026-08-31&club=${encodeURIComponent(`' OR '1'='1`)}`,
      headers: session,
    })
    expect(injection.statusCode).toBe(200)
    expect((injection.json() as unknown as ProductReportBody).items).toHaveLength(0)
  })

  it('validates period range and keeps the route permission-gated', async () => {
    const anon = await app.inject({ method: 'GET', url: '/reports/products?from=2026-08-01&to=2026-08-31' })
    expect(anon.statusCode).toBe(401)
    const forbidden = await app.inject({
      method: 'GET',
      url: '/reports/products?from=2026-08-01&to=2026-08-31',
      headers: { cookie: `erp_session=${encodeURIComponent(operatorToken)}` },
    })
    expect(forbidden.statusCode).toBe(403)
    for (const url of [
      '/reports/products?from=2026-08-31&to=2026-08-01',
      '/reports/products?from=2025-01-01&to=2026-01-02',
      '/reports/products?from=invalid&to=2026-08-31',
    ]) {
      const invalid = await app.inject({
        method: 'GET',
        url,
        headers: { cookie: `erp_session=${encodeURIComponent(sessionToken)}` },
      })
      expect(invalid.statusCode).toBe(400)
      expect(invalid.json()).toMatchObject({ code: 'VALIDATION_ERROR' })
    }
  })

  async function seed() {
    const managerRole = '00000000-0000-4000-8000-000000000003'
    const operatorRole = '00000000-0000-4000-8000-000000000001'
    await pool.query(
      `INSERT INTO users (id, username, display_name, password_hash, role_id) VALUES
        ($1, 'gestor.produtos', 'Gestor Produtos', 'unused', $2),
        ($3, 'operador.produtos', 'Operador Produtos', 'unused', $4)`,
      [userId, managerRole, operatorId, operatorRole],
    )
    await pool.query(
      `INSERT INTO sessions (id, user_id, token_hash, csrf_hash, expires_at) VALUES
        ($1, $2, $3, $4, now() + interval '1 hour'),
        ($5, $6, $7, $4, now() + interval '1 hour')`,
      [randomUUID(), userId, hashSecret(sessionToken), hashSecret(randomUUID()), randomUUID(), operatorId, hashSecret(operatorToken)],
    )
    const productA = randomUUID()
    const productB = randomUUID()
    const hiddenProduct = randomUUID()
    const productVolume = randomUUID()
    const productTicket = randomUUID()
    await pool.query('INSERT INTO products (id, club, model) VALUES ($1, $2, $3), ($4, $5, $6), ($7, $8, $9), ($10, $11, $12), ($13, $14, $15)', [
      productA, 'Atlas FC', 'Home', productB, 'Boreal SC', 'Away', hiddenProduct, 'Oculto EC', 'Base',
      productVolume, 'Volume EC', 'Base', productTicket, 'Ticket EC', 'Base',
    ])
    await pool.query('UPDATE products SET active = false WHERE id = $1', [hiddenProduct])
    const variantA1 = randomUUID()
    const variantA2 = randomUUID()
    const variantB1 = randomUUID()
    const variantHidden = randomUUID()
    const variantVolume = randomUUID()
    const variantTicket = randomUUID()
    await pool.query(
      `INSERT INTO product_variants (id, product_id, type, size, sku, sale_price, current_cost, stock_quantity, low_stock_threshold)
       VALUES ($1, $2, 'Masculina', 'M', $3, 100.00, 60.00, 2, 5),
              ($4, $2, 'Feminina', 'G', $5, 120.00, 70.00, 0, 3),
              ($6, $7, 'Infantil', '10', $8, 50.00, 20.00, 10, 2),
              ($9, $10, 'Masculina', 'G', $11, 90.00, 40.00, 4, 1),
              ($12, $13, 'Feminina', 'P', $14, 1.00, 0.50, 50, 5),
              ($15, $16, 'Infantil', 'G', $17, 500.00, 200.00, 7, 2)`,
      [
        variantA1, productA, randomUUID(), variantA2, randomUUID(), variantB1, productB, randomUUID(),
        variantHidden, hiddenProduct, randomUUID(), variantVolume, productVolume, randomUUID(),
        variantTicket, productTicket, randomUUID(),
      ],
    )
    const paid = randomUUID()
    const reversed = randomUUID()
    const outside = randomUUID()
    const volumeSale = randomUUID()
    const ticketSale = randomUUID()
    const bulkSale = randomUUID()
    await pool.query(
      `INSERT INTO sales (id, customer_id, operator_id, status, subtotal_amount, final_amount, payment_due_date, created_at)
       VALUES ($1, NULL, $2, 'paid', 250.00, 250.00, NULL, '2026-08-10T12:00:00Z'),
              ($3, NULL, $2, 'reversed', 500.00, 500.00, NULL, '2026-08-11T12:00:00Z'),
              ($4, NULL, $2, 'paid', 1000.00, 1000.00, NULL, '2026-07-10T12:00:00Z'),
              ($5, NULL, $2, 'paid', 100.00, 100.00, NULL, '2025-10-01T12:00:00Z'),
              ($6, NULL, $2, 'paid', 500.00, 500.00, NULL, '2025-10-01T12:00:00Z'),
              ($7, NULL, $2, 'paid', 3000000000.00, 3000000000.00, NULL, '2025-09-01T12:00:00Z')`,
      [paid, userId, reversed, outside, volumeSale, ticketSale, bulkSale],
    )
    await pool.query(
      `INSERT INTO sale_items (id, sale_id, variant_id, quantity, unit_price, unit_cost)
       VALUES ($1, $2, $3, 2, 100.00, 60.00),
              ($4, $2, $5, 1, 50.00, 20.00),
              ($6, $7, $3, 5, 100.00, 60.00),
              ($8, $9, $3, 10, 100.00, 60.00),
              ($10, $11, $12, 100, 1.00, 0.50),
              ($13, $14, $15, 1, 500.00, 200.00),
              ($16, $17, $12, 1500000000, 1.00, 0.50),
              ($18, $17, $12, 1500000000, 1.00, 0.50)`,
      [
        randomUUID(), paid, variantA1, randomUUID(), variantB1, randomUUID(), reversed, randomUUID(), outside,
        randomUUID(), volumeSale, variantVolume, randomUUID(), ticketSale, variantTicket,
        randomUUID(), bulkSale, randomUUID(),
      ],
    )
    await pool.query('UPDATE product_variants SET sale_price = 200.00, current_cost = 5.00 WHERE id = $1', [variantA1])
  }
})
