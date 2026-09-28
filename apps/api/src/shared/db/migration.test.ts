import { readFile } from 'node:fs/promises'

import { PGlite } from '@electric-sql/pglite'
import { afterEach, describe, expect, it } from 'vitest'

const migrationUrl = new URL('../../../migrations/001_initial.sql', import.meta.url)

describe('initial PostgreSQL schema', () => {
  const databases: PGlite[] = []

  afterEach(async () => {
    await Promise.all(databases.splice(0).map((database) => database.close()))
  })

  it('is re-executable and creates every required operational table', async () => {
    const database = new PGlite()
    databases.push(database)
    const sql = await readFile(migrationUrl, 'utf8')

    await database.exec(sql)
    await database.exec(sql)

    const result = await database.query<{ table_name: string }>(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `)

    expect(result.rows.map(({ table_name }) => table_name)).toEqual(expect.arrayContaining([
      'audit_log', 'catalog_sync_runs', 'customer_order_events', 'customer_orders', 'customers',
      'exchange_items', 'exchanges', 'goods_receipt_items', 'goods_receipts', 'idempotency_keys',
      'inventory_movements', 'media', 'migration_rejections', 'migration_runs', 'payments',
      'product_variants', 'products', 'purchase_order_items', 'purchase_orders', 'roles',
      'sale_items', 'sales', 'sessions', 'suppliers', 'users',
    ]))
  }, 15_000)

  it('rejects a negative stock balance at the database boundary', async () => {
    const database = new PGlite()
    databases.push(database)
    await database.exec(await readFile(migrationUrl, 'utf8'))
    const productId = '00000000-0000-4000-8000-000000000101'

    await database.query('INSERT INTO products (id, club, model) VALUES ($1, $2, $3)', [productId, 'Clube teste', 'Modelo teste'])

    await expect(database.query(
      `INSERT INTO product_variants
        (id, product_id, type, size, sku, sale_price, current_cost, stock_quantity)
       VALUES ($1, $2, 'Masculina', 'M', 'TEST-M', 100.00, 50.00, -1)`,
      ['00000000-0000-4000-8000-000000000102', productId],
    )).rejects.toThrow()
  })
})
