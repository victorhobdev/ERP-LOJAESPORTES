import type { Pool } from 'pg'

import type { NormalizedGeminiDump } from './gemini-dump.js'

export type ReconciliationReport = {
  generatedAt: string
  products: { legacyRows: number; migratedProducts: number; migratedVariants: number; rejected: number }
  stockBySku: { matched: number; divergent: Array<{ sku: string; legacyStock: number; migratedStock: number }> }
  unitsSold: { legacyTotal: number; migratedTotal: number; divergent: Array<{ sku: string; legacyUnits: number; migratedUnits: number }> }
  sales: { legacyRows: number; legacyTotal: string; migratedRows: number; migratedTotal: string }
  payments: { legacyPaidTotal: string; migratedPaidTotal: string }
  receivables: { legacyPendingTotal: string; migratedOutstandingTotal: string }
  purchases: { legacyOrders: number; migratedOrders: number; byStatus: Record<string, number>; receivedUnits: number; pendingUnits: number }
  customerOrders: { legacyRows: number; migratedOrders: number; byStatus: Record<string, number> }
  images: { referenced: number; linked: number; pendingFiles: number }
  knownDivergences: string[]
}

/**
 * Compara o dump normalizado com o estado migrado no PostgreSQL. Toda diferença deve
 * ser explicável por rejeições tipadas da migração (linhas em migration_rejections) —
 * o relatório lista essas explicações em knownDivergences e é determinístico: mesma
 * entrada, mesma saída.
 */
export async function buildReconciliationReport(pool: Pool, dump: NormalizedGeminiDump): Promise<ReconciliationReport> {
  const variantRows = await pool.query<{ legacy_id: number | string | null; sku: string; stock: string }>(
    `SELECT v.legacy_id, v.sku, v.stock_quantity::text AS stock
     FROM product_variants v
     WHERE v.legacy_id IS NOT NULL`,
  )
  const stockByLegacyId = new Map(variantRows.rows.map((row) => [Number(row.legacy_id), Number(row.stock)]))
  const skuByLegacyId = new Map(variantRows.rows.map((row) => [Number(row.legacy_id), row.sku]))

  const stockDivergent: ReconciliationReport['stockBySku']['divergent'] = []
  let stockMatched = 0
  const legacyStockByLegacyId = new Map(dump.products.map((row) => [row.legacyId, row.stockQuantity]))
  for (const [legacyId, legacyStock] of legacyStockByLegacyId) {
    const migrated = stockByLegacyId.get(legacyId)
    if (migrated === undefined) continue // variante rejeitada: explicada em knownDivergences
    if (migrated === legacyStock) stockMatched += 1
    else stockDivergent.push({ sku: skuByLegacyId.get(legacyId) ?? String(legacyId), legacyStock, migratedStock: migrated })
  }

  const legacyUnitsByProduct = new Map<number, number>()
  for (const sale of dump.sales) {
    for (const item of sale.items) {
      legacyUnitsByProduct.set(item.legacyProductId, (legacyUnitsByProduct.get(item.legacyProductId) ?? 0) + item.quantity)
    }
  }
  const migratedUnitsRows = await pool.query<{ legacy_id: number | string; units: string }>(
    `SELECT v.legacy_id, sum(si.quantity)::text AS units
     FROM sale_items si JOIN product_variants v ON v.id = si.variant_id
     WHERE v.legacy_id IS NOT NULL
     GROUP BY v.legacy_id`,
  )
  const migratedUnits = new Map(migratedUnitsRows.rows.map((row) => [Number(row.legacy_id), Number(row.units)]))
  const unitsDivergent: ReconciliationReport['unitsSold']['divergent'] = []
  let legacyUnitsTotal = 0
  let migratedUnitsTotal = 0
  for (const [legacyId, legacyUnits] of legacyUnitsByProduct) {
    legacyUnitsTotal += legacyUnits
    const migrated = migratedUnits.get(legacyId)
    migratedUnitsTotal += migrated ?? 0
    if ((migrated ?? 0) !== legacyUnits) {
      unitsDivergent.push({ sku: skuByLegacyId.get(legacyId) ?? String(legacyId), legacyUnits, migratedUnits: migrated ?? 0 })
    }
  }
  for (const [legacyId, units] of migratedUnits) {
    if (!legacyUnitsByProduct.has(legacyId) && units > 0) {
      unitsDivergent.push({ sku: skuByLegacyId.get(legacyId) ?? String(legacyId), legacyUnits: 0, migratedUnits: units })
    }
  }

  const cents = (value: string) => {
    const [whole, fraction = ''] = value.split('.')
    return BigInt(whole ?? '0') * 100n + BigInt(fraction.padEnd(2, '0'))
  }
  const money = (value: bigint) => `${value < 0n ? '-' : ''}${(value < 0n ? -value : value) / 100n}.${String((value < 0n ? -value : value) % 100n).padStart(2, '0')}`
  const legacySalesTotal = dump.sales.reduce((total, sale) => total + cents(sale.finalAmount), 0n)
  const legacyPaidTotal = dump.sales.reduce((total, sale) => total + cents(sale.paidAmount), 0n)
  const legacyPendingTotal = dump.sales
    .filter((sale) => sale.paymentStatus === 'Pendente')
    .reduce((total, sale) => total + cents(sale.finalAmount) - cents(sale.paidAmount), 0n)

  const salesRow = await pool.query<{ rows: string; total: string }>(
    `SELECT count(*)::text AS rows, coalesce(sum(final_amount), 0)::text AS total
     FROM sales WHERE legacy_id IS NOT NULL AND status <> 'reversed'`,
  )
  const paymentsRow = await pool.query<{ total: string }>(
    `SELECT coalesce(sum(p.amount), 0)::text AS total
     FROM payments p JOIN sales s ON s.id = p.sale_id
     WHERE s.legacy_id IS NOT NULL AND p.status = 'confirmed'`,
  )
  const receivablesRow = await pool.query<{ total: string }>(
    `SELECT coalesce(sum(s.final_amount - coalesce(pp.paid, 0)), 0)::text AS total
     FROM sales s
     LEFT JOIN (SELECT sale_id, sum(amount) AS paid FROM payments WHERE status = 'confirmed' GROUP BY sale_id) pp ON pp.sale_id = s.id
     WHERE s.legacy_id IS NOT NULL AND s.status IN ('pending', 'partially_paid')`,
  )
  const productsRow = await pool.query<{ products: string; variants: string }>(
    `SELECT (SELECT count(*) FROM products WHERE id IN (SELECT product_id FROM product_variants WHERE legacy_id IS NOT NULL))::text AS products,
            (SELECT count(*) FROM product_variants WHERE legacy_id IS NOT NULL)::text AS variants`,
  )
  const rejectedRow = await pool.query<{ total: string }>(
    `SELECT count(*)::text AS total FROM migration_rejections WHERE source_table = 'produtos'`,
  )

  const purchasesRow = await pool.query<{ total: string }>(
    `SELECT count(*)::text AS total FROM purchase_orders WHERE legacy_id IS NOT NULL`,
  )
  const purchaseStatusRows = await pool.query<{ status: string; total: string }>(
    `SELECT status, count(*)::text AS total FROM purchase_orders WHERE legacy_id IS NOT NULL GROUP BY status`,
  )
  const purchaseUnitsRow = await pool.query<{ received: string; pending: string }>(
    `SELECT coalesce(sum(received_quantity), 0)::text AS received,
            coalesce(sum(ordered_quantity - received_quantity), 0)::text AS pending
     FROM purchase_order_items
     WHERE purchase_order_id IN (SELECT id FROM purchase_orders WHERE legacy_id IS NOT NULL)`,
  )
  const customerOrdersRow = await pool.query<{ total: string }>(
    `SELECT count(*)::text AS total FROM customer_orders WHERE legacy_id IS NOT NULL`,
  )
  const customerOrderStatusRows = await pool.query<{ status: string; total: string }>(
    `SELECT status, count(*)::text AS total FROM customer_orders WHERE legacy_id IS NOT NULL GROUP BY status`,
  )
  const mediaLinkedRow = await pool.query<{ total: string }>(
    `SELECT count(*)::text AS total FROM media`,
  )
  const rejectionRows = await pool.query<{ reason_code: string; total: string }>(
    `SELECT reason_code, count(*)::text AS total FROM migration_rejections GROUP BY reason_code ORDER BY reason_code`,
  )

  const imageReferenced = dump.products.filter((row) => row.imagePath).length
  const mediaLinked = Number(mediaLinkedRow.rows[0]?.total ?? '0')

  const knownDivergences: string[] = []
  const rejectedSales = await pool.query<{ legacy_id: string }>(
    `SELECT DISTINCT r.legacy_id FROM migration_rejections r
     WHERE r.source_table = 'vendas'
       AND NOT EXISTS (SELECT 1 FROM sales s WHERE s.legacy_id::text = r.legacy_id)`,
  )
  const rejectedIds = new Set(rejectedSales.rows.map((row) => String(row.legacy_id)))
  const rejected = dump.sales.filter((sale) => rejectedIds.has(String(sale.legacyId)))
  const accepted = dump.sales.filter((sale) => !rejectedIds.has(String(sale.legacyId)))
  const rejectedTotal = rejected.reduce((sum, sale) => sum + cents(sale.finalAmount), 0n)
  const rejectedPending = rejected.filter((sale) => sale.paymentStatus === 'Pendente')
    .reduce((sum, sale) => sum + cents(sale.finalAmount) - cents(sale.paidAmount), 0n)
  const expectedPaid = accepted.reduce((sum, sale) => sum + cents(sale.paymentStatus === 'Pago' ? sale.finalAmount : sale.paidAmount), 0n)
  const aggregates = [
    ['SALES_REJECTED_TOTAL', legacySalesTotal, cents(salesRow.rows[0]?.total ?? '0'), legacySalesTotal - rejectedTotal],
    ['PAID_STATUS_AUTHORITATIVE', legacyPaidTotal, cents(paymentsRow.rows[0]?.total ?? '0'), expectedPaid],
    ['RECEIVABLES_REJECTED_TOTAL', legacyPendingTotal, cents(receivablesRow.rows[0]?.total ?? '0'), legacyPendingTotal - rejectedPending],
  ] as const
  for (const [code, legacy, migrated, expected] of aggregates) {
    if (legacy !== migrated || migrated !== expected) {
      knownDivergences.push(`${migrated === expected ? code : 'UNEXPLAINED_' + code}: legado=${money(legacy)}; migrado=${money(migrated)}; esperado=${money(expected)}; residual=${money(migrated - expected)}`)
    }
  }
  for (const row of rejectionRows.rows) {
    if (Number(row.total) > 0) knownDivergences.push(`${row.total} linha(s) rejeitada(s) com ${row.reason_code}`)
  }
  if (unitsDivergent.length > 0) {
    knownDivergences.push(`${unitsDivergent.length} SKU(s) com quantidade vendida divergente (vendas rejeitadas referem-se a produtos migrados)`)
  }
  if (stockDivergent.length > 0) {
    knownDivergences.push(`${stockDivergent.length} SKU(s) com saldo divergente do legado`)
  }
  knownDivergences.push(`imagens: ${imageReferenced} caminho(s) referenciado(s) no dump, ${mediaLinked} arquivo(s) em media (o dump não traz os arquivos)`)

  return {
    generatedAt: new Date().toISOString(),
    products: {
      legacyRows: dump.products.length,
      migratedProducts: Number(productsRow.rows[0]?.products ?? '0'),
      migratedVariants: Number(productsRow.rows[0]?.variants ?? '0'),
      rejected: Number(rejectedRow.rows[0]?.total ?? '0'),
    },
    stockBySku: { matched: stockMatched, divergent: stockDivergent },
    unitsSold: { legacyTotal: legacyUnitsTotal, migratedTotal: migratedUnitsTotal, divergent: unitsDivergent },
    sales: {
      legacyRows: dump.sales.length,
      legacyTotal: money(legacySalesTotal),
      migratedRows: Number(salesRow.rows[0]?.rows ?? '0'),
      migratedTotal: salesRow.rows[0]?.total ?? '0.00',
    },
    payments: {
      legacyPaidTotal: money(legacyPaidTotal),
      migratedPaidTotal: paymentsRow.rows[0]?.total ?? '0.00',
    },
    receivables: {
      legacyPendingTotal: money(legacyPendingTotal),
      migratedOutstandingTotal: receivablesRow.rows[0]?.total ?? '0.00',
    },
    purchases: {
      legacyOrders: dump.purchases.length,
      migratedOrders: Number(purchasesRow.rows[0]?.total ?? '0'),
      byStatus: Object.fromEntries(purchaseStatusRows.rows.map((row) => [row.status, Number(row.total)])),
      receivedUnits: Number(purchaseUnitsRow.rows[0]?.received ?? '0'),
      pendingUnits: Number(purchaseUnitsRow.rows[0]?.pending ?? '0'),
    },
    customerOrders: {
      legacyRows: dump.customerOrders.length,
      migratedOrders: Number(customerOrdersRow.rows[0]?.total ?? '0'),
      byStatus: Object.fromEntries(customerOrderStatusRows.rows.map((row) => [row.status, Number(row.total)])),
    },
    images: { referenced: imageReferenced, linked: mediaLinked, pendingFiles: imageReferenced - mediaLinked },
    knownDivergences,
  }
}
