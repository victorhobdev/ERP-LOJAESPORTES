import { randomUUID } from 'node:crypto'

import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { applyMigrations } from '../../shared/db/migrate.js'
import { migrateLegacySales } from './legacy-sales.js'

const connectionString = process.env['TEST_DATABASE_URL']
if (!connectionString) throw new Error('TEST_DATABASE_URL is required for PostgreSQL integration tests.')

describe('legacy sales migration', () => {
  const adminPool = new Pool({ connectionString, max: 1 })
  const schema = `erp2_test_${randomUUID().replaceAll('-', '')}`
  const actorUserId = randomUUID()
  const sourceName = 'fixture-vendas'
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
       VALUES ($1, 'migrador.vendas', 'Migrador Vendas', 'unused-in-this-test', $2)`,
      [actorUserId, '00000000-0000-4000-8000-000000000004'],
    )
    for (const legacyId of [1, 2, 3]) {
      const productId = randomUUID()
      const variantId = randomUUID()
      await pool.query('INSERT INTO products (id, club, model) VALUES ($1, $2, $3)', [productId, `Migrada FC ${legacyId}`, 'Home'])
      await pool.query(
        `INSERT INTO product_variants (id, product_id, legacy_id, type, size, sku, sale_price, current_cost, stock_quantity)
         VALUES ($1, $2, $3, 'Masculina', 'M', $4, 150.00, 80.00, 5)`,
        [variantId, productId, legacyId, `LEG-${legacyId}`],
      )
    }
  }, 120_000)

  afterAll(async () => {
    await pool?.end()
    if (schema.startsWith('erp2_test_')) await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`)
    await adminPool.end()
  })

  function saleRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      legacyId: 101,
      soldOn: '2025-06-10T14:30:00.000-03:00',
      customer: { legacyId: 2, name: 'João da Silva', contact: '(21) 99999-1111' },
      itemsTotal: '300.00',
      discount: '10.00',
      finalAmount: '290.00',
      paymentStatus: 'Pago',
      promisedDueDate: null,
      paidAmount: '290.00',
      paymentMethod: 'Pix',
      items: [
        { legacyProductId: 1, quantity: 1, unitPrice: '150.00', unitCost: '80.00' },
        { legacyProductId: 2, quantity: 1, unitPrice: '150.00', unitCost: '80.00' },
      ],
      ...overrides,
    }
  }

  function baseRows(): Array<Record<string, unknown>> {
    return [
      saleRow(),
      saleRow({
        legacyId: 102,
        soldOn: '2025-06-12T10:00:00.000-03:00',
        customer: { legacyId: 4, name: 'Carlos Souza', contact: null },
        itemsTotal: '480.00',
        discount: '0.00',
        finalAmount: '480.00',
        paymentStatus: 'Pendente',
        promisedDueDate: '2025-12-25',
        paidAmount: '0.00',
        paymentMethod: 'Cartão de Crédito',
        items: [{ legacyProductId: 3, quantity: 3, unitPrice: '160.00', unitCost: '85.00' }],
      }),
      saleRow({ legacyId: 103, finalAmount: '250.00' }),
      saleRow({ legacyId: 104, paidAmount: '130.00' }),
      saleRow({ legacyId: 105, items: [{ legacyProductId: 999, quantity: 2, unitPrice: '150.00', unitCost: '80.00' }] }),
      saleRow({ legacyId: 106, paymentStatus: 'Pendente', promisedDueDate: null, paidAmount: '0.00', customer: { legacyId: 5, name: 'Ana Pereira', contact: null } }),
      saleRow({ legacyId: 107, itemsTotal: '450.00', discount: '0.00', finalAmount: '450.00', paidAmount: '450.00', items: [
        { legacyProductId: 1, quantity: 1, unitPrice: '150.00', unitCost: '80.00' },
        { legacyProductId: 1, quantity: 2, unitPrice: '150.00', unitCost: '80.00' },
      ] }),
      saleRow({ legacyId: 108, paymentMethod: 'Boleto' }),
      saleRow({
        legacyId: 109,
        soldOn: '2025-06-13T10:00:00.000-03:00',
        customer: null,
        itemsTotal: '160.00',
        discount: '0.00',
        finalAmount: '160.00',
        paymentStatus: 'Pendente',
        promisedDueDate: '2025-12-26',
        paidAmount: '0.00',
        paymentMethod: null,
        items: [{ legacyProductId: 1, quantity: 1, unitPrice: '160.00', unitCost: '80.00' }],
      }),
      saleRow({
        legacyId: 110,
        soldOn: '2025-06-14T10:00:00.000-03:00',
        customer: { legacyId: 6, name: 'Rita Campos', contact: null },
        itemsTotal: '160.00',
        discount: '0.00',
        finalAmount: '160.00',
        paymentStatus: 'Pendente',
        promisedDueDate: '2025-01-01',
        paidAmount: '0.00',
        paymentMethod: null,
        items: [{ legacyProductId: 2, quantity: 1, unitPrice: '160.00', unitCost: '80.00' }],
      }),
    ]
  }

  it('imports reconciled sales with payments, links customers and reports every rejection', async () => {
    const report = await migrateLegacySales(pool, { sourceName, actorUserId, rows: baseRows() })

    expect(report).toMatchObject({
      reused: false,
      counts: {
        sourceRows: 10,
        sales: 3,
        saleItems: 5,
        payments: 2,
        rejectedRows: 7,
      },
    })
    expect(report.sourceChecksum).toMatch(/^[a-f0-9]{64}$/)

    const rejections = await pool.query<{ reason_code: string; legacy_id: string | null }>(
      'SELECT reason_code, legacy_id FROM migration_rejections ORDER BY reason_code, legacy_id NULLS LAST',
    )
    expect(rejections.rows).toEqual([
      { reason_code: 'DUPLICATE_PRODUCT_IN_SALE', legacy_id: '107' },
      { reason_code: 'LEGACY_PRODUCT_NOT_MIGRATED', legacy_id: '105' },
      { reason_code: 'PAYMENT_INCONSISTENT', legacy_id: '108' },
      { reason_code: 'PENDING_SALE_DUE_DATE_PAST', legacy_id: '110' },
      { reason_code: 'PENDING_SALE_MISSING_CUSTOMER', legacy_id: '109' },
      { reason_code: 'PENDING_SALE_MISSING_DUE_DATE', legacy_id: '106' },
      { reason_code: 'SALE_TOTAL_MISMATCH', legacy_id: '103' },
    ])
    const pendingRejection = await pool.query<{ reason_code: string }>(
      `SELECT reason_code FROM migration_rejections WHERE legacy_id = '106'`,
    )
    expect(pendingRejection.rows[0]?.reason_code).toBe('PENDING_SALE_MISSING_DUE_DATE')

    const customerlessPartialRows = await pool.query<{ sales: string; items: string; payments: string }>(
      `SELECT (SELECT count(*) FROM sales WHERE legacy_id = 109) AS sales,
              (SELECT count(*) FROM sale_items WHERE sale_id NOT IN (SELECT id FROM sales)) AS items,
              (SELECT count(*) FROM payments) AS payments`,
    )
    expect(customerlessPartialRows.rows[0]).toEqual({ sales: '0', items: '0', payments: '2' })

    const reconciliation = await pool.query<{ sale_status: string; items_value: string; final_amount: string; due_date: string | null; customer_legacy: string | null }>(
      `SELECT s.status AS sale_status,
              (SELECT round(sum(si.quantity * si.unit_price), 2)::text FROM sale_items si WHERE si.sale_id = s.id) AS items_value,
              s.final_amount::text,
              s.payment_due_date::text AS due_date,
              (SELECT c.legacy_id FROM customers c WHERE c.id = s.customer_id) AS customer_legacy
       FROM sales s ORDER BY s.legacy_id`,
    )
    expect(reconciliation.rows).toEqual([
      { sale_status: 'paid', items_value: '300.00', final_amount: '290.00', due_date: null, customer_legacy: '2' },
      { sale_status: 'pending', items_value: '480.00', final_amount: '480.00', due_date: '2025-12-25', customer_legacy: '4' },
      { sale_status: 'paid', items_value: '300.00', final_amount: '290.00', due_date: null, customer_legacy: '2' },
    ])

    const payment = await pool.query<{ legacy: string; amount: string; method: string; status: string; received_at: string }>(
      `SELECT s.legacy_id::text AS legacy, p.amount::text AS amount, p.method AS method, p.status AS status, to_char(p.received_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS received_at
       FROM payments p JOIN sales s ON s.id = p.sale_id ORDER BY s.legacy_id`,
    )
    expect(payment.rows).toEqual([
      { legacy: '101', amount: '290.00', method: 'pix', status: 'confirmed', received_at: '2025-06-10T17:30:00.000Z' },
      { legacy: '104', amount: '290.00', method: 'pix', status: 'confirmed', received_at: '2025-06-10T17:30:00.000Z' },
    ])

    const migration = await pool.query<{ total_final: string; total_items: string }>(
      `SELECT round(sum(final_amount), 2)::text AS total_final,
              (SELECT round(sum(si.quantity * si.unit_price), 2)::text FROM sale_items si) AS total_items
       FROM sales`,
    )
    expect(migration.rows[0]).toEqual({ total_final: '1060.00', total_items: '1080.00' })
  })

  it('reuses an identical source snapshot without duplicating target rows', async () => {
    const replayRows = [
      saleRow({ legacyId: 201, soldOn: '2025-08-01T11:00:00.000-03:00', itemsTotal: '150.00', discount: '0.00', finalAmount: '150.00', paidAmount: '150.00', paymentMethod: 'Dinheiro', items: [{ legacyProductId: 1, quantity: 1, unitPrice: '150.00', unitCost: '80.00' }] }),
      saleRow({ legacyId: 202, soldOn: '2025-08-02T11:00:00.000-03:00', customer: { legacyId: 3, name: 'Maria Oliveira', contact: null }, itemsTotal: '480.00', discount: '0.00', finalAmount: '480.00', paymentStatus: 'Pendente', promisedDueDate: '2025-12-31', paidAmount: '0.00', paymentMethod: null, items: [{ legacyProductId: 3, quantity: 3, unitPrice: '160.00', unitCost: '85.00' }] }),
    ]
    const first = await migrateLegacySales(pool, { sourceName: `${sourceName}-replay`, actorUserId, rows: replayRows })
    const second = await migrateLegacySales(pool, { sourceName: `${sourceName}-replay`, actorUserId, rows: replayRows })

    expect(first).toMatchObject({ reused: false, counts: { sourceRows: 2, sales: 2, saleItems: 2, payments: 1, rejectedRows: 0 } })
    expect(second.reused).toBe(true)
    expect(second.runId).toBe(first.runId)
    expect(second.counts).toEqual(first.counts)

    const counts = await pool.query<{ sales: string; items: string; payments: string }>(
      `SELECT (SELECT count(*) FROM sales) AS sales,
              (SELECT count(*) FROM sale_items) AS items,
              (SELECT count(*) FROM payments) AS payments`,
    )
    expect(counts.rows[0]).toEqual({ sales: '5', items: '7', payments: '3' })
  })

  it('classifies already-migrated sales when the snapshot changes instead of duplicating', async () => {
    const changed = [...baseRows(), saleRow({ legacyId: 111, soldOn: '2025-07-01T09:00:00.000-03:00', itemsTotal: '150.00', discount: '0.00', finalAmount: '150.00', paymentStatus: 'Pago', paidAmount: '150.00', paymentMethod: 'Dinheiro', items: [{ legacyProductId: 1, quantity: 1, unitPrice: '150.00', unitCost: '80.00' }] })]
    const report = await migrateLegacySales(pool, { sourceName: `${sourceName}-replay`, actorUserId, rows: changed })

    expect(report.reused).toBe(false)
    expect(report.counts).toMatchObject({ sourceRows: 11, sales: 1, rejectedRows: 10 })
    expect(report.counts.saleItems).toBe(1)

    const rerunRejections = await pool.query<{ reason_code: string }>(
      `SELECT reason_code FROM migration_rejections r
       JOIN migration_runs run ON run.id = r.migration_run_id
       WHERE run.id = $1 AND r.reason_code = 'LEGACY_SALE_ALREADY_MIGRATED'`,
      [report.runId],
    )
    expect(rerunRejections.rows).toHaveLength(3)

    const total = await pool.query<{ sales: string }>('SELECT count(*)::text AS sales FROM sales')
    expect(total.rows[0]?.sales).toBe('6')
  })
})
