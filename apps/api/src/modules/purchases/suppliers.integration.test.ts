import { randomUUID } from 'node:crypto'

import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { buildApp } from '../../app.js'
import { hashSecret } from '../../shared/auth/session.js'
import { applyMigrations } from '../../shared/db/migrate.js'

const connectionString = process.env['TEST_DATABASE_URL']
if (!connectionString) throw new Error('TEST_DATABASE_URL is required for PostgreSQL integration tests.')

describe('suppliers and purchase detail HTTP flow', () => {
  const adminPool = new Pool({ connectionString, max: 1 })
  const schema = `erp2_test_${randomUUID().replaceAll('-', '')}`
  const managerToken = randomUUID()
  const managerCsrf = randomUUID()
  const managerId = randomUUID()
  const operatorToken = randomUUID()
  const operatorCsrf = randomUUID()
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
       VALUES ($1, 'gestor.compras', 'Gestor Compras', 'unused-in-this-test', '00000000-0000-4000-8000-000000000003'),
              ($2, 'operador.compras', 'Operador Compras', 'unused-in-this-test', '00000000-0000-4000-8000-000000000001')`,
      [managerId, operatorId],
    )
    await pool.query(
      `INSERT INTO sessions (id, user_id, token_hash, csrf_hash, expires_at)
       VALUES ($1, $2, $3, $4, now() + interval '1 hour'),
              ($5, $6, $7, $8, now() + interval '1 hour')`,
      [randomUUID(), managerId, hashSecret(managerToken), hashSecret(managerCsrf), randomUUID(), operatorId, hashSecret(operatorToken), hashSecret(operatorCsrf)],
    )
    await pool.query(`INSERT INTO suppliers (id, name, contact) VALUES ($1, 'Fornecedor Ativo', 'ativo'), ($2, 'Fornecedor Inativo', NULL)`, [randomUUID(), randomUUID()])
    await pool.query(`UPDATE suppliers SET active = false WHERE name = 'Fornecedor Inativo'`)
    app = buildApp({ pool, logger: false, secureCookies: false })
    await app.ready()
  }, 120_000)

  afterAll(async () => {
    await app?.close()
    await pool?.end()
    if (schema.startsWith('erp2_test_')) await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`)
    await adminPool.end()
  })

  it('requires authentication and purchases:read for supplier search', async () => {
    expect((await app.inject({ method: 'GET', url: '/suppliers' })).statusCode).toBe(401)

    const denied = await app.inject({ method: 'GET', url: '/suppliers', headers: { cookie: operatorCookie() } })
    expect(denied.statusCode).toBe(403)
  })

  it('lists only active suppliers with minimal fields, filter and limit', async () => {
    const list = await app.inject({ method: 'GET', url: '/suppliers', headers: { cookie: managerCookie() } })
    expect(list.statusCode).toBe(200)
    expect(list.json().items).toHaveLength(1)
    expect(list.json().items[0]).toEqual({ id: expect.any(String), name: 'Fornecedor Ativo', contact: 'ativo' })
    expect(list.json()).toMatchObject({ total: 1 })

    const search = await app.inject({ method: 'GET', url: '/suppliers?search=ativo', headers: { cookie: managerCookie() } })
    expect(search.json().items.map((item: { name: string }) => item.name)).toEqual(['Fornecedor Ativo'])

    const missing = await app.inject({ method: 'GET', url: '/suppliers?search=zzz', headers: { cookie: managerCookie() } })
    expect(missing.json()).toMatchObject({ items: [], total: 0 })

    const badLimit = await app.inject({ method: 'GET', url: '/suppliers?limit=101', headers: { cookie: managerCookie() } })
    expect(badLimit.statusCode).toBe(400)
  })

  it('exposes the supplier name on the order detail', async () => {
    const variantId = await insertVariant(10)
    const supplier = await pool.query<{ id: string }>(`SELECT id FROM suppliers WHERE name = 'Fornecedor Ativo'`)
    const supplierId = supplier.rows[0]!.id
    const created = await app.inject({
      method: 'POST', url: '/purchase-orders',
      payload: {
        supplierId, orderedOn: '2026-09-03', importFeeAmount: '0.00',
        items: [{ variantId, orderedQuantity: 4, supplierUnitCost: '50.00' }],
      },
      headers: { ...managerHeaders(), 'idempotency-key': randomUUID() },
    })
    expect(created.statusCode).toBe(201)

    const detail = await app.inject({ method: 'GET', url: `/purchase-orders/${created.json().id}`, headers: { cookie: managerCookie() } })
    expect(detail.statusCode).toBe(200)
    expect(detail.json()).toMatchObject({ supplierId, supplierName: 'Fornecedor Ativo' })
    expect(detail.json().items[0]).toMatchObject({ orderedQuantity: 4, receivedQuantity: 0, pendingQuantity: 4 })
  })

  function managerHeaders() {
    return { cookie: managerCookie(), 'x-csrf-token': managerCsrf }
  }

  function managerCookie() {
    return `erp_session=${encodeURIComponent(managerToken)}; erp_csrf=${encodeURIComponent(managerCsrf)}`
  }

  function operatorCookie() {
    return `erp_session=${encodeURIComponent(operatorToken)}; erp_csrf=${encodeURIComponent(operatorCsrf)}`
  }

  async function insertVariant(stock: number): Promise<string> {
    const productId = randomUUID()
    const variantId = randomUUID()
    await pool.query('INSERT INTO products (id, club, model) VALUES ($1, $2, $3)', [productId, 'Compra FC', randomUUID()])
    await pool.query(
      `INSERT INTO product_variants (id, product_id, type, size, sku, sale_price, current_cost, stock_quantity)
       VALUES ($1, $2, 'Masculina', 'M', $3, 150.00, 80.00, $4)`,
      [variantId, productId, randomUUID(), stock],
    )
    return variantId
  }
})
