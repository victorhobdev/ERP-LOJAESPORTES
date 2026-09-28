import { randomUUID } from 'node:crypto'

import { Pool } from 'pg'

import { hashPassword } from '../src/shared/auth/password.js'
import { applyMigrations } from '../src/shared/db/migrate.js'
import { assertTestDatabaseUrl } from './lib/assert-test-database.js'

const databaseUrl = process.env['E2E_DATABASE_URL']
if (!databaseUrl) throw new Error('E2E_DATABASE_URL is required (exclusively a test database).')
await assertTestDatabaseUrl(databaseUrl)

const tag = randomUUID().slice(0, 8)
const username = `e2e.encomendas.${tag}`
const password = process.env['E2E_PASSWORD'] ?? 'E2e-Encomendas-Sintetico-1!'

const pool = new Pool({ connectionString: databaseUrl, max: 2 })
try {
  await applyMigrations(pool)
  const userId = randomUUID()
  await pool.query(
    `INSERT INTO users (id, username, display_name, password_hash, role_id)
     VALUES ($1, $2, $3, $4, '00000000-0000-4000-8000-000000000003')`,
    [userId, username, 'Gestor Encomendas E2E', await hashPassword(password)],
  )
  const customerId = randomUUID()
  await pool.query('INSERT INTO customers (id, name, contact) VALUES ($1, $2, $3)', [customerId, `Cliente E2E ${tag}`, `contato-${tag}`])
  const productId = randomUUID()
  const variantId = randomUUID()
  await pool.query('INSERT INTO products (id, club, model) VALUES ($1, $2, $3)', [productId, 'E2E Encomenda FC', `Modelo ${tag}`])
  await pool.query(
    `INSERT INTO product_variants (id, product_id, type, size, sku, sale_price, current_cost, stock_quantity)
     VALUES ($1, $2, 'Masculina', 'M', $3, 150.00, 80.00, 10)`,
    [variantId, productId, `EEN-M-${tag}`],
  )
  process.stdout.write(`${JSON.stringify({ username, password, userId, tag, customerId, productId, variantId })}\n`)
} finally {
  await pool.end()
}
