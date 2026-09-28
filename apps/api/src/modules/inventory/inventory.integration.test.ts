import { randomUUID } from 'node:crypto'

import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { buildApp } from '../../app.js'
import { hashSecret } from '../../shared/auth/session.js'
import { applyMigrations } from '../../shared/db/migrate.js'

const connectionString = process.env['TEST_DATABASE_URL']
if (!connectionString) throw new Error('TEST_DATABASE_URL is required for PostgreSQL integration tests.')

describe('products and inventory HTTP flow', () => {
  const adminPool = new Pool({ connectionString, max: 1 })
  const schema = `erp2_test_${randomUUID().replaceAll('-', '')}`
  const sessionToken = randomUUID()
  const csrfToken = randomUUID()
  const userId = randomUUID()
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
       VALUES ($1, 'gestor.estoque', 'Gestor Estoque', 'unused-in-this-test', $2)`,
      [userId, '00000000-0000-4000-8000-000000000003'],
    )
    await pool.query(
      `INSERT INTO sessions (id, user_id, token_hash, csrf_hash, expires_at)
       VALUES ($1, $2, $3, $4, now() + interval '1 hour')`,
      [randomUUID(), userId, hashSecret(sessionToken), hashSecret(csrfToken)],
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

  it('requires authentication for product reads', async () => {
    const response = await app.inject({ method: 'GET', url: '/products' })

    expect(response.statusCode).toBe(401)
    expect(response.json()).toMatchObject({ code: 'UNAUTHENTICATED' })
  })

  it('creates a logical product with zero-stock variants and returns aggregated detail', async () => {
    const payload = {
      club: 'Flamengo',
      model: `Home Teste ${randomUUID().slice(0, 6)}`,
      description: 'Fixture sintética',
      variants: [
        { type: 'Masculina', size: 'M', sku: `FLA-${randomUUID()}`, salePrice: '150.00', currentCost: '80.00', lowStockThreshold: 2 },
        { type: 'Masculina', size: 'G', sku: `FLA-${randomUUID()}`, salePrice: '150.00', currentCost: '80.00', lowStockThreshold: 2 },
      ],
    }
    const created = await app.inject({
      method: 'POST', url: '/products', payload, headers: authenticatedHeaders(),
    })

    expect(created.statusCode).toBe(201)
    expect(created.json()).toMatchObject({ club: payload.club, model: payload.model })
    expect(created.json().variants).toHaveLength(2)
    expect(created.json().variants.every((variant: { stockQuantity: number }) => variant.stockQuantity === 0)).toBe(true)

    const list = await app.inject({ method: 'GET', url: '/products', headers: { cookie: authCookie() } })
    expect(list.statusCode).toBe(200)
    expect(list.json().items).toEqual(expect.arrayContaining([expect.objectContaining({ id: created.json().id })]))

    const detail = await app.inject({
      method: 'GET', url: `/products/${created.json().id}`, headers: { cookie: authCookie() },
    })
    expect(detail.statusCode).toBe(200)
    expect(detail.json().variants).toHaveLength(2)

    const duplicate = await app.inject({
      method: 'POST', url: '/products', payload: { ...payload, variants: [payload.variants[0]] }, headers: authenticatedHeaders(),
    })
    expect(duplicate.statusCode).toBe(409)
    expect(duplicate.json()).toMatchObject({ code: 'PRODUCT_ALREADY_EXISTS' })
  })

  it('applies an idempotent audited adjustment and rejects overdraw or key reuse', async () => {
    const variantId = await insertVariant(0)
    const key = randomUUID()
    const payload = { variantId, quantityDelta: 5, reason: 'Contagem inicial de teste' }

    const first = await app.inject({
      method: 'POST', url: '/inventory/movements', payload,
      headers: { ...authenticatedHeaders(), 'idempotency-key': key },
    })
    const repeated = await app.inject({
      method: 'POST', url: '/inventory/movements', payload,
      headers: { ...authenticatedHeaders(), 'idempotency-key': key },
    })

    expect(first.statusCode).toBe(201)
    expect(repeated.statusCode).toBe(201)
    expect(repeated.json()).toEqual(first.json())
    expect(first.json()).toMatchObject({ variantId, quantityDelta: 5, balanceAfter: 5 })

    const changedRequest = await app.inject({
      method: 'POST', url: '/inventory/movements',
      payload: { ...payload, quantityDelta: 1 },
      headers: { ...authenticatedHeaders(), 'idempotency-key': key },
    })
    expect(changedRequest.statusCode).toBe(409)
    expect(changedRequest.json()).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' })

    const overdraw = await app.inject({
      method: 'POST', url: '/inventory/movements',
      payload: { variantId, quantityDelta: -6, reason: 'Saída inválida de teste' },
      headers: { ...authenticatedHeaders(), 'idempotency-key': randomUUID() },
    })
    expect(overdraw.statusCode).toBe(409)
    expect(overdraw.json()).toMatchObject({ code: 'INSUFFICIENT_STOCK', details: { available: 5, requested: 6 } })

    const state = await pool.query<{ stock_quantity: number; movements: string; audits: string }>(
      `SELECT v.stock_quantity,
              (SELECT count(*) FROM inventory_movements WHERE variant_id = v.id) AS movements,
              (SELECT count(*) FROM audit_log WHERE entity_id = v.id::text AND action = 'inventory.manual_adjustment') AS audits
       FROM product_variants v WHERE v.id = $1`,
      [variantId],
    )
    expect(state.rows[0]).toEqual({ stock_quantity: 5, movements: '1', audits: '1' })
  })

  it('serializes concurrent decrements so stock never becomes negative', async () => {
    const variantId = await insertVariant(5)
    const request = (key: string) => app.inject({
      method: 'POST', url: '/inventory/movements',
      payload: { variantId, quantityDelta: -4, reason: 'Concorrência sintética' },
      headers: { ...authenticatedHeaders(), 'idempotency-key': key },
    })

    const responses = await Promise.all([request(randomUUID()), request(randomUUID())])

    expect(responses.map(({ statusCode }) => statusCode).sort()).toEqual([201, 409])
    const balance = await pool.query<{ stock_quantity: number }>('SELECT stock_quantity FROM product_variants WHERE id = $1', [variantId])
    expect(balance.rows[0]?.stock_quantity).toBe(1)

    const inventory = await app.inject({ method: 'GET', url: '/inventory?availability=low', headers: { cookie: authCookie() } })
    expect(inventory.statusCode).toBe(200)
    expect(inventory.json().items).toEqual(expect.arrayContaining([expect.objectContaining({ variantId, stockQuantity: 1 })]))
  })

  function authenticatedHeaders() {
    return { cookie: authCookie(), 'x-csrf-token': csrfToken }
  }

  function authCookie() {
    return `erp_session=${encodeURIComponent(sessionToken)}; erp_csrf=${encodeURIComponent(csrfToken)}`
  }

  async function insertVariant(stock: number): Promise<string> {
    const productId = randomUUID()
    const variantId = randomUUID()
    await pool.query('INSERT INTO products (id, club, model) VALUES ($1, $2, $3)', [productId, 'Fixture FC', randomUUID()])
    await pool.query(
      `INSERT INTO product_variants
        (id, product_id, type, size, sku, sale_price, current_cost, stock_quantity, low_stock_threshold)
       VALUES ($1, $2, 'Masculina', 'M', $3, 100.00, 50.00, $4, 2)`,
      [variantId, productId, randomUUID(), stock],
    )
    return variantId
  }
})
