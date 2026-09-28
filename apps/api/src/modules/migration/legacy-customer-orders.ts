import { randomUUID } from 'node:crypto'

import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'

import { checksum, deterministicUuid } from './legacy-products.js'

const legacyCustomerOrderSchema = z.object({
  legacyId: z.number().int().positive(),
  customer: z.object({
    legacyId: z.number().int().positive(),
    name: z.string().trim().min(1).max(255),
    contact: z.string().trim().max(255).nullish(),
  }).nullish(),
  orderedOn: z.iso.date(),
  club: z.string().trim().min(1).max(150),
  model: z.string().trim().min(1).max(150),
  type: z.enum(['Masculina', 'Feminina', 'Infantil']),
  size: z.string().trim().min(1).max(20),
  notes: z.string().trim().max(2000).nullish(),
  status: z.enum(['Pendente', 'PedidoAoFornecedorFeito', 'ProdutoChegou', 'EntregueAoCliente', 'Cancelada']),
  legacyProductId: z.number().int().positive().nullish(),
})

type LegacyCustomerOrder = z.infer<typeof legacyCustomerOrderSchema>
type Rejection = {
  raw: unknown
  legacyId: string | null
  reasonCode:
    | 'INVALID_LEGACY_CUSTOMER_ORDER'
    | 'LEGACY_ID_ALREADY_MIGRATED'
    | 'LEGACY_CUSTOMER_NOT_MIGRATED'
    | 'LEGACY_PRODUCT_NOT_MIGRATED'
  reason: string
}
type MigrationCounts = {
  sourceRows: number
  customerOrders: number
  events: number
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

const statusByLegacyName: Record<LegacyCustomerOrder['status'], string> = {
  'Pendente': 'pending',
  'PedidoAoFornecedorFeito': 'supplier_ordered',
  'ProdutoChegou': 'product_arrived',
  'EntregueAoCliente': 'delivered',
  'Cancelada': 'cancelled',
}

/**
 * Migra `encomendascliente` para customer_orders + evento inicial na timeline. O cliente
 * precisa ter sido migrado (ou é criado aqui a partir do próprio registro legado); a
 * variante associada, quando informada, precisa existir — senão a linha é rejeitada com
 * código tipado, sem linha parcial. Encomenda cancelada sem motivo no legado recebe o
 * motivo padrão exigido pelo schema de destino (decisão registrada no PROGRESSO).
 */
export async function migrateLegacyCustomerOrders(pool: Pool, input: MigrationInput): Promise<MigrationReport> {
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
    const importable: LegacyCustomerOrder[] = []
    for (const raw of input.rows) {
      const parsed = legacyCustomerOrderSchema.safeParse(raw)
      if (!parsed.success) {
        rejections.push({ raw, legacyId: legacyIdOf(raw), reasonCode: 'INVALID_LEGACY_CUSTOMER_ORDER', reason: 'A linha não atende ao contrato de encomenda legado.' })
        continue
      }
      importable.push(parsed.data)
    }

    let customerOrders = 0
    let events = 0
    for (const order of importable) {
      const migrated = await client.query('SELECT 1 FROM customer_orders WHERE legacy_id = $1', [order.legacyId])
      if (migrated.rowCount) {
        rejections.push({ raw: order, legacyId: String(order.legacyId), reasonCode: 'LEGACY_ID_ALREADY_MIGRATED', reason: 'A encomenda legada já foi migrada.' })
        continue
      }
      if (!order.customer) {
        rejections.push({ raw: order, legacyId: String(order.legacyId), reasonCode: 'LEGACY_CUSTOMER_NOT_MIGRATED', reason: 'O cliente da encomenda não existe na tabela clientes do legado.' })
        continue
      }
      const variantId = order.legacyProductId
        ? (await client.query<{ id: string }>('SELECT id FROM product_variants WHERE legacy_id = $1', [order.legacyProductId])).rows[0]?.id
        : null
      if (order.legacyProductId && !variantId) {
        rejections.push({ raw: order, legacyId: String(order.legacyId), reasonCode: 'LEGACY_PRODUCT_NOT_MIGRATED', reason: 'O produto associado à encomenda não foi migrado.' })
        continue
      }
      const customerId = await resolveCustomerId(client, sourceName, order.customer!)
      const orderId = deterministicUuid(`${sourceName}:encomendascliente:${order.legacyId}`)
      const createdAt = `${order.orderedOn}T12:00:00.000Z`
      const cancellationReason = order.status === 'Cancelada'
        ? (order.notes ?? 'Cancelada no legado sem motivo registrado.')
        : null
      await client.query(
        `INSERT INTO customer_orders
           (id, legacy_id, customer_id, variant_id, created_by, club, model, type, size, notes, status, cancellation_reason, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $13)`,
        [orderId, order.legacyId, customerId, variantId, actorUserId, order.club, order.model, order.type, order.size, order.notes, statusByLegacyName[order.status], cancellationReason, createdAt],
      )
      customerOrders += 1
      await client.query(
        `INSERT INTO customer_order_events (id, customer_order_id, from_status, to_status, user_id, created_at)
         VALUES ($1, $2, NULL, $3, $4, $5)`,
        [deterministicUuid(`${sourceName}:encomenda_eventos:${order.legacyId}`), orderId, statusByLegacyName[order.status], actorUserId, createdAt],
      )
      events += 1
    }

    for (const rejection of rejections) {
      await client.query(
        `INSERT INTO migration_rejections
           (id, migration_run_id, source_table, legacy_id, reason_code, reason, source_data)
         VALUES ($1, $2, 'encomendascliente', $3, $4, $5, $6)`,
        [randomUUID(), runId, rejection.legacyId, rejection.reasonCode, rejection.reason, JSON.stringify(rejection.raw)],
      )
    }

    const counts: MigrationCounts = {
      sourceRows: input.rows.length,
      customerOrders,
      events,
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

async function resolveCustomerId(client: PoolClient, sourceName: string, customer: NonNullable<LegacyCustomerOrder['customer']>): Promise<string> {
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
