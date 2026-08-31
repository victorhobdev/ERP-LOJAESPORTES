import { createHash, randomUUID } from 'node:crypto'

import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'

const money = z.string().regex(/^(0|[1-9]\d*)\.\d{2}$/)
const legacyProductSchema = z.object({
  legacyId: z.number().int().positive(),
  club: z.string().trim().min(1).max(150),
  model: z.string().trim().min(1).max(150),
  type: z.enum(['Masculina', 'Feminina', 'Infantil']),
  size: z.string().trim().min(1).max(20),
  description: z.string().trim().max(500).nullish(),
  salePrice: money,
  stockQuantity: z.number().int().min(0),
  currentCost: money,
})

type LegacyProduct = z.infer<typeof legacyProductSchema>
type MigrationCounts = {
  sourceRows: number
  products: number
  acceptedVariants: number
  rejectedRows: number
  openingBalanceUnits: number
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
type Rejection = {
  raw: unknown
  legacyId: string | null
  reasonCode: 'INVALID_LEGACY_PRODUCT' | 'DUPLICATE_VARIANT_IN_SOURCE' | 'LEGACY_ID_ALREADY_MIGRATED' | 'TARGET_VARIANT_CONFLICT'
  reason: string
}

export async function migrateLegacyProducts(pool: Pool, input: MigrationInput): Promise<MigrationReport> {
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

    const { accepted, rejections } = classifyRows(input.rows)
    const importable: LegacyProduct[] = []
    for (const row of accepted) {
      const conflict = await findTargetConflict(client, row)
      if (conflict) {
        rejections.push({ raw: row, legacyId: String(row.legacyId), ...conflict })
      } else {
        importable.push(row)
      }
    }

    const productIds = new Map<string, string>()
    for (const row of importable) {
      const productKey = logicalProductKey(row)
      let productId = productIds.get(productKey)
      if (!productId) {
        productId = await findOrCreateProduct(client, sourceName, row)
        productIds.set(productKey, productId)
      }

      const variantId = deterministicUuid(`${sourceName}:produtos:${row.legacyId}`)
      await client.query(
        `INSERT INTO product_variants
           (id, product_id, legacy_id, type, size, sku, sale_price, current_cost, stock_quantity)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [variantId, productId, row.legacyId, row.type, row.size, legacySku(sourceName, row.legacyId), row.salePrice, row.currentCost, row.stockQuantity],
      )
      if (row.stockQuantity > 0) {
        const idempotencyKey = `${sourceName}:produtos:${row.legacyId}:opening_balance`
        await client.query(
          `INSERT INTO inventory_movements
             (id, variant_id, type, quantity_delta, balance_after, reason, idempotency_key, user_id)
           VALUES ($1, $2, 'opening_balance', $3, $3, 'Saldo inicial migrado', $4, $5)`,
          [deterministicUuid(idempotencyKey), variantId, row.stockQuantity, idempotencyKey, actorUserId],
        )
      }
    }

    for (const rejection of rejections) {
      await client.query(
        `INSERT INTO migration_rejections
           (id, migration_run_id, source_table, legacy_id, reason_code, reason, source_data)
         VALUES ($1, $2, 'produtos', $3, $4, $5, $6)`,
        [randomUUID(), runId, rejection.legacyId, rejection.reasonCode, rejection.reason, JSON.stringify(rejection.raw)],
      )
    }

    const counts: MigrationCounts = {
      sourceRows: input.rows.length,
      products: productIds.size,
      acceptedVariants: importable.length,
      rejectedRows: rejections.length,
      openingBalanceUnits: importable.reduce((total, row) => total + row.stockQuantity, 0),
    }
    await client.query(
      `UPDATE migration_runs
       SET status = 'completed', counts = $2, completed_at = now()
       WHERE id = $1`,
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

function classifyRows(rows: unknown[]): { accepted: LegacyProduct[]; rejections: Rejection[] } {
  const valid: LegacyProduct[] = []
  const rejections: Rejection[] = []
  for (const raw of rows) {
    const parsed = legacyProductSchema.safeParse(raw)
    if (parsed.success) {
      valid.push(parsed.data)
    } else {
      rejections.push({
        raw,
        legacyId: legacyIdOf(raw),
        reasonCode: 'INVALID_LEGACY_PRODUCT',
        reason: 'A linha não atende ao contrato de produto legado.',
      })
    }
  }

  const accepted: LegacyProduct[] = []
  const seen = new Set<string>()
  for (const row of valid.sort((left, right) => left.legacyId - right.legacyId)) {
    const key = variantKey(row)
    if (seen.has(key)) {
      rejections.push({
        raw: row,
        legacyId: String(row.legacyId),
        reasonCode: 'DUPLICATE_VARIANT_IN_SOURCE',
        reason: 'A origem contém mais de uma linha para produto, tipo e tamanho.',
      })
    } else {
      seen.add(key)
      accepted.push(row)
    }
  }
  return { accepted, rejections }
}

async function findTargetConflict(client: PoolClient, row: LegacyProduct): Promise<Pick<Rejection, 'reasonCode' | 'reason'> | undefined> {
  const existingLegacyId = await client.query('SELECT 1 FROM product_variants WHERE legacy_id = $1', [row.legacyId])
  if (existingLegacyId.rowCount) {
    return { reasonCode: 'LEGACY_ID_ALREADY_MIGRATED', reason: 'O ID legado já está associado a outra variante.' }
  }
  const existingVariant = await client.query(
    `SELECT 1 FROM product_variants v
     JOIN products p ON p.id = v.product_id
     WHERE lower(p.club) = lower($1) AND lower(p.model) = lower($2)
       AND v.type = $3 AND lower(v.size) = lower($4)`,
    [row.club, row.model, row.type, row.size],
  )
  if (existingVariant.rowCount) {
    return { reasonCode: 'TARGET_VARIANT_CONFLICT', reason: 'A variante já existe no modelo de destino.' }
  }
  return undefined
}

async function findOrCreateProduct(client: PoolClient, sourceName: string, row: LegacyProduct): Promise<string> {
  const existing = await client.query<{ id: string }>(
    'SELECT id FROM products WHERE lower(club) = lower($1) AND lower(model) = lower($2)',
    [row.club, row.model],
  )
  if (existing.rows[0]) return existing.rows[0].id

  const id = deterministicUuid(`${sourceName}:products:${logicalProductKey(row)}`)
  await client.query(
    'INSERT INTO products (id, club, model, description) VALUES ($1, $2, $3, $4)',
    [id, row.club, row.model, row.description ?? null],
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

function checksum(rows: unknown[]): string {
  const canonicalRows = rows.map(canonicalJson).sort()
  return createHash('sha256').update(JSON.stringify(canonicalRows)).digest('hex')
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function deterministicUuid(value: string): string {
  const bytes = createHash('sha256').update(value).digest().subarray(0, 16)
  bytes[6] = (bytes[6]! & 0x0f) | 0x80
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function legacySku(sourceName: string, legacyId: number): string {
  return `legacy:${createHash('sha256').update(sourceName).digest('hex').slice(0, 12)}:${legacyId}`
}

function logicalProductKey(row: Pick<LegacyProduct, 'club' | 'model'>): string {
  return `${row.club.toLocaleLowerCase('pt-BR')}\u0000${row.model.toLocaleLowerCase('pt-BR')}`
}

function variantKey(row: LegacyProduct): string {
  return `${logicalProductKey(row)}\u0000${row.type}\u0000${row.size.toLocaleLowerCase('pt-BR')}`
}

function legacyIdOf(raw: unknown): string | null {
  if (typeof raw === 'object' && raw !== null && 'legacyId' in raw) return String(raw.legacyId)
  return null
}
