import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'

import { PGlite } from '@electric-sql/pglite'
import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { buildApp } from '../../app.js'
import { hashSecret } from '../../shared/auth/session.js'

describe('sale product previews with PostgreSQL queries', () => {
  const database = new PGlite()
  const app = buildApp({ logger: false, pool: database as unknown as Pool })
  const userId = randomUUID()
  const saleId = randomUUID()
  const token = randomUUID()
  const headers = { cookie: `erp_session=${token}` }
  const productIds = Array.from({ length: 4 }, () => randomUUID())
  const latestImage = randomUUID()

  beforeAll(async () => {
    await database.exec(await readFile(new URL('../../../migrations/001_initial.sql', import.meta.url), 'utf8'))
    await database.query(`INSERT INTO users (id, username, display_name, password_hash, role_id)
      VALUES ($1, 'preview-test', 'Preview test', 'unused', '00000000-0000-4000-8000-000000000003')`, [userId])
    await database.query(`INSERT INTO sessions (id, user_id, token_hash, csrf_hash, expires_at)
      VALUES ($1, $2, $3, $3, now() + interval '1 hour')`, [randomUUID(), userId, hashSecret(token)])
    await database.query(`INSERT INTO sales (id, operator_id, status, subtotal_amount, final_amount, created_at)
      VALUES ($1, $2, 'paid', 500, 500, '2026-09-05')`, [saleId, userId])
    for (const [index, productId] of productIds.entries()) {
      await database.query('INSERT INTO products (id, club, model) VALUES ($1, $2, $3)', [productId, `Clube ${index}`, 'Camisa'])
      // Different sizes of the same product must produce a single preview, even when sold out now.
      for (const size of index === 0 ? ['M', 'G'] : ['M']) {
        const variantId = randomUUID()
        await database.query(`INSERT INTO product_variants (id, product_id, type, size, sku, sale_price, current_cost)
          VALUES ($1, $2, 'Masculina', $3, $4, 100, 50)`, [variantId, productId, size, `${index}-${size}`])
        await database.query(`INSERT INTO sale_items (id, sale_id, variant_id, quantity, unit_price, unit_cost)
          VALUES ($1, $2, $3, 1, 100, 50)`, [randomUUID(), saleId, variantId])
      }
    }
    for (const [id, active, createdAt] of [
      [randomUUID(), true, '2026-09-01'], [latestImage, true, '2026-09-02'], [randomUUID(), false, '2026-09-03'],
    ] as const) {
      await database.query(`INSERT INTO media (id, product_id, storage_key, original_name, mime_type, byte_size, checksum_sha256, created_by, active, created_at)
        VALUES ($1::uuid, $2, $1::uuid::text, 'shirt.png', 'image/png', 100, $3, $4, $5, $6)`,
      [id, productIds[0], 'a'.repeat(64), userId, active, createdAt])
    }
    const customerId = randomUUID()
    await database.query("INSERT INTO customers (id, name) VALUES ($1, 'Cliente teste')", [customerId])
    for (const status of ['pending', 'partially_paid', 'reversed']) {
      await database.query(`INSERT INTO sales (id, customer_id, operator_id, status, subtotal_amount, final_amount, payment_due_date, created_at)
        VALUES ($1, $2, $3, $4, 100, 100, '2026-10-01', '2026-09-01')`, [randomUUID(), customerId, userId, status])
    }
    await app.ready()
  }, 30_000)

  afterAll(async () => { await app.close(); await database.close() })

  it('returns at most three distinct sold products with the most recent active image', async () => {
    const response = await app.inject({ method: 'GET', url: '/sales?limit=1', headers })
    expect(response.statusCode).toBe(200)
    const data = response.json()
    expect(data).toMatchObject({ total: 4, page: 1, limit: 1 })
    expect(data.items[0]).toMatchObject({ id: saleId, productPreviews: [
      { productId: productIds[0], label: 'Clube 0 Camisa', mediaId: latestImage },
      { productId: productIds[1], label: 'Clube 1 Camisa', mediaId: null },
      { productId: productIds[2], label: 'Clube 2 Camisa', mediaId: null },
    ] })
    expect(data.items[0].productSummary).toContain('Clube 0 Camisa ×2')
    expect(data.items[0].productSummary).toContain('Clube 3 Camisa ×1')
    const secondPage = await app.inject({ method: 'GET', url: '/sales?limit=1&page=2', headers })
    expect(secondPage.statusCode).toBe(200)
    expect(secondPage.json().items[0].id).not.toBe(saleId)
    expect(secondPage.json().items[0].productPreviews).toEqual([])
  })

  it('A receber includes pending and partial payments, excluding paid and reversed sales', async () => {
    const response = await app.inject({ method: 'GET', url: '/sales?status=open', headers })
    expect(response.statusCode).toBe(200)
    expect(response.json().total).toBe(2)
    expect(response.json().items.map((sale: { status: string }) => sale.status).sort()).toEqual(['partially_paid', 'pending'])
  })

  it('keeps previews behind sales read authentication', async () => {
    expect((await app.inject({ method: 'GET', url: '/sales' })).statusCode).toBe(401)
  })
})
