import { randomUUID } from 'node:crypto'

import { Pool } from 'pg'

import { hashPassword } from '../src/shared/auth/password.js'
import { applyMigrations } from '../src/shared/db/migrate.js'
import { assertTestDatabaseUrl } from './lib/assert-test-database.js'

const databaseUrl = process.env['E2E_DATABASE_URL']
if (!databaseUrl) throw new Error('E2E_DATABASE_URL is required (exclusively a test database).')
await assertTestDatabaseUrl(databaseUrl)

const tag = randomUUID().slice(0, 8)
const username = `e2e.fin.${tag}`
const password = process.env['E2E_PASSWORD'] ?? 'E2e-Fin-Sintetico-1!'

const pool = new Pool({ connectionString: databaseUrl, max: 2 })
try {
  await applyMigrations(pool)
  const userId = randomUUID()
  await pool.query(
    `INSERT INTO users (id, username, display_name, password_hash, role_id)
     VALUES ($1, $2, $3, $4, '00000000-0000-4000-8000-000000000004')`,
    [userId, username, 'Gestor Financeiro E2E', await hashPassword(password)],
  )
  const productId = randomUUID()
  const variantId = randomUUID()
  await pool.query('INSERT INTO products (id, club, model) VALUES ($1, $2, $3)', [productId, 'E2E Fin FC', `Modelo ${tag}`])
  await pool.query(
    `INSERT INTO product_variants (id, product_id, type, size, sku, sale_price, current_cost, stock_quantity)
     VALUES ($1, $2, 'Masculina', 'M', $3, 100.00, 40.00, 10)`,
    [variantId, productId, `EFIN-M-${tag}`],
  )
  const base = new Date('2001-01-01T00:00:00Z').getTime()
  const maxWindowAttempts = 500
  const startOffset = parseInt(tag, 16) % 1500
  const formatDay = (offset: number): string => new Date(base + offset * 86_400_000).toISOString().slice(0, 10)
  let prevFrom = ''
  let prevTo = ''
  let prevDate = ''
  let from = ''
  let mid = ''
  let to = ''
  let attempts = 0
  for (; attempts < maxWindowAttempts; attempts += 1) {
    const offset = startOffset + attempts * 7
    const candidatePrevFrom = formatDay(offset)
    const candidateTo = formatDay(offset + 5)
    const collision = await pool.query<{ sales: string; payments: string }>(
      `SELECT (SELECT count(*) FROM sales
                WHERE (created_at AT TIME ZONE 'America/Sao_Paulo')::date BETWEEN $1 AND $2)::text AS sales,
              (SELECT count(*) FROM payments
                WHERE (received_at AT TIME ZONE 'America/Sao_Paulo')::date BETWEEN $1 AND $2)::text AS payments`,
      [candidatePrevFrom, candidateTo],
    )
    if (collision.rows[0]!.sales === '0' && collision.rows[0]!.payments === '0') {
      prevFrom = candidatePrevFrom
      prevTo = formatDay(offset + 2)
      prevDate = formatDay(offset + 1)
      from = formatDay(offset + 3)
      mid = formatDay(offset + 4)
      to = candidateTo
      break
    }
  }
  if (prevFrom === '') {
    throw new Error(`Nenhuma janela livre de 6 dias encontrada em erp2_test após ${maxWindowAttempts} tentativas.`)
  }
  const prevSaleId = randomUUID()
  const partialSaleId = randomUUID()
  const pendingSaleId = randomUUID()
  const partialCustomerId = randomUUID()
  const pendingCustomerId = randomUUID()
  await pool.query('INSERT INTO customers (id, name) VALUES ($1, $2), ($3, $4)', [
    partialCustomerId,
    `Cliente Parcial ${tag}`,
    pendingCustomerId,
    `Cliente Pendente ${tag}`,
  ])
  await pool.query(
    `INSERT INTO sales (id, customer_id, operator_id, status, subtotal_amount, final_amount, payment_due_date, created_at)
     VALUES ($1, NULL, $4, 'paid', 100.00, 100.00, NULL, $7),
            ($2, $5, $4, 'partially_paid', 200.00, 200.00, '2099-01-01', $8),
            ($3, $6, $4, 'pending', 50.00, 50.00, '2024-01-01', $9)`,
    [prevSaleId, partialSaleId, pendingSaleId, userId, partialCustomerId, pendingCustomerId, `${prevDate}T12:00:00Z`, `${from}T12:00:00Z`, `${to}T12:00:00Z`],
  )
  await pool.query(
    `INSERT INTO sale_items (id, sale_id, variant_id, quantity, unit_price, unit_cost)
     VALUES ($1, $2, $3, 1, 100.00, 40.00), ($4, $5, $3, 2, 100.00, 40.00), ($6, $7, $3, 1, 50.00, 20.00)`,
    [randomUUID(), prevSaleId, variantId, randomUUID(), partialSaleId, randomUUID(), pendingSaleId],
  )
  await pool.query(
    `INSERT INTO payments (id, sale_id, received_by, amount, method, idempotency_key, received_at)
     VALUES ($1, $2, $3, 100.00, 'pix', $4, $5),
            ($6, $7, $3, 80.00, 'pix', $8, $9)`,
    [randomUUID(), prevSaleId, userId, randomUUID(), `${prevDate}T13:00:00Z`, randomUUID(), partialSaleId, randomUUID(), `${mid}T13:00:00Z`],
  )
  const counts = await pool.query<{ sales: string; payments: string; audits: string }>(
    `SELECT (SELECT count(*) FROM sales)::text AS sales,
            (SELECT count(*) FROM payments)::text AS payments,
            (SELECT count(*) FROM audit_log WHERE action NOT LIKE 'auth.%')::text AS audits`,
  )
  process.stdout.write(
    `${JSON.stringify({
      username,
      password,
      userId,
      tag,
      variantId,
      prevSaleId,
      partialSaleId,
      pendingSaleId,
      from,
      mid,
      to,
      prevFrom,
      prevTo,
      sales: counts.rows[0]!.sales,
      payments: counts.rows[0]!.payments,
      audits: counts.rows[0]!.audits,
    })}\n`,
  )
} finally {
  await pool.end()
}
