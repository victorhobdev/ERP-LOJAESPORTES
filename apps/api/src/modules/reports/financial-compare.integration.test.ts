import { randomUUID } from 'node:crypto'

import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { buildApp } from '../../app.js'
import { hashSecret } from '../../shared/auth/session.js'
import { applyMigrations } from '../../shared/db/migrate.js'

const connectionString = process.env['TEST_DATABASE_URL']
if (!connectionString) throw new Error('TEST_DATABASE_URL is required for PostgreSQL integration tests.')

type FinancialComparison = {
  period: { from: string; to: string; timezone: string }
  salesBySaleDate: string
  confirmedPaymentsByReceiptDate: string
}
type DailyPoint = { date: string; salesBySaleDate: string; confirmedPaymentsByReceiptDate: string }
type ReceivableRow = { saleId: string; customerDisplay: string; dueDate: string | null; amountDue: string; overdue: boolean }
type FinancialReportBody = {
  salesBySaleDate: string
  confirmedPaymentsByReceiptDate: string
  comparison: FinancialComparison
  dailySeries: DailyPoint[]
  receivables: ReceivableRow[]
  receivablesBasis: string
  overdueAsOf: string
}

describe('financial report compare/series/receivables', () => {
  const adminPool = new Pool({ connectionString, max: 1 })
  const schema = `erp2_test_${randomUUID().replaceAll('-', '')}`
  const userId = randomUUID()
  const sessionToken = randomUUID()
  const operatorId = randomUUID()
  const operatorToken = randomUUID()
  let pool: Pool
  let app: ReturnType<typeof buildApp>
  let curPartialId = ''
  let curPendingId = ''

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

  it('returns equal-length previous period with separate sale and receipt bases', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/reports/financial?from=2026-08-10&to=2026-08-12&compare=true',
      headers: { cookie: `erp_session=${encodeURIComponent(sessionToken)}` },
    })
    expect(response.statusCode).toBe(200)
    const body = response.json() as unknown as FinancialReportBody
    expect(body.salesBySaleDate).toBe('250.00')
    expect(body.confirmedPaymentsByReceiptDate).toBe('80.00')
    expect(body.comparison.period).toEqual({ from: '2026-08-07', to: '2026-08-09', timezone: 'America/Sao_Paulo' })
    expect(body.comparison.salesBySaleDate).toBe('100.00')
    expect(body.comparison.confirmedPaymentsByReceiptDate).toBe('100.00')
  })

  it('returns zero-filled daily series with separate bases', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/reports/financial?from=2026-08-10&to=2026-08-12',
      headers: { cookie: `erp_session=${encodeURIComponent(sessionToken)}` },
    })
    expect(response.statusCode).toBe(200)
    const body = response.json() as unknown as FinancialReportBody
    expect(body.dailySeries).toEqual([
      { date: '2026-08-10', salesBySaleDate: '200.00', confirmedPaymentsByReceiptDate: '0.00' },
      { date: '2026-08-11', salesBySaleDate: '0.00', confirmedPaymentsByReceiptDate: '80.00' },
      { date: '2026-08-12', salesBySaleDate: '50.00', confirmedPaymentsByReceiptDate: '0.00' },
    ])
  })

  it('returns period receivables with drilldown data and overdue flags', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/reports/financial?from=2026-08-10&to=2026-08-12',
      headers: { cookie: `erp_session=${encodeURIComponent(sessionToken)}` },
    })
    expect(response.statusCode).toBe(200)
    const body = response.json() as unknown as FinancialReportBody
    expect(body.receivablesBasis).toContain('created')
    expect(body.overdueAsOf).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    const rows = body.receivables
    expect(rows).toHaveLength(2)
    const partial = rows.find((r) => r.saleId === curPartialId)!
    expect(partial).toMatchObject({ customerDisplay: 'Cliente Parcial', amountDue: '120.00', overdue: false })
    const pending = rows.find((r) => r.saleId === curPendingId)!
    expect(pending).toMatchObject({ customerDisplay: 'Cliente Pendente', amountDue: '50.00', overdue: true })
  })

  it('validates period and compare without leaking internals', async () => {
    for (const url of [
      '/reports/financial?from=2026-08-12&to=2026-08-10',
      '/reports/financial?from=invalid&to=2026-08-12',
      '/reports/financial?from=2026-08-10&to=2026-08-12&compare=maybe',
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

  it('keeps the report fully permission-gated without cost exposure', async () => {
    const anon = await app.inject({ method: 'GET', url: '/reports/financial?from=2026-08-10&to=2026-08-12' })
    expect(anon.statusCode).toBe(401)
    const forbidden = await app.inject({
      method: 'GET',
      url: '/reports/financial?from=2026-08-10&to=2026-08-12&compare=true',
      headers: { cookie: `erp_session=${encodeURIComponent(operatorToken)}` },
    })
    expect(forbidden.statusCode).toBe(403)
    expect(JSON.stringify(forbidden.json())).not.toContain('historicalCost')
    expect(JSON.stringify(forbidden.json())).not.toContain('grossProfit')
  })

  async function seed() {
    const managerRole = '00000000-0000-4000-8000-000000000003'
    const operatorRole = '00000000-0000-4000-8000-000000000001'
    await pool.query(
      `INSERT INTO users (id, username, display_name, password_hash, role_id) VALUES
        ($1, 'gestor.fin', 'Gestor Fin', 'unused', $2),
        ($3, 'operador.fin', 'Operador Fin', 'unused', $4)`,
      [userId, managerRole, operatorId, operatorRole],
    )
    await pool.query(
      `INSERT INTO sessions (id, user_id, token_hash, csrf_hash, expires_at) VALUES
        ($1, $2, $3, $4, now() + interval '1 hour'),
        ($5, $6, $7, $4, now() + interval '1 hour')`,
      [randomUUID(), userId, hashSecret(sessionToken), hashSecret(randomUUID()), randomUUID(), operatorId, hashSecret(operatorToken)],
    )
    const productId = randomUUID()
    const variantId = randomUUID()
    await pool.query('INSERT INTO products (id, club, model) VALUES ($1, $2, $3)', [productId, 'Fin FC', 'Base'])
    await pool.query(
      `INSERT INTO product_variants (id, product_id, type, size, sku, sale_price, current_cost, stock_quantity)
       VALUES ($1, $2, 'Masculina', 'M', $3, 100.00, 40.00, 10)`,
      [variantId, productId, randomUUID()],
    )
    const prevId = randomUUID()
    curPartialId = randomUUID()
    curPendingId = randomUUID()
    const partialCustomer = randomUUID()
    const pendingCustomer = randomUUID()
    await pool.query('INSERT INTO customers (id, name) VALUES ($1, $2), ($3, $4)', [partialCustomer, 'Cliente Parcial', pendingCustomer, 'Cliente Pendente'])
    await pool.query(
      `INSERT INTO sales (id, customer_id, operator_id, status, subtotal_amount, final_amount, payment_due_date, created_at)
       VALUES ($1, NULL, $4, 'paid', 100.00, 100.00, NULL, '2026-08-08T12:00:00Z'),
              ($2, $5, $4, 'partially_paid', 200.00, 200.00, '2099-01-01', '2026-08-10T12:00:00Z'),
              ($3, $6, $4, 'pending', 50.00, 50.00, '2026-08-05', '2026-08-12T12:00:00Z')`,
      [prevId, curPartialId, curPendingId, userId, partialCustomer, pendingCustomer],
    )
    await pool.query(
      `INSERT INTO sale_items (id, sale_id, variant_id, quantity, unit_price, unit_cost)
       VALUES ($1, $2, $3, 1, 100.00, 40.00), ($4, $5, $3, 2, 100.00, 40.00), ($6, $7, $3, 1, 50.00, 20.00)`,
      [randomUUID(), prevId, variantId, randomUUID(), curPartialId, randomUUID(), curPendingId],
    )
    await pool.query(
      `INSERT INTO payments (id, sale_id, received_by, amount, method, idempotency_key, received_at)
       VALUES ($1, $2, $3, 100.00, 'pix', $4, '2026-08-08T13:00:00Z'),
              ($5, $6, $3, 80.00, 'pix', $7, '2026-08-11T13:00:00Z')`,
      [randomUUID(), prevId, userId, randomUUID(), randomUUID(), curPartialId, randomUUID()],
    )
  }
})
