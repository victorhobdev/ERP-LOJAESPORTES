import { randomUUID } from 'node:crypto'

import { Pool } from 'pg'

import { hashPassword } from '../src/shared/auth/password.js'
import { applyMigrations } from '../src/shared/db/migrate.js'
import { assertTestDatabaseUrl } from './lib/assert-test-database.js'

const databaseUrl = process.env['E2E_DATABASE_URL']
if (!databaseUrl) throw new Error('E2E_DATABASE_URL is required (exclusively a test database).')
await assertTestDatabaseUrl(databaseUrl)

const tag = randomUUID().slice(0, 8)
const username = `e2e.vendas.${tag}`
const password = process.env['E2E_PASSWORD'] ?? 'E2e-Vendas-Sintetico-1!'

const pool = new Pool({ connectionString: databaseUrl, max: 2 })
try {
  await applyMigrations(pool)
  const userId = randomUUID()
  await pool.query(
    `INSERT INTO users (id, username, display_name, password_hash, role_id)
     VALUES ($1, $2, $3, $4, '00000000-0000-4000-8000-000000000004')`,
    [userId, username, 'Gestor Vendas E2E', await hashPassword(password)],
  )
  const customerId = randomUUID()
  await pool.query('INSERT INTO customers (id, name) VALUES ($1, $2)', [customerId, `Cliente E2E ${tag}`])
  const productId = randomUUID()
  const variantId = randomUUID()
  await pool.query('INSERT INTO products (id, club, model) VALUES ($1, $2, $3)', [productId, 'E2E Vendas FC', `Modelo ${tag}`])
  await pool.query(
    `INSERT INTO product_variants (id, product_id, type, size, sku, sale_price, current_cost, stock_quantity)
     VALUES ($1, $2, 'Masculina', 'M', $3, 150.00, 80.00, 5)`,
    [variantId, productId, `EVN-M-${tag}`],
  )
  const saleId = randomUUID()
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(
      `INSERT INTO sales (id, customer_id, operator_id, status, subtotal_amount, discount_amount, final_amount, payment_due_date)
       VALUES ($1, $2, $3, 'pending', 150.00, 0.00, 150.00, CURRENT_DATE + 30)`,
      [saleId, customerId, userId],
    )
    await client.query(
      `INSERT INTO sale_items (id, sale_id, variant_id, quantity, unit_price, unit_cost)
       VALUES ($1, $2, $3, 1, 150.00, 80.00)`,
      [randomUUID(), saleId, variantId],
    )
    await client.query(`UPDATE product_variants SET stock_quantity = 4, version = version + 1 WHERE id = $1`, [variantId])
    await client.query(
      `INSERT INTO inventory_movements (id, variant_id, type, quantity_delta, balance_after, source_entity_type, source_entity_id, idempotency_key, user_id)
       VALUES ($1, $2, 'sale', -1, 4, 'sale', $3, $4, $5)`,
      [randomUUID(), variantId, saleId, `sales:${saleId}:${variantId}`, userId],
    )
    await client.query(
      `INSERT INTO audit_log (id, user_id, action, entity_type, entity_id, request_id, after_data)
       VALUES ($1, $2, 'sale.create', 'sale', $3, $4, $5)`,
      [randomUUID(), userId, saleId, randomUUID(), JSON.stringify({ status: 'pending', finalAmount: '150.00' })],
    )
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
  process.stdout.write(`${JSON.stringify({ username, password, userId, tag, customerId, productId, variantId, saleId })}\n`)
} finally {
  await pool.end()
}
