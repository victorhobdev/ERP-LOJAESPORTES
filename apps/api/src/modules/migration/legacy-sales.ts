import { randomUUID } from 'node:crypto'

import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'

import { checksum, deterministicUuid } from './legacy-products.js'

const money = z.string().regex(/^(0|[1-9]\d*)\.\d{2}$/)
const legacySaleSchema = z.object({
  legacyId: z.number().int().positive(),
  soldOn: z.iso.datetime({ offset: true }),
  customer: z.object({
    legacyId: z.number().int().positive(),
    name: z.string().trim().min(1).max(255),
    contact: z.string().trim().max(255).nullish(),
  }).nullish(),
  itemsTotal: money,
  discount: money,
  finalAmount: money,
  paymentStatus: z.enum(['Pago', 'Pendente']),
  promisedDueDate: z.iso.date().nullish(),
  paidAmount: money,
  paymentMethod: z.string().trim().min(1).max(50).nullish(),
  items: z.array(z.object({
    legacyProductId: z.number().int().positive(),
    quantity: z.number().int().positive(),
    unitPrice: money,
    unitCost: money,
  })).min(1),
})

type LegacySale = z.infer<typeof legacySaleSchema>
type Rejection = {
  raw: unknown
  legacyId: string | null
  reasonCode:
    | 'INVALID_LEGACY_SALE'
    | 'LEGACY_SALE_ALREADY_MIGRATED'
    | 'LEGACY_PRODUCT_NOT_MIGRATED'
    | 'SALE_TOTAL_MISMATCH'
    | 'PENDING_SALE_MISSING_CUSTOMER'
    | 'PENDING_SALE_MISSING_DUE_DATE'
    | 'PENDING_SALE_DUE_DATE_PAST'
    | 'PAYMENT_INCONSISTENT'
    | 'DUPLICATE_PRODUCT_IN_SALE'
  reason: string
}
type MigrationCounts = {
  sourceRows: number
  sales: number
  saleItems: number
  payments: number
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

const paymentMethodByLegacyName: Record<string, string> = {
  'Dinheiro': 'cash',
  'Pix': 'pix',
  'Cartão de Débito': 'debit_card',
  'Cartão de Crédito': 'credit_card',
  'Transferência Bancária': 'bank_transfer',
}

function toCents(value: string): bigint {
  return BigInt(value.replace('.', ''))
}

export async function migrateLegacySales(pool: Pool, input: MigrationInput): Promise<MigrationReport> {
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
    const importable: LegacySale[] = []
    for (const raw of input.rows) {
      const parsed = legacySaleSchema.safeParse(raw)
      if (!parsed.success) {
        rejections.push({ raw, legacyId: legacyIdOf(raw), reasonCode: 'INVALID_LEGACY_SALE', reason: 'A linha não atende ao contrato de venda legado.' })
        continue
      }
      const rejection = classifySale(parsed.data)
      if (rejection) {
        rejections.push({ raw, legacyId: String(parsed.data.legacyId), ...rejection })
      } else {
        importable.push(parsed.data)
      }
    }

    let sales = 0
    let saleItems = 0
    let payments = 0
    for (const sale of importable) {
      const migrated = await client.query('SELECT 1 FROM sales WHERE legacy_id = $1', [sale.legacyId])
      if (migrated.rowCount) {
        rejections.push({ raw: sale, legacyId: String(sale.legacyId), reasonCode: 'LEGACY_SALE_ALREADY_MIGRATED', reason: 'A venda legada já foi migrada.' })
        continue
      }
      const variantIds = new Map<number, string>()
      let missingProduct = false
      for (const item of sale.items) {
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
        rejections.push({ raw: sale, legacyId: String(sale.legacyId), reasonCode: 'LEGACY_PRODUCT_NOT_MIGRATED', reason: 'Um dos produtos da venda não foi migrado.' })
        continue
      }

      const saleId = deterministicUuid(`${sourceName}:vendas:${sale.legacyId}`)
      const customerId = await resolveCustomerId(client, sourceName, sale.customer)
      const isPaid = sale.paymentStatus === 'Pago'
      const paymentAmount = isPaid ? sale.finalAmount : sale.paidAmount
      const status = isPaid ? 'paid' : toCents(paymentAmount) > 0n ? 'partially_paid' : 'pending'
      await client.query(
        `INSERT INTO sales (id, legacy_id, customer_id, operator_id, status, subtotal_amount, discount_amount, final_amount, payment_due_date, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)`,
        [saleId, sale.legacyId, customerId, actorUserId, status, sale.itemsTotal, sale.discount, sale.finalAmount, sale.promisedDueDate ?? null, sale.soldOn],
      )
      for (const item of sale.items) {
        await client.query(
          `INSERT INTO sale_items (id, sale_id, variant_id, quantity, unit_price, unit_cost, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [deterministicUuid(`${sourceName}:itensvenda:${sale.legacyId}:${item.legacyProductId}`), saleId, variantIds.get(item.legacyProductId), item.quantity, item.unitPrice, item.unitCost, sale.soldOn],
        )
        saleItems += 1
      }
      if (toCents(paymentAmount) > 0n) {
        const method = sale.paymentMethod ? paymentMethodByLegacyName[sale.paymentMethod] : undefined
        await client.query(
          `INSERT INTO payments (id, sale_id, received_by, amount, method, status, idempotency_key, received_at, created_at)
           VALUES ($1, $2, $3, $4, $5, 'confirmed', $6, $7, $7)`,
          [deterministicUuid(`${sourceName}:pagamentos:${sale.legacyId}`), saleId, actorUserId, paymentAmount, method ?? null, `${sourceName}:vendas:${sale.legacyId}`, sale.soldOn],
        )
        payments += 1
      }
      sales += 1
    }

    for (const rejection of rejections) {
      await client.query(
        `INSERT INTO migration_rejections
           (id, migration_run_id, source_table, legacy_id, reason_code, reason, source_data)
         VALUES ($1, $2, 'vendas', $3, $4, $5, $6)`,
        [randomUUID(), runId, rejection.legacyId, rejection.reasonCode, rejection.reason, JSON.stringify(rejection.raw)],
      )
    }

    const counts: MigrationCounts = {
      sourceRows: input.rows.length,
      sales, saleItems, payments,
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

function classifySale(sale: LegacySale): Pick<Rejection, 'reasonCode' | 'reason'> | undefined {
  const itemsCents = sale.items.reduce((total, item) => total + toCents(item.unitPrice) * BigInt(item.quantity), 0n)
  if (itemsCents !== toCents(sale.itemsTotal)) {
    return { reasonCode: 'SALE_TOTAL_MISMATCH', reason: 'A soma dos itens não confere com o total informado.' }
  }
  if (itemsCents - toCents(sale.discount) !== toCents(sale.finalAmount)) {
    return { reasonCode: 'SALE_TOTAL_MISMATCH', reason: 'O valor final não confere com total menos desconto.' }
  }
  const productIds = sale.items.map((item) => item.legacyProductId)
  if (new Set(productIds).size !== productIds.length) {
    return { reasonCode: 'DUPLICATE_PRODUCT_IN_SALE', reason: 'A mesma variação aparece mais de uma vez na venda.' }
  }
  const paidCents = toCents(sale.paidAmount)
  const finalCents = toCents(sale.finalAmount)
  if (sale.paymentStatus === 'Pendente' && !sale.customer) {
    return { reasonCode: 'PENDING_SALE_MISSING_CUSTOMER', reason: 'Venda pendente exige cliente identificado.' }
  }
  if (sale.paymentStatus === 'Pendente' && !sale.promisedDueDate) {
    return { reasonCode: 'PENDING_SALE_MISSING_DUE_DATE', reason: 'Venda pendente exige data prometida de pagamento.' }
  }
  if (sale.paymentStatus === 'Pendente' && sale.promisedDueDate && sale.promisedDueDate <= sale.soldOn.slice(0, 10)) {
    return { reasonCode: 'PENDING_SALE_DUE_DATE_PAST', reason: 'Venda pendente exige data prometida posterior à data da venda.' }
  }
  if (sale.paymentStatus === 'Pendente' && (paidCents > finalCents || paidCents === finalCents)) {
    return { reasonCode: 'PAYMENT_INCONSISTENT', reason: 'Venda pendente com valor pago maior ou igual ao final.' }
  }
  const recordsPayment = sale.paymentStatus === 'Pago' ? finalCents > 0n : paidCents > 0n
  if (recordsPayment) {
    const method = sale.paymentMethod ? paymentMethodByLegacyName[sale.paymentMethod] : undefined
    if (!method) {
      return { reasonCode: 'PAYMENT_INCONSISTENT', reason: 'Método de pagamento legado desconhecido.' }
    }
  }
  return undefined
}

async function resolveCustomerId(client: PoolClient, sourceName: string, customer: LegacySale['customer']): Promise<string | null> {
  if (!customer) return null
  const existing = await client.query<{ id: string }>('SELECT id FROM customers WHERE legacy_id = $1', [customer.legacyId])
  if (existing.rows[0]) return existing.rows[0].id
  const id = deterministicUuid(`${sourceName}:clientes:${customer.legacyId}`)
  await client.query(
    'INSERT INTO customers (id, legacy_id, name, contact) VALUES ($1, $2, $3, $4)',
    [id, customer.legacyId, customer.name, customer.contact ?? null],
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
