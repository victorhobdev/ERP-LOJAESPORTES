import { randomUUID } from 'node:crypto'

import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { buildApp } from '../../app.js'
import { hashSecret } from '../../shared/auth/session.js'
import { applyMigrations } from '../../shared/db/migrate.js'

const connectionString = process.env['TEST_DATABASE_URL']
if (!connectionString) throw new Error('TEST_DATABASE_URL is required for PostgreSQL integration tests.')

type FinancialBody = {
  salesBySaleDate: string
  historicalCostOfPeriodSales: string
  grossProfitOnSalesBasis: string
  grossMarginPercentOnSalesBasis: string
}

describe('financial report limits and edge arithmetic', () => {
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

  it('rejects ranges over 366 inclusive days', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/reports/financial?from=2025-01-01&to=2026-01-02',
      headers: { cookie: `erp_session=${encodeURIComponent(sessionToken)}` },
    })
    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ code: 'VALIDATION_ERROR' })
  })

  it('rejects ranges whose previous period would leave the supported civil range', async () => {
    for (const url of [
      '/reports/financial?from=0001-01-01&to=0001-01-03',
      '/reports/financial?from=0000-06-01&to=0000-06-02',
    ]) {
      const response = await app.inject({
        method: 'GET',
        url,
        headers: { cookie: `erp_session=${encodeURIComponent(sessionToken)}` },
      })
      expect(response.statusCode).toBe(400)
      expect(response.json()).toMatchObject({ code: 'VALIDATION_ERROR' })
    }
  })

  it('sums near-limit column values without overflow', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/reports/financial?from=2025-05-01&to=2025-05-03',
      headers: { cookie: `erp_session=${encodeURIComponent(sessionToken)}` },
    })
    expect(response.statusCode).toBe(200)
    const body = response.json() as unknown as FinancialBody
    expect(body.salesBySaleDate).toBe('1999999999999.98')
  })

  it('rounds negative profit and margin symmetrically', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/reports/financial?from=2025-06-01&to=2025-06-02',
      headers: { cookie: `erp_session=${encodeURIComponent(sessionToken)}` },
    })
    expect(response.statusCode).toBe(200)
    const body = response.json() as unknown as FinancialBody
    expect(body.salesBySaleDate).toBe('100.00')
    expect(body.historicalCostOfPeriodSales).toBe('160.00')
    expect(body.grossProfitOnSalesBasis).toBe('-60.00')
    expect(body.grossMarginPercentOnSalesBasis).toBe('-60.00')
  })

  async function seed() {
    const managerRole = '00000000-0000-4000-8000-000000000003'
    await pool.query(
      `INSERT INTO users (id, username, display_name, password_hash, role_id)
       VALUES ($1, 'gestor.limites', 'Gestor Limites', 'unused', $2)`,
      [userId, managerRole],
    )
    await pool.query(
      `INSERT INTO sessions (id, user_id, token_hash, csrf_hash, expires_at)
       VALUES ($1, $2, $3, $4, now() + interval '1 hour')`,
      [randomUUID(), userId, hashSecret(sessionToken), hashSecret(randomUUID())],
    )
    const productId = randomUUID()
    const variantId = randomUUID()
    await pool.query('INSERT INTO products (id, club, model) VALUES ($1, $2, $3)', [productId, 'Limites FC', 'Base'])
    await pool.query(
      `INSERT INTO product_variants (id, product_id, type, size, sku, sale_price, current_cost, stock_quantity)
       VALUES ($1, $2, 'Masculina', 'M', $3, 100.00, 40.00, 10)`,
      [variantId, productId, randomUUID()],
    )
    const big1 = randomUUID()
    const big2 = randomUUID()
    const loss = randomUUID()
    await pool.query(
      `INSERT INTO sales (id, customer_id, operator_id, status, subtotal_amount, final_amount, payment_due_date, created_at)
       VALUES ($1, NULL, $4, 'paid', 999999999999.99, 999999999999.99, NULL, '2025-05-02T12:00:00Z'),
              ($2, NULL, $4, 'paid', 999999999999.99, 999999999999.99, NULL, '2025-05-02T12:00:00Z'),
              ($3, NULL, $4, 'paid', 100.00, 100.00, NULL, '2025-06-01T12:00:00Z')`,
      [big1, big2, loss, userId],
    )
    await pool.query(
      `INSERT INTO sale_items (id, sale_id, variant_id, quantity, unit_price, unit_cost)
       VALUES ($1, $2, $3, 1, 100.00, 160.00)`,
      [randomUUID(), loss, variantId],
    )
  }
})
