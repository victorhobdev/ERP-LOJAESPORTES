import { randomUUID } from 'node:crypto'

import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { applyMigrations } from '../../shared/db/migrate.js'
import { runGeminiConferenceMigration } from './gemini-conference.js'

const connectionString = process.env['TEST_DATABASE_URL']
if (!connectionString) throw new Error('TEST_DATABASE_URL is required for PostgreSQL integration tests.')

describe('gemini conference migration', () => {
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
       VALUES ($1, 'migrador.conferencia', 'Migrador conferência', 'unused-in-this-test', '00000000-0000-4000-8000-000000000001')`,
      [actorUserId],
    )
    await seedCatalog()
    await seedLegacyOrders()
  }, 120_000)

  afterAll(async () => {
    await pool?.end()
    await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`)
    await adminPool.end()
  }, 120_000)

  it('faz dry-run sem escrita, aplica a conferência e é idempotente', async () => {
    const beforePreview = await snapshot()
    const preview = await runGeminiConferenceMigration(pool, { mode: 'dry-run', actorUserId })

    expect(preview).toMatchObject({ mode: 'dry-run', reused: false, conflicts: [] })
    expect(preview.stockAdjustments.map((row) => [row.legacyId, row.before, row.after])).toEqual([
      [77, 1, 0], [174, 1, 0], [175, 1, 0], [184, 1, 3], [237, 0, 1],
    ])
    expect(preview.legacyClosures).toEqual(expect.arrayContaining([
      expect.objectContaining({ legacyId: 2, ordered: 74, receivedBefore: 48, pendingBefore: 26, pendingAfter: 0 }),
      expect.objectContaining({ legacyId: 5, ordered: 60, receivedBefore: 0, pendingBefore: 60, pendingAfter: 0 }),
    ]))
    expect(preview.orders).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'kakaric-brasil', orderedQuantity: 8, finalAmount: '50.00', orderedOn: '2026-08-16' }),
      expect.objectContaining({ key: 'kakaric-novos-modelos', orderedQuantity: 20, finalAmount: '1094.00', orderedOn: '2026-08-28' }),
    ]))
    expect(preview.createdProducts).toHaveLength(5)
    expect(await snapshot()).toEqual(beforePreview)

    const applied = await runGeminiConferenceMigration(pool, { mode: 'apply', actorUserId })
    expect(applied).toMatchObject({ mode: 'apply', reused: false, conflicts: [] })

    const stocks = await pool.query<{ legacy_id: string; stock_quantity: number; current_cost: string }>(
      `SELECT legacy_id::text, stock_quantity, current_cost::text
       FROM product_variants WHERE legacy_id = ANY($1::bigint[]) ORDER BY product_variants.legacy_id`,
      [[77, 174, 175, 184, 237]],
    )
    expect(stocks.rows).toEqual([
      { legacy_id: '77', stock_quantity: 0, current_cost: '0.00' },
      { legacy_id: '174', stock_quantity: 0, current_cost: '50.00' },
      { legacy_id: '175', stock_quantity: 0, current_cost: '50.00' },
      { legacy_id: '184', stock_quantity: 3, current_cost: '50.00' },
      { legacy_id: '237', stock_quantity: 1, current_cost: '80.00' },
    ])

    const legacyState = await pool.query<{ legacy_id: string; status: string; ordered: string; received: string; pending: string; receipts: string }>(
      `SELECT po.legacy_id::text, po.status,
              sum(poi.ordered_quantity)::text AS ordered,
              sum(poi.received_quantity)::text AS received,
              sum(poi.ordered_quantity - poi.received_quantity)::text AS pending,
              (SELECT count(*)::text FROM goods_receipts gr WHERE gr.purchase_order_id = po.id) AS receipts
       FROM purchase_orders po JOIN purchase_order_items poi ON poi.purchase_order_id = po.id
       WHERE po.legacy_id IN (2, 5)
       GROUP BY po.id ORDER BY po.legacy_id`,
    )
    expect(legacyState.rows).toEqual([
      { legacy_id: '2', status: 'fully_received', ordered: '74', received: '74', pending: '0', receipts: '1' },
      { legacy_id: '5', status: 'fully_received', ordered: '60', received: '60', pending: '0', receipts: '0' },
    ])

    const createdOrders = await pool.query<{ ordered: string; final_amount: string; received: string; receipts: string }>(
      `SELECT sum(poi.ordered_quantity)::text AS ordered, po.final_amount::text,
              sum(poi.received_quantity)::text AS received,
              (SELECT count(*)::text FROM goods_receipts gr WHERE gr.purchase_order_id = po.id) AS receipts
       FROM purchase_orders po JOIN purchase_order_items poi ON poi.purchase_order_id = po.id
       WHERE po.id = ANY($1::uuid[]) GROUP BY po.id ORDER BY po.final_amount`,
      [applied.orders.map((order) => order.id)],
    )
    expect(createdOrders.rows).toEqual([
      { ordered: '8', final_amount: '50.00', received: '0', receipts: '0' },
      { ordered: '20', final_amount: '1094.00', received: '0', receipts: '0' },
    ])

    const newModels = await pool.query<{ club: string; model: string; variants: string; masculine: string }>(
      `SELECT p.club, p.model, count(v.id)::text AS variants,
              count(*) FILTER (WHERE v.type = 'Masculina')::text AS masculine
       FROM products p JOIN product_variants v ON v.product_id = p.id
       WHERE (p.club, p.model) IN (('ALEMANHA', 'PLAYER'), ('FLAMENGO', 'III 2026'),
                                  ('VASCO', 'TREINO CINZA'), ('BOTAFOGO', 'I 2026'), ('BOTAFOGO', 'III 2026'))
       GROUP BY p.club, p.model ORDER BY p.club, p.model`,
    )
    expect(newModels.rows).toEqual([
      { club: 'ALEMANHA', model: 'PLAYER', variants: '2', masculine: '2' },
      { club: 'BOTAFOGO', model: 'I 2026', variants: '4', masculine: '4' },
      { club: 'BOTAFOGO', model: 'III 2026', variants: '4', masculine: '4' },
      { club: 'FLAMENGO', model: 'III 2026', variants: '4', masculine: '4' },
      { club: 'VASCO', model: 'TREINO CINZA', variants: '1', masculine: '1' },
    ])

    const movements = await pool.query<{ total: string; reconciliation: string }>(
      `SELECT count(*)::text AS total,
              count(*) FILTER (WHERE type = 'manual_adjustment' AND source_entity_type = 'gemini_conference')::text AS reconciliation
       FROM inventory_movements`,
    )
    expect(movements.rows[0]).toEqual({ total: '6', reconciliation: '5' })

    const beforeReplay = await snapshot()
    const replay = await runGeminiConferenceMigration(pool, { mode: 'apply', actorUserId })
    expect(replay.reused).toBe(true)
    expect(await snapshot()).toEqual(beforeReplay)
  })

  async function seedCatalog() {
    const products = [
      ['BRASIL', 'AZUL'], ['BRASIL', 'GOLEIRO'], ['BRASIL', 'AMARELA'],
      ['VASCO', '2025 BRANCA'], ['VASCO', 'MARROM'], ['BRASIL', '2002 RONALDO'],
    ] as const
    const productIds = new Map<string, string>()
    for (const [club, model] of products) {
      const id = randomUUID()
      productIds.set(`${club}/${model}`, id)
      await pool.query('INSERT INTO products (id, club, model) VALUES ($1, $2, $3)', [id, club, model])
    }
    const variants = [
      [77, 'VASCO', '2025 BRANCA', 'Feminina', 'GG', 1, '0.00'],
      [174, 'VASCO', 'MARROM', 'Masculina', 'GG', 1, '50.00'],
      [175, 'VASCO', 'MARROM', 'Masculina', '4GG', 1, '50.00'],
      [184, 'BRASIL', 'AMARELA', 'Masculina', 'GG', 1, '50.00'],
      [237, 'BRASIL', '2002 RONALDO', 'Masculina', 'GG', 0, '80.00'],
      [1001, 'BRASIL', 'AZUL', 'Masculina', 'P', 0, '50.00'],
      [1002, 'BRASIL', 'AZUL', 'Masculina', 'M', 0, '50.00'],
      [1003, 'BRASIL', 'AZUL', 'Masculina', 'G', 0, '50.00'],
      [1004, 'BRASIL', 'AZUL', 'Masculina', 'GG', 0, '50.00'],
      [1005, 'BRASIL', 'GOLEIRO', 'Masculina', 'G', 0, '50.00'],
      [1006, 'BRASIL', 'AMARELA', 'Masculina', '2GG', 0, '50.00'],
    ] as const
    for (const [legacyId, club, model, type, size, stock, cost] of variants) {
      await pool.query(
        `INSERT INTO product_variants
           (id, product_id, legacy_id, type, size, sku, sale_price, current_cost, stock_quantity)
         VALUES ($1, $2, $3, $4, $5, $6, 150.00, $7, $8)`,
        [randomUUID(), productIds.get(`${club}/${model}`), legacyId, type, size, `fixture:${legacyId}`, cost, stock],
      )
    }
  }

  async function seedLegacyOrders() {
    const suppliers = new Map<string, string>()
    for (const name of ['KAKARIC/MARCIO', 'ANIEE']) {
      const id = randomUUID()
      suppliers.set(name, id)
      await pool.query('INSERT INTO suppliers (id, name, legacy_name) VALUES ($1, $2, $2)', [id, name])
    }
    const variant = await pool.query<{ id: string }>('SELECT id FROM product_variants WHERE legacy_id = 1001')
    const createOrder = async (legacyId: number, supplier: string, status: string, ordered: number, received: number) => {
      const orderId = randomUUID()
      const itemId = randomUUID()
      await pool.query(
        `INSERT INTO purchase_orders
           (id, legacy_id, supplier_id, created_by, status, ordered_on, estimated_items_amount, final_amount)
         VALUES ($1, $2, $3, $4, $5, '2026-05-01', $6, $6)`,
        [orderId, legacyId, suppliers.get(supplier), actorUserId, status, ordered * 50],
      )
      await pool.query(
        `INSERT INTO purchase_order_items
           (id, purchase_order_id, variant_id, ordered_quantity, received_quantity, supplier_unit_cost, final_unit_cost)
         VALUES ($1, $2, $3, $4, $5, 50.00, 50.00)`,
        [itemId, orderId, variant.rows[0]!.id, ordered, received],
      )
      return { orderId, itemId }
    }
    const partial = await createOrder(2, 'KAKARIC/MARCIO', 'partially_received', 74, 48)
    await pool.query(
      `INSERT INTO goods_receipts (id, purchase_order_id, received_by, idempotency_key, received_at)
       VALUES ($1, $2, $3, $4, '2026-05-02')`,
      [randomUUID(), partial.orderId, actorUserId, `fixture-receipt-${partial.orderId}`],
    )
    const receipt = await pool.query<{ id: string }>('SELECT id FROM goods_receipts WHERE purchase_order_id = $1', [partial.orderId])
    await pool.query(
      `INSERT INTO goods_receipt_items (id, goods_receipt_id, purchase_order_item_id, quantity, final_unit_cost)
       VALUES ($1, $2, $3, 48, 50.00)`,
      [randomUUID(), receipt.rows[0]!.id, partial.itemId],
    )
    await pool.query(
      `INSERT INTO inventory_movements
         (id, variant_id, type, quantity_delta, balance_after, unit_cost, source_entity_type, source_entity_id, idempotency_key, user_id)
       VALUES ($1, $2, 'purchase_receipt', 48, 48, 50.00, 'goods_receipt', $3, $4, $5)`,
      [randomUUID(), variant.rows[0]!.id, receipt.rows[0]!.id, `fixture-movement-${partial.orderId}`, actorUserId],
    )
    await createOrder(5, 'ANIEE', 'placed', 60, 0)
  }

  async function snapshot() {
    const result = await pool.query<{ products: string; variants: string; orders: string; receipts: string; movements: string; runs: string }>(
      `SELECT (SELECT count(*)::text FROM products) AS products,
              (SELECT count(*)::text FROM product_variants) AS variants,
              (SELECT count(*)::text FROM purchase_orders) AS orders,
              (SELECT count(*)::text FROM goods_receipts) AS receipts,
              (SELECT count(*)::text FROM inventory_movements) AS movements,
              (SELECT count(*)::text FROM migration_runs) AS runs`,
    )
    return result.rows[0]
  }
})
