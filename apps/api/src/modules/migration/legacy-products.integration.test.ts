import { randomUUID } from 'node:crypto'

import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { applyMigrations } from '../../shared/db/migrate.js'
import { migrateLegacyProducts } from './legacy-products.js'

const connectionString = process.env['TEST_DATABASE_URL']
if (!connectionString) throw new Error('TEST_DATABASE_URL is required for PostgreSQL integration tests.')

describe('legacy product migration', () => {
  const adminPool = new Pool({ connectionString, max: 1 })
  const schema = `erp2_test_${randomUUID().replaceAll('-', '')}`
  const actorUserId = randomUUID()
  let pool: Pool

  beforeAll(async () => {
    const current = await adminPool.query<{ current_database: string }>('SELECT current_database()')
    if (current.rows[0]?.current_database !== 'erp2_test') {
      throw new Error('Integration tests refuse to run outside the dedicated erp2_test database.')
    }
    await adminPool.query(`CREATE SCHEMA "${schema}"`)
    pool = new Pool({ connectionString, max: 4, options: `-c search_path=${schema}` })
    await applyMigrations(pool)
    await pool.query(
      `INSERT INTO users (id, username, display_name, password_hash, role_id)
       VALUES ($1, 'migrador.teste', 'Migrador Teste', 'unused-in-this-test', $2)`,
      [actorUserId, '00000000-0000-4000-8000-000000000004'],
    )
  }, 30_000)

  afterAll(async () => {
    await pool?.end()
    if (schema.startsWith('erp2_test_')) await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`)
    await adminPool.end()
  })

  it('imports reconciled variants, explains stock with opening movements and reports every rejection', async () => {
    const report = await migrateLegacyProducts(pool, {
      sourceName: 'fixture-produtos',
      actorUserId,
      rows: [
        legacyRow({ legacyId: 10, size: 'M', stockQuantity: 3 }),
        legacyRow({ legacyId: 11, size: 'G', stockQuantity: 0 }),
        legacyRow({ legacyId: 12, size: 'GG', stockQuantity: -1 }),
        legacyRow({ legacyId: 13, size: 'M', stockQuantity: 2 }),
      ],
    })

    expect(report).toMatchObject({
      reused: false,
      counts: { sourceRows: 4, products: 1, acceptedVariants: 2, rejectedRows: 2, openingBalanceUnits: 3 },
    })
    expect(report.sourceChecksum).toMatch(/^[a-f0-9]{64}$/)

    const reconciliation = await pool.query<{
      products: string
      variants: string
      stock: string
      movement_units: string
      movements: string
    }>(
      `SELECT
         (SELECT count(*) FROM products) AS products,
         (SELECT count(*) FROM product_variants) AS variants,
         (SELECT coalesce(sum(stock_quantity), 0) FROM product_variants) AS stock,
         (SELECT coalesce(sum(quantity_delta), 0) FROM inventory_movements) AS movement_units,
         (SELECT count(*) FROM inventory_movements) AS movements`,
    )
    expect(reconciliation.rows[0]).toEqual({ products: '1', variants: '2', stock: '3', movement_units: '3', movements: '1' })

    const legacyIds = await pool.query<{ legacy_id: string }>('SELECT legacy_id::text FROM product_variants ORDER BY legacy_id')
    expect(legacyIds.rows).toEqual([{ legacy_id: '10' }, { legacy_id: '11' }])
    const rejections = await pool.query<{ reason_code: string }>('SELECT reason_code FROM migration_rejections ORDER BY reason_code')
    expect(rejections.rows).toEqual([
      { reason_code: 'DUPLICATE_VARIANT_IN_SOURCE' },
      { reason_code: 'INVALID_LEGACY_PRODUCT' },
    ])
  })

  it('reuses an identical source snapshot without duplicating target rows', async () => {
    const input = {
      sourceName: 'fixture-idempotente',
      actorUserId,
      rows: [
        legacyRow({ legacyId: 20, club: 'Palmeiras', stockQuantity: 5 }),
        legacyRow({ legacyId: 21, club: 'Palmeiras', size: 'G' }),
      ],
    }

    const first = await migrateLegacyProducts(pool, input)
    const second = await migrateLegacyProducts(pool, { ...input, rows: [...input.rows].reverse() })

    expect(first.reused).toBe(false)
    expect(second).toEqual({ ...first, reused: true })
    const counts = await pool.query<{ runs: string; variants: string; movements: string }>(
      `SELECT
         (SELECT count(*) FROM migration_runs WHERE source_name = $1) AS runs,
         (SELECT count(*) FROM product_variants WHERE legacy_id IN (20, 21)) AS variants,
         (SELECT count(*) FROM inventory_movements WHERE idempotency_key = $2) AS movements`,
      [input.sourceName, `${input.sourceName}:produtos:20:opening_balance`],
    )
    expect(counts.rows[0]).toEqual({ runs: '1', variants: '2', movements: '1' })
  })

  it('classifies target conflicts without overwriting existing variants', async () => {
    const productId = randomUUID()
    const variantId = randomUUID()
    await pool.query('INSERT INTO products (id, club, model) VALUES ($1, $2, $3)', [productId, 'Corinthians', 'Third 2026'])
    await pool.query(
      `INSERT INTO product_variants
         (id, product_id, legacy_id, type, size, sku, sale_price, current_cost)
       VALUES ($1, $2, 30, 'Masculina', 'M', $3, 100.00, 50.00)`,
      [variantId, productId, randomUUID()],
    )

    const report = await migrateLegacyProducts(pool, {
      sourceName: 'fixture-conflitos',
      actorUserId,
      rows: [
        legacyRow({ legacyId: 30, club: 'Santos', model: 'Away 2026' }),
        legacyRow({ legacyId: 31, club: 'Corinthians', model: 'Third 2026' }),
      ],
    })

    expect(report.counts).toMatchObject({ acceptedVariants: 0, rejectedRows: 2 })
    const rejections = await pool.query<{ reason_code: string }>(
      `SELECT reason_code FROM migration_rejections r
       JOIN migration_runs m ON m.id = r.migration_run_id
       WHERE m.source_name = 'fixture-conflitos'
       ORDER BY reason_code`,
    )
    expect(rejections.rows).toEqual([
      { reason_code: 'LEGACY_ID_ALREADY_MIGRATED' },
      { reason_code: 'TARGET_VARIANT_CONFLICT' },
    ])
    const preserved = await pool.query<{ stock_quantity: number }>('SELECT stock_quantity FROM product_variants WHERE id = $1', [variantId])
    expect(preserved.rows[0]?.stock_quantity).toBe(0)
  })
})

function legacyRow(overrides: Partial<{
  legacyId: number
  club: string
  model: string
  type: string
  size: string
  description: string
  salePrice: string
  stockQuantity: number
  currentCost: string
}> = {}) {
  return {
    legacyId: 1,
    club: 'Flamengo',
    model: 'Home 2026',
    type: 'Masculina',
    size: 'M',
    description: 'Fixture sintética',
    salePrice: '150.00',
    stockQuantity: 0,
    currentCost: '80.00',
    ...overrides,
  }
}
