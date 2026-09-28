import { randomUUID } from 'node:crypto'

import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'

import { checksum, deterministicUuid } from './legacy-products.js'

const money = z.string().regex(/^(0|[1-9]\d*)\.\d{2}$/)

const legacyPurchaseSchema = z.object({
  legacyId: z.number().int().positive(),
  orderedOn: z.iso.date(),
  supplierName: z.string().trim().min(1).max(255).nullish(),
  estimatedItemsAmount: money,
  importFee: money,
  finalAmount: money,
  status: z.enum(['Realizado', 'Recebido Parcialmente', 'Recebido Integralmente']),
  items: z.array(z.object({
    legacyId: z.number().int().positive(),
    legacyProductId: z.number().int().positive(),
    orderedQuantity: z.number().int().positive(),
    supplierUnitCost: money,
    finalUnitCost: money,
    receivedQuantity: z.number().int().min(0),
    receivedOn: z.iso.date().nullish(),
  })),
})

type LegacyPurchase = z.infer<typeof legacyPurchaseSchema>
type Rejection = {
  raw: unknown
  legacyId: string | null
  reasonCode:
    | 'INVALID_LEGACY_PURCHASE'
    | 'LEGACY_ID_ALREADY_MIGRATED'
    | 'LEGACY_SUPPLIER_NAME_MISSING'
    | 'LEGACY_PRODUCT_NOT_MIGRATED'
    | 'RECEIVED_EXCEEDS_ORDERED'
    | 'DUPLICATE_VARIANT_IN_ORDER'
  reason: string
}
type MigrationCounts = {
  sourceRows: number
  purchaseOrders: number
  purchaseOrderItems: number
  receipts: number
  receiptItems: number
  rejectedRows: number
}
type MigrationReport = {
  runId: string
  sourceChecksum: string
  reused: boolean
  counts: MigrationCounts
}
type MigrationInput = {
  sourceName: string
  actorUserId: string
  rows: unknown[]
}

/**
 * Migra `pedidosfornecedor` + `itenspedidofornecedor` para suppliers, purchase_orders,
 * purchase_order_items e goods_receipts. Quantidades recebidas do legado viram
 * recebimentos reais (um goods_receipt por data de recebimento distinta do pedido), e o
 * status do pedido é recalculado a partir das quantidades recebidas — o status do legado
 * é informativo e pode divergir; a divergência fica no relatório de reconciliação.
 */
export async function migrateLegacyPurchases(pool: Pool, input: MigrationInput): Promise<MigrationReport> {
  const sourceName = z.string().trim().min(1).max(200).parse(input.sourceName)
  const actorUserId = z.string().uuid().parse(input.actorUserId)
  const sourceChecksum = checksum(input.rows)
  const previous = await findCompletedRun(pool, sourceName, sourceChecksum)
  if (previous) return { ...previous, reused: true }

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const runId = randomUUID()
    const claimed = await client.query(
      `INSERT INTO migration_runs (id, source_name, source_checksum, status)
       VALUES ($1, $2, $3, 'running')
       ON CONFLICT (source_name, source_checksum) DO NOTHING
       RETURNING id`,
      [runId, sourceName, sourceChecksum],
    )
    if (claimed.rowCount === 0) {
      await client.query('ROLLBACK')
      const concurrent = await findCompletedRun(pool, sourceName, sourceChecksum)
      if (concurrent) return { ...concurrent, reused: true }
      throw new Error('An incomplete migration run already exists for this source snapshot.')
    }

    const rejections: Rejection[] = []
    const importable: LegacyPurchase[] = []
    for (const raw of input.rows) {
      const parsed = legacyPurchaseSchema.safeParse(raw)
      if (!parsed.success) {
        rejections.push({ raw, legacyId: legacyIdOf(raw), reasonCode: 'INVALID_LEGACY_PURCHASE', reason: 'A linha não atende ao contrato de compra legado.' })
        continue
      }
      const purchase = parsed.data
      if (!purchase.supplierName) {
        rejections.push({ raw: purchase, legacyId: String(purchase.legacyId), reasonCode: 'LEGACY_SUPPLIER_NAME_MISSING', reason: 'Pedido sem fornecedor identificado no legado.' })
        continue
      }
      if (purchase.items.some((item) => item.receivedQuantity > item.orderedQuantity)) {
        rejections.push({ raw: purchase, legacyId: String(purchase.legacyId), reasonCode: 'RECEIVED_EXCEEDS_ORDERED', reason: 'Quantidade recebida excede a pedida em algum item.' })
        continue
      }
      const itemProductIds = purchase.items.map((item) => item.legacyProductId)
      if (new Set(itemProductIds).size !== itemProductIds.length) {
        rejections.push({ raw: purchase, legacyId: String(purchase.legacyId), reasonCode: 'DUPLICATE_VARIANT_IN_ORDER', reason: 'A mesma variação aparece mais de uma vez no pedido.' })
        continue
      }
      importable.push(purchase)
    }

    let purchaseOrders = 0
    let purchaseOrderItems = 0
    let receipts = 0
    let receiptItems = 0
    for (const purchase of importable) {
      const migrated = await client.query('SELECT 1 FROM purchase_orders WHERE legacy_id = $1', [purchase.legacyId])
      if (migrated.rowCount) {
        rejections.push({ raw: purchase, legacyId: String(purchase.legacyId), reasonCode: 'LEGACY_ID_ALREADY_MIGRATED', reason: 'O pedido legado já foi migrado.' })
        continue
      }
      const variantIds = new Map<number, string>()
      let missingProduct = false
      for (const item of purchase.items) {
        if (variantIds.has(item.legacyProductId)) continue
        const variant = await client.query<{ id: string }>(
          'SELECT id FROM product_variants WHERE legacy_id = $1', [item.legacyProductId],
        )
        if (!variant.rows[0]) {
          missingProduct = true
          break
        }
        variantIds.set(item.legacyProductId, variant.rows[0].id)
      }
      if (missingProduct) {
        rejections.push({ raw: purchase, legacyId: String(purchase.legacyId), reasonCode: 'LEGACY_PRODUCT_NOT_MIGRATED', reason: 'Um dos produtos do pedido não foi migrado.' })
        continue
      }

      const supplierId = await resolveSupplierId(client, sourceName, purchase.supplierName!)
      const orderId = deterministicUuid(`${sourceName}:pedidosfornecedor:${purchase.legacyId}`)
      const receivedUnits = purchase.items.reduce((total, item) => total + item.receivedQuantity, 0)
      const orderedUnits = purchase.items.reduce((total, item) => total + item.orderedQuantity, 0)
      const status = receivedUnits === 0 ? 'placed' : receivedUnits < orderedUnits ? 'partially_received' : 'fully_received'
      await client.query(
        `INSERT INTO purchase_orders
           (id, legacy_id, supplier_id, created_by, status, ordered_on, estimated_items_amount, import_fee_amount, final_amount, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)`,
        [orderId, purchase.legacyId, supplierId, actorUserId, status, purchase.orderedOn, purchase.estimatedItemsAmount, purchase.importFee, purchase.finalAmount, `${purchase.orderedOn}T12:00:00.000Z`],
      )
      purchaseOrders += 1

      for (const item of purchase.items) {
        const itemId = deterministicUuid(`${sourceName}:itenspedidofornecedor:${item.legacyId}`)
        await client.query(
          `INSERT INTO purchase_order_items
             (id, purchase_order_id, variant_id, ordered_quantity, received_quantity, supplier_unit_cost, final_unit_cost)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [itemId, orderId, variantIds.get(item.legacyProductId), item.orderedQuantity, item.receivedQuantity, item.supplierUnitCost, item.finalUnitCost],
        )
        purchaseOrderItems += 1
      }

      // Um goods_receipt por data de recebimento distinta (legado registra a data por item).
      const byDate = new Map<string, Array<{ itemLegacyId: number; quantity: number; finalUnitCost: string }>>()
      for (const item of purchase.items) {
        if (item.receivedQuantity <= 0) continue
        const date = item.receivedOn ?? purchase.orderedOn
        const list = byDate.get(date) ?? []
        list.push({ itemLegacyId: item.legacyId, quantity: item.receivedQuantity, finalUnitCost: item.finalUnitCost })
        byDate.set(date, list)
      }
      for (const [date, items] of byDate) {
        const receiptId = deterministicUuid(`${sourceName}:recebimentos:${purchase.legacyId}:${date}`)
        const idempotencyKey = `${sourceName}:recebimentos:${purchase.legacyId}:${date}`
        await client.query(
          `INSERT INTO goods_receipts (id, purchase_order_id, received_by, idempotency_key, received_at)
           VALUES ($1, $2, $3, $4, $5)`,
          [receiptId, orderId, actorUserId, idempotencyKey, `${date}T12:00:00.000Z`],
        )
        for (const item of items) {
          await client.query(
            `INSERT INTO goods_receipt_items (id, goods_receipt_id, purchase_order_item_id, quantity, final_unit_cost)
             VALUES ($1, $2, $3, $4, $5)`,
            [deterministicUuid(`${sourceName}:recebimento_itens:${purchase.legacyId}:${date}:${item.itemLegacyId}`), receiptId, deterministicUuid(`${sourceName}:itenspedidofornecedor:${item.itemLegacyId}`), item.quantity, item.finalUnitCost],
          )
          receiptItems += 1
        }
        receipts += 1
      }
    }

    for (const rejection of rejections) {
      await client.query(
        `INSERT INTO migration_rejections
           (id, migration_run_id, source_table, legacy_id, reason_code, reason, source_data)
         VALUES ($1, $2, 'pedidosfornecedor', $3, $4, $5, $6)`,
        [randomUUID(), runId, rejection.legacyId, rejection.reasonCode, rejection.reason, JSON.stringify(rejection.raw)],
      )
    }

    const counts: MigrationCounts = {
      sourceRows: input.rows.length,
      purchaseOrders, purchaseOrderItems, receipts, receiptItems,
      rejectedRows: rejections.length,
    }
    await client.query(
      `UPDATE migration_runs SET status = 'completed', counts = $2, completed_at = now() WHERE id = $1`,
      [runId, JSON.stringify(counts)],
    )
    await client.query('COMMIT')
    return { runId, sourceChecksum, reused: false, counts }
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

async function resolveSupplierId(client: PoolClient, sourceName: string, name: string): Promise<string> {
  const existing = await client.query<{ id: string }>('SELECT id FROM suppliers WHERE lower(name) = lower($1)', [name])
  if (existing.rows[0]) return existing.rows[0].id
  const id = deterministicUuid(`${sourceName}:fornecedores:${name.toLocaleLowerCase('pt-BR')}`)
  await client.query(
    'INSERT INTO suppliers (id, legacy_name, name) VALUES ($1, $2, $3)',
    [id, name, name],
  )
  return id
}

async function findCompletedRun(pool: Pool, sourceName: string, sourceChecksum: string): Promise<Omit<MigrationReport, 'reused'> | undefined> {
  const result = await pool.query<{ id: string; counts: MigrationCounts }>(
    `SELECT id, counts FROM migration_runs
     WHERE source_name = $1 AND source_checksum = $2 AND status = 'completed'`,
    [sourceName, sourceChecksum],
  )
  const row = result.rows[0]
  return row ? { runId: row.id, sourceChecksum, counts: row.counts } : undefined
}

function legacyIdOf(raw: unknown): string | null {
  if (typeof raw === 'object' && raw !== null && 'legacyId' in raw) return String((raw as { legacyId: unknown }).legacyId)
  return null
}
