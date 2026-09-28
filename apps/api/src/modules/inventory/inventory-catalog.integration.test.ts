import { randomUUID } from 'node:crypto'

import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { buildApp } from '../../app.js'
import { hashSecret } from '../../shared/auth/session.js'
import { applyMigrations } from '../../shared/db/migrate.js'

const connectionString = process.env['TEST_DATABASE_URL']
if (!connectionString) throw new Error('TEST_DATABASE_URL is required for PostgreSQL integration tests.')

describe('inventory catalog HTTP flow', () => {
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
       VALUES ($1, 'gestor.estoque', 'Gestor Estoque', 'unused-in-this-test', '00000000-0000-4000-8000-000000000003'),
              ($2, 'operador.estoque', 'Operador Estoque', 'unused-in-this-test', '00000000-0000-4000-8000-000000000001')`,
      [managerId, operatorId],
    )
    await pool.query(
      `INSERT INTO sessions (id, user_id, token_hash, csrf_hash, expires_at)
       VALUES ($1, $2, $3, $4, now() + interval '1 hour'),
              ($5, $6, $7, $8, now() + interval '1 hour')`,
      [randomUUID(), managerId, hashSecret(managerToken), hashSecret(managerCsrf), randomUUID(), operatorId, hashSecret(operatorToken), hashSecret(operatorCsrf)],
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

  it('requires authentication and write permission for catalog writes', async () => {
    const anonymous = await app.inject({ method: 'PATCH', url: `/products/${randomUUID()}`, payload: {} })
    expect(anonymous.statusCode).toBe(401)

    const operatorPatch = await app.inject({
      method: 'PATCH', url: `/products/${randomUUID()}`,
      payload: { description: 'x' }, headers: operatorHeaders(),
    })
    expect(operatorPatch.statusCode).toBe(403)

    const operatorCreate = await app.inject({
      method: 'POST', url: '/products',
      payload: { club: 'X', model: 'Y', variants: [] }, headers: operatorHeaders(),
    })
    expect(operatorCreate.statusCode).toBe(403)

    const badCsrf = await app.inject({
      method: 'POST', url: '/products',
      payload: { club: 'X', model: 'Y', variants: [] },
      headers: { cookie: managerCookie(), 'x-csrf-token': 'csrf-invalido' },
    })
    expect(badCsrf.statusCode).toBe(403)
    expect(badCsrf.json()).toMatchObject({ code: 'INVALID_CSRF' })
  })

  it('updates metadata, price and threshold with audit and rejects forbidden fields', async () => {
    const created = await createProduct('Patch FC', [
      { type: 'Masculina', size: 'M', salePrice: '150.00', currentCost: '80.00' },
    ])
    const variantId = created.variants[0]!.id

    const invalidId = await app.inject({ method: 'PATCH', url: '/products/nao-uuid', payload: {}, headers: managerHeaders() })
    expect(invalidId.statusCode).toBe(400)

    const missing = await app.inject({ method: 'PATCH', url: `/products/${randomUUID()}`, payload: { description: 'x' }, headers: managerHeaders() })
    expect(missing.statusCode).toBe(404)

    const unknownVariant = await app.inject({
      method: 'PATCH', url: `/products/${created.id}`,
      payload: { variants: [{ id: randomUUID(), salePrice: '160.00' }] }, headers: managerHeaders(),
    })
    expect(unknownVariant.statusCode).toBe(404)
    expect(unknownVariant.json()).toMatchObject({ code: 'VARIANT_NOT_FOUND' })

    const forbiddenCost = await app.inject({
      method: 'PATCH', url: `/products/${created.id}`,
      payload: { variants: [{ id: variantId, currentCost: '10.00' }] }, headers: managerHeaders(),
    })
    expect(forbiddenCost.statusCode).toBe(400)

    const forbiddenStock = await app.inject({
      method: 'PATCH', url: `/products/${created.id}`,
      payload: { variants: [{ id: variantId, stockQuantity: 99 }] }, headers: managerHeaders(),
    })
    expect(forbiddenStock.statusCode).toBe(400)

    const patched = await app.inject({
      method: 'PATCH', url: `/products/${created.id}`,
      payload: { description: 'Descricao auditada', variants: [{ id: variantId, salePrice: '159.90', lowStockThreshold: 4 }] },
      headers: managerHeaders(),
    })
    expect(patched.statusCode).toBe(200)
    expect(patched.json()).toMatchObject({ id: created.id, description: 'Descricao auditada' })
    expect(patched.json().variants[0]).toMatchObject({ id: variantId, salePrice: '159.90', lowStockThreshold: 4, stockQuantity: 0 })

    const audits = await pool.query<{ count: string; before: unknown; after: unknown }>(
      `SELECT count(*) AS count FROM audit_log WHERE entity_id = $1 AND action = 'product.update'`,
      [created.id],
    )
    expect(audits.rows[0]?.count).toBe('1')

    const other = await createProduct('Outro FC', [{ type: 'Feminina', size: 'P', salePrice: '100.00', currentCost: '50.00' }])
    const clash = await app.inject({
      method: 'PATCH', url: `/products/${created.id}`,
      payload: { club: other.club, model: other.model }, headers: managerHeaders(),
    })
    expect(clash.statusCode).toBe(409)
    expect(clash.json()).toMatchObject({ code: 'PRODUCT_ALREADY_EXISTS' })
  })

  it('rejects duplicate business keys on create', async () => {
    const tag = randomUUID().slice(0, 8)
    const payload = {
      club: `Dup ${tag}`, model: `Modelo ${tag}`,
      variants: [{ type: 'Masculina', size: 'M', sku: `DUP-${tag}`, salePrice: '100.00', currentCost: '50.00', lowStockThreshold: 1 }],
    }
    const first = await app.inject({ method: 'POST', url: '/products', payload, headers: managerHeaders() })
    expect(first.statusCode).toBe(201)

    const sameName = await app.inject({
      method: 'POST', url: '/products',
      payload: { ...payload, model: `Modelo ${tag} bis`, variants: [{ ...payload.variants[0], sku: `OUTRO-${tag}` }] },
      headers: managerHeaders(),
    })
    expect(sameName.statusCode).toBe(201)

    const sameSku = await app.inject({
      method: 'POST', url: '/products',
      payload: { club: `Outro ${tag}`, model: `Outro ${tag}`, variants: [{ ...payload.variants[0] }] },
      headers: managerHeaders(),
    })
    expect(sameSku.statusCode).toBe(409)
  })

  it('filters, paginates and aggregates the product list with real totals', async () => {
    const tag = randomUUID().slice(0, 8)
    const stocked = await createProduct(`Filtro ${tag}`, [
      { type: 'Masculina', size: 'M', salePrice: '200.00', currentCost: '100.00' },
      { type: 'Infantil', size: '10', salePrice: '120.00', currentCost: '60.00' },
    ])
    await adjust(stocked.variants[0]!.id, 3, 'Entrada filtro')
    await addMedia(stocked.id)

    const empty = await createProduct(`Zerado ${tag}`, [
      { type: 'Feminina', size: 'P', salePrice: '90.00', currentCost: '40.00' },
    ])

    const search = await app.inject({ method: 'GET', url: `/products?search=${encodeURIComponent(`Filtro ${tag}`)}`, headers: { cookie: managerCookie() } })
    expect(search.json().items.map((item: { id: string }) => item.id)).toEqual([stocked.id])

    const outOfStock = await app.inject({ method: 'GET', url: `/products?availability=out_of_stock&search=${tag}`, headers: { cookie: managerCookie() } })
    expect(outOfStock.json().items.map((item: { id: string }) => item.id).sort()).toEqual([empty.id, stocked.id].sort())

    const withImage = await app.inject({ method: 'GET', url: `/products?image=with&search=${tag}`, headers: { cookie: managerCookie() } })
    expect(withImage.json().items.map((item: { id: string }) => item.id)).toEqual([stocked.id])

    const withoutImage = await app.inject({ method: 'GET', url: `/products?image=without&search=${tag}`, headers: { cookie: managerCookie() } })
    expect(withoutImage.json().items.map((item: { id: string }) => item.id)).toEqual([empty.id])

    const byType = await app.inject({ method: 'GET', url: `/products?type=Infantil&search=${tag}`, headers: { cookie: managerCookie() } })
    expect(byType.json().items).toHaveLength(1)
    expect(byType.json().items[0].variants.map((variant: { type: string }) => variant.type)).toEqual(['Infantil'])

    const row = search.json().items[0]
    expect(row.totalStock).toBe(3)
    expect(row.hasImage).toBe(true)
    expect(new Date(row.lastMovementAt).getTime()).not.toBeNaN()

    const paged = await app.inject({ method: 'GET', url: `/products?search=${tag}&page=2&limit=1&sort=model&order=asc`, headers: { cookie: managerCookie() } })
    expect(paged.json()).toMatchObject({ total: 2, page: 2, limit: 1 })
    expect(paged.json().items).toHaveLength(1)

    const badLimit = await app.inject({ method: 'GET', url: '/products?limit=101', headers: { cookie: managerCookie() } })
    expect(badLimit.statusCode).toBe(400)

    const badSort = await app.inject({ method: 'GET', url: '/products?sort=senha', headers: { cookie: managerCookie() } })
    expect(badSort.statusCode).toBe(400)
  })

  it('exposes real movement history with origin, reason and operator', async () => {
    const created = await createProduct('Historico FC', [
      { type: 'Masculina', size: 'G', salePrice: '180.00', currentCost: '90.00' },
    ])
    const variantId = created.variants[0]!.id
    await adjust(variantId, 4, 'Entrada historico')

    const anonymous = await app.inject({ method: 'GET', url: `/inventory/movements?variantId=${variantId}` })
    expect(anonymous.statusCode).toBe(401)

    const invalid = await app.inject({ method: 'GET', url: '/inventory/movements?variantId=nao-uuid', headers: { cookie: managerCookie() } })
    expect(invalid.statusCode).toBe(400)

    const missing = await app.inject({ method: 'GET', url: `/inventory/movements?variantId=${randomUUID()}`, headers: { cookie: managerCookie() } })
    expect(missing.statusCode).toBe(404)

    const history = await app.inject({ method: 'GET', url: `/inventory/movements?variantId=${variantId}`, headers: { cookie: operatorCookie() } })
    expect(history.statusCode).toBe(200)
    expect(history.json().items).toHaveLength(1)
    expect(history.json().items[0]).toMatchObject({
      variantId, movementType: 'manual_adjustment', quantityDelta: 4, balanceAfter: 4,
      reason: 'Entrada historico', userDisplayName: 'Gestor Estoque',
    })

    const byProduct = await app.inject({ method: 'GET', url: `/inventory/movements?productId=${created.id}`, headers: { cookie: managerCookie() } })
    expect(byProduct.json().total).toBe(1)

    const filtered = await app.inject({ method: 'GET', url: `/inventory/movements?variantId=${variantId}&type=sale`, headers: { cookie: managerCookie() } })
    expect(filtered.json().items).toHaveLength(0)

    const badType = await app.inject({ method: 'GET', url: `/inventory/movements?variantId=${variantId}&type=invalido`, headers: { cookie: managerCookie() } })
    expect(badType.statusCode).toBe(400)
  })

  it('rejects reasonless adjustments and keeps stock explained by movements', async () => {    const created = await createProduct('Motivo FC', [
      { type: 'Masculina', size: 'M', salePrice: '110.00', currentCost: '55.00' },
    ])
    const variantId = created.variants[0]!.id

    const noReason = await app.inject({
      method: 'POST', url: '/inventory/movements',
      payload: { variantId, quantityDelta: 2, reason: '   ' }, headers: managerHeaders(),
    })
    expect(noReason.statusCode).toBe(400)

    await adjust(variantId, 2, 'Entrada motivo')
    const state = await pool.query<{ stock_quantity: number; movements: string }>(
      `SELECT stock_quantity, (SELECT count(*) FROM inventory_movements WHERE variant_id = $1) AS movements
       FROM product_variants WHERE id = $1`,
      [variantId],
    )
    expect(state.rows[0]).toEqual({ stock_quantity: 2, movements: '1' })
  })

  it('counts each variant balance exactly once with several movements', async () => {
    const created = await createProduct('Fanout FC', [
      { type: 'Masculina', size: 'M', salePrice: '100.00', currentCost: '50.00' },
      { type: 'Masculina', size: 'G', salePrice: '100.00', currentCost: '50.00' },
    ])
    const [firstId, secondId] = created.variants.map((variant) => variant.id)
    await adjust(firstId!, 8, 'Fanout A')
    await adjust(secondId!, 8, 'Fanout B')
    await adjust(firstId!, 2, 'Fanout A2')
    await adjust(firstId!, -2, 'Fanout A3')

    const detail = await app.inject({ method: 'GET', url: `/products/${created.id}`, headers: { cookie: managerCookie() } })
    expect(detail.statusCode).toBe(200)
    expect(detail.json()).toMatchObject({ totalStock: 16 })

    const list = await app.inject({ method: 'GET', url: `/products?search=Fanout FC`, headers: { cookie: managerCookie() } })
    expect(list.json().items.find((item: { id: string }) => item.id === created.id)).toMatchObject({ totalStock: 16 })
  })

  it('keeps the total before pagination even on empty pages', async () => {
    const tag = randomUUID().slice(0, 8)
    await createProduct(`Pagina ${tag}`, [
      { type: 'Masculina', size: 'M', salePrice: '100.00', currentCost: '50.00' },
    ])

    const second = await app.inject({
      method: 'GET', url: `/products?search=${encodeURIComponent(`Pagina ${tag}`)}&page=2&limit=1`,
      headers: { cookie: managerCookie() },
    })
    expect(second.json().items).toHaveLength(0)
    expect(second.json()).toMatchObject({ total: 1, page: 2, limit: 1 })

    const beyond = await app.inject({
      method: 'GET', url: `/products?search=${encodeURIComponent(`Pagina ${tag}`)}&page=99&limit=10`,
      headers: { cookie: managerCookie() },
    })
    expect(beyond.json().items).toHaveLength(0)
    expect(beyond.json()).toMatchObject({ total: 1, page: 99 })
  })

  it('hides unit cost from operators without products:write', async () => {
    const created = await createProduct('Custo FC', [
      { type: 'Masculina', size: 'M', salePrice: '100.00', currentCost: '50.00' },
    ])

    const operatorDetail = await app.inject({ method: 'GET', url: `/products/${created.id}`, headers: { cookie: operatorCookie() } })
    expect(operatorDetail.statusCode).toBe(200)
    for (const variant of operatorDetail.json().variants as Array<Record<string, unknown>>) {
      expect(variant).not.toHaveProperty('currentCost')
    }

    const operatorList = await app.inject({ method: 'GET', url: `/products?search=Custo FC`, headers: { cookie: operatorCookie() } })
    for (const item of operatorList.json().items as Array<{ variants: Array<Record<string, unknown>> }>) {
      for (const variant of item.variants) expect(variant).not.toHaveProperty('currentCost')
    }

    const managerDetail = await app.inject({ method: 'GET', url: `/products/${created.id}`, headers: { cookie: managerCookie() } })
    expect(managerDetail.json().variants[0]).toMatchObject({ currentCost: '50.00' })
  })

  it('review: total stock counts each variant once after repeated movements', async () => {
    const created = await createProduct(`Review totals ${randomUUID()}`, [
      { type: 'Masculina', size: 'M', salePrice: '100.00', currentCost: '50.00' },
      { type: 'Infantil', size: '10', salePrice: '100.00', currentCost: '50.00' },
    ])
    await adjust(created.variants[0]!.id, 5, 'Review first entry')
    await adjust(created.variants[0]!.id, 3, 'Review second entry')
    await adjust(created.variants[1]!.id, 8, 'Review equal balance variant')
    const detail = await app.inject({ method: 'GET', url: `/products/${created.id}`, headers: { cookie: managerCookie() } })
    expect(detail.statusCode).toBe(200)
    expect(detail.json().totalStock).toBe(16)
  })

  it('review: empty page preserves matching count for pagination recovery', async () => {
    const club = `Review paging ${randomUUID()}`
    await createProduct(club, [{ type: 'Masculina', size: 'M', salePrice: '100.00', currentCost: '50.00' }])
    const response = await app.inject({ method: 'GET', url: `/products?search=${encodeURIComponent(club)}&page=2&limit=1`, headers: { cookie: managerCookie() } })
    expect(response.statusCode).toBe(200)
    expect(response.json().items).toEqual([])
    expect(response.json().total).toBe(1)
  })

  it('review: operator product detail does not expose restricted cost', async () => {
    const created = await createProduct(`Review cost ${randomUUID()}`, [{ type: 'Masculina', size: 'M', salePrice: '100.00', currentCost: '50.00' }])
    const response = await app.inject({ method: 'GET', url: `/products/${created.id}`, headers: { cookie: operatorCookie() } })
    expect(response.statusCode).toBe(200)
    expect(response.json().variants[0]).not.toHaveProperty('currentCost')
  })

  function managerHeaders() {
    return { cookie: managerCookie(), 'x-csrf-token': managerCsrf }
  }

  function operatorHeaders() {
    return { cookie: operatorCookie(), 'x-csrf-token': operatorCsrf }
  }

  function managerCookie() {
    return `erp_session=${encodeURIComponent(managerToken)}; erp_csrf=${encodeURIComponent(managerCsrf)}`
  }

  function operatorCookie() {
    return `erp_session=${encodeURIComponent(operatorToken)}; erp_csrf=${encodeURIComponent(operatorCsrf)}`
  }

  async function createProduct(club: string, variants: Array<{ type: string; size: string; salePrice: string; currentCost: string }>) {
    const payload = {
      club, model: `Modelo ${randomUUID().slice(0, 8)}`,
      variants: variants.map((variant) => ({ ...variant, sku: `SKU-${randomUUID()}`, lowStockThreshold: 1 })),
    }
    const response = await app.inject({ method: 'POST', url: '/products', payload, headers: managerHeaders() })
    expect(response.statusCode).toBe(201)
    return response.json() as { id: string; club: string; model: string; variants: Array<{ id: string }> }
  }

  async function adjust(variantId: string, quantityDelta: number, reason: string) {
    const response = await app.inject({
      method: 'POST', url: '/inventory/movements',
      payload: { variantId, quantityDelta, reason },
      headers: { ...managerHeaders(), 'idempotency-key': randomUUID() },
    })
    expect(response.statusCode).toBe(201)
    return response.json()
  }

  async function addMedia(productId: string) {
    await pool.query(
      `INSERT INTO media (id, product_id, storage_key, original_name, mime_type, byte_size, checksum_sha256, created_by)
       VALUES ($1, $2, $3, 'foto.jpg', 'image/jpeg', 1024, $4, $5)`,
      [randomUUID(), productId, `e2e/${randomUUID()}.jpg`, '0'.repeat(64), managerId],
    )
  }
})
