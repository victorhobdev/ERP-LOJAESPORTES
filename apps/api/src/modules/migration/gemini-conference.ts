import { createHash, randomUUID } from 'node:crypto'

import type { Pool, PoolClient } from 'pg'

import { deterministicUuid } from './legacy-products.js'

export const GEMINI_CONFERENCE_SOURCE_NAME = 'gemini_teste-conferencia-20260905'
export const GEMINI_CONFERENCE_REASON = 'Encerramento administrativo da migração — estoque já reconciliado manualmente.'

export const STOCK_RECONCILIATION = [
  { legacyId: 77, expectedBefore: 1, after: 0 },
  { legacyId: 174, expectedBefore: 1, after: 0 },
  { legacyId: 175, expectedBefore: 1, after: 0 },
  { legacyId: 184, expectedBefore: 1, after: 3 },
  { legacyId: 237, expectedBefore: 0, after: 1 },
] as const

const sourceDefinition = {
  sourceName: GEMINI_CONFERENCE_SOURCE_NAME,
  supplierNames: ['KAKARIC', 'KAKARIC/MARCIO'],
  stock: STOCK_RECONCILIATION,
  closures: [
    { legacyId: 2, ordered: 74, received: 48, status: 'partially_received' },
    { legacyId: 5, ordered: 60, received: 0, status: 'placed' },
  ],
  orders: [
    { key: 'kakaric-brasil', orderedOn: '2026-08-16', total: '50.00' },
    { key: 'kakaric-novos-modelos', orderedOn: '2026-08-28', total: '1094.00' },
  ],
}

export const GEMINI_CONFERENCE_SOURCE_CHECKSUM = createHash('sha256')
  .update(JSON.stringify(sourceDefinition))
  .digest('hex')

type MigrationMode = 'dry-run' | 'apply'

export type StockAdjustmentReport = {
  legacyId: number
  variantId: string | null
  club: string | null
  model: string | null
  type: string | null
  size: string | null
  before: number | null
  expectedBefore: number
  after: number
  delta: number
  currentCost: string | null
}

export type LegacyClosureReport = {
  legacyId: number
  supplier: string | null
  statusBefore: string | null
  statusAfter: 'fully_received'
  ordered: number
  receivedBefore: number
  receivedAfter: number
  pendingBefore: number
  pendingAfter: 0
  receiptCountBefore: number
  receiptCountAfter: number
}

export type ConferenceOrderItemReport = {
  sourceLabel: string
  club: string
  model: string
  type: 'Masculina'
  sourceSize: string | null
  size: string
  quantity: number
  variantId: string
  supplierUnitCost: string
  finalUnitCost: string
  newProduct: boolean
}

export type ConferenceOrderReport = {
  key: 'kakaric-brasil' | 'kakaric-novos-modelos'
  id: string
  supplierId: string
  orderedOn: string
  status: 'placed'
  orderedQuantity: number
  finalAmount: string
  items: ConferenceOrderItemReport[]
}

export type CreatedProductReport = {
  productId: string
  club: string
  model: string
  variantCount: number
  variants: Array<{ id: string; size: string; quantity: number; sku: string }>
}

export type GeminiConferenceReport = {
  sourceName: string
  sourceChecksum: string
  mode: MigrationMode
  reused: boolean
  conflicts: string[]
  supplier: { id: string; name: string; created: boolean }
  stockAdjustments: StockAdjustmentReport[]
  legacyClosures: LegacyClosureReport[]
  orders: ConferenceOrderReport[]
  createdProducts: CreatedProductReport[]
  runId?: string
}

export class GeminiConferenceConflict extends Error {
  constructor(public readonly report: GeminiConferenceReport) {
    super(`Gemini conference migration has ${report.conflicts.length} conflict(s).`)
    this.name = 'GeminiConferenceConflict'
  }
}

type MigrationInput = { mode: MigrationMode; actorUserId: string }
type VariantCandidate = {
  id: string
  club: string
  model: string
  type: string
  size: string
  stockQuantity: number
  currentCost: string
}

type PlannedOrder = {
  key: ConferenceOrderReport['key']
  orderedOn: string
  total: string
  unitCost: string
  items: Array<{
    sourceLabel: string
    club: string
    model: string
    type: 'Masculina'
    sourceSize: string | null
    size: string
    quantity: number
    variantId: string
    newProduct: boolean
  }>
}

const firstOrder: PlannedOrder = {
  key: 'kakaric-brasil',
  orderedOn: '2026-08-16',
  total: '50.00',
  unitCost: '6.25',
  items: [
    item('BRASIL AZUL 2026', 'BRASIL', 'AZUL', 'S', 'P', 1, false),
    item('BRASIL AZUL 2026', 'BRASIL', 'AZUL', 'M', 'M', 1, false),
    item('BRASIL AZUL 2026', 'BRASIL', 'AZUL', 'L', 'G', 2, false),
    item('BRASIL AZUL 2026', 'BRASIL', 'AZUL', 'XL', 'GG', 2, false),
    item('BRASIL GOLEIRO', 'BRASIL', 'GOLEIRO', null, 'G', 1, false),
    item('BRASIL AMARELA 2026', 'BRASIL', 'AMARELA', null, '2GG', 1, false),
  ],
}

const newModelDefinitions = [
  { label: 'ALEMANHA PLAYER', club: 'ALEMANHA', model: 'PLAYER', sizes: [['P', 1], ['3GG', 1]] },
  { label: 'FLAMENGO III 2026', club: 'FLAMENGO', model: 'III 2026', sizes: [['M', 1], ['G', 2], ['GG', 1], ['4GG', 1]] },
  { label: 'VASCO TREINO CINZA', club: 'VASCO', model: 'TREINO CINZA', sizes: [['4GG', 1]] },
  { label: 'BOTAFOGO I 2026', club: 'BOTAFOGO', model: 'I 2026', sizes: [['G', 1], ['GG', 1], ['2GG', 2], ['4GG', 2]] },
  { label: 'BOTAFOGO III 2026', club: 'BOTAFOGO', model: 'III 2026', sizes: [['G', 1], ['GG', 1], ['2GG', 2], ['4GG', 2]] },
] as const

const secondOrder: PlannedOrder = {
  key: 'kakaric-novos-modelos',
  orderedOn: '2026-08-28',
  total: '1094.00',
  unitCost: '54.70',
  items: newModelDefinitions.flatMap((definition) => definition.sizes.map(([size, quantity]) => ({
    sourceLabel: definition.label,
    club: definition.club,
    model: definition.model,
    type: 'Masculina' as const,
    sourceSize: null,
    size,
    quantity,
    variantId: deterministicUuid(`${GEMINI_CONFERENCE_SOURCE_NAME}:variant:${definition.club}:${definition.model}:Masculina:${size}`),
    newProduct: true,
  }))),
}

export async function runGeminiConferenceMigration(pool: Pool, input: MigrationInput): Promise<GeminiConferenceReport> {
  const previous = await findCompletedRun(pool)
  if (previous) return { ...previous, mode: input.mode, reused: true }

  const client = await pool.connect()
  try {
    await client.query(input.mode === 'dry-run' ? 'BEGIN READ ONLY' : 'BEGIN')
    const plan = await buildPlan(client, input.mode === 'apply')
    if (plan.conflicts.length > 0) {
      await client.query('ROLLBACK')
      if (input.mode === 'apply') throw new GeminiConferenceConflict(plan)
      return plan
    }
    if (input.mode === 'dry-run') {
      await client.query('ROLLBACK')
      return plan
    }

    const runId = randomUUID()
    const claimed = await client.query<{ id: string }>(
      `INSERT INTO migration_runs (id, source_name, source_checksum, status)
       VALUES ($1, $2, $3, 'running')
       ON CONFLICT (source_name, source_checksum) DO NOTHING
       RETURNING id`,
      [runId, GEMINI_CONFERENCE_SOURCE_NAME, GEMINI_CONFERENCE_SOURCE_CHECKSUM],
    )
    if (!claimed.rows[0]) {
      await client.query('ROLLBACK')
      const concurrent = await findCompletedRun(pool)
      if (concurrent) return { ...concurrent, mode: input.mode, reused: true }
      throw new Error('A Gemini conference migration is already running.')
    }

    await applyStockAdjustments(client, plan, runId, input.actorUserId)
    await closeLegacyOrders(client, plan, input.actorUserId)
    await applyNewOrders(client, plan, input.actorUserId)

    const completed: GeminiConferenceReport = { ...plan, mode: 'apply', reused: false, runId }
    await client.query(
      `UPDATE migration_runs SET status = 'completed', counts = $2, completed_at = now() WHERE id = $1`,
      [runId, JSON.stringify(completed)],
    )
    await client.query('COMMIT')
    return completed
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

async function buildPlan(client: PoolClient, lockRows: boolean): Promise<GeminiConferenceReport> {
  const conflicts: string[] = []
  const stockAdjustments = await inspectStock(client, conflicts, lockRows)
  const legacyClosures = await inspectLegacyClosures(client, conflicts, lockRows)
  const supplierRows = await client.query<{ id: string; name: string; active: boolean }>(
    'SELECT id, name, active FROM suppliers WHERE lower(name) = ANY($1::text[]) ORDER BY lower(name)',
    [sourceDefinition.supplierNames.map((name) => name.toLowerCase())],
  )
  if (supplierRows.rows.length > 1) conflicts.push('Há mais de um cadastro candidato para o fornecedor Kakaric.')
  const supplier = supplierRows.rows[0]
  const supplierId = supplier?.id ?? deterministicUuid(`${GEMINI_CONFERENCE_SOURCE_NAME}:supplier:KAKARIC`)
  const supplierName = supplier?.name ?? 'KAKARIC'
  if (supplier && !supplier.active) conflicts.push(`O fornecedor ${supplier.name} existente está inativo.`)

  const first = await resolveExistingOrder(client, firstOrder, supplierId, conflicts)
  const createdProducts = await inspectNewProducts(client, conflicts)
  const second = orderReport(secondOrder, supplierId)

  return {
    sourceName: GEMINI_CONFERENCE_SOURCE_NAME,
    sourceChecksum: GEMINI_CONFERENCE_SOURCE_CHECKSUM,
    mode: 'dry-run',
    reused: false,
    conflicts,
    supplier: { id: supplierId, name: supplierName, created: !supplier },
    stockAdjustments,
    legacyClosures,
    orders: [first, second],
    createdProducts,
  }
}

async function inspectStock(client: PoolClient, conflicts: string[], lockRows: boolean): Promise<StockAdjustmentReport[]> {
  const ids = STOCK_RECONCILIATION.map((target) => target.legacyId)
  const result = await client.query<{
    id: string
    legacy_id: number | string
    club: string
    model: string
    type: string
    size: string
    stock_quantity: number
    current_cost: string
  }>(
    `SELECT v.id, v.legacy_id, p.club, p.model, v.type, v.size, v.stock_quantity, v.current_cost::text
     FROM product_variants v JOIN products p ON p.id = v.product_id
     WHERE v.legacy_id = ANY($1::bigint[])
     ${lockRows ? 'FOR UPDATE OF v' : ''}`,
    [ids],
  )
  const byId = new Map(result.rows.map((row) => [Number(row.legacy_id), row]))
  return STOCK_RECONCILIATION.map((target) => {
    const row = byId.get(target.legacyId)
    if (!row) {
      conflicts.push(`ProdutoID ${target.legacyId} não encontrado na homologação.`)
      return {
        legacyId: target.legacyId, variantId: null, club: null, model: null, type: null, size: null,
        before: null, expectedBefore: target.expectedBefore, after: target.after,
        delta: target.after - target.expectedBefore, currentCost: null,
      }
    }
    if (row.stock_quantity !== target.expectedBefore) {
      conflicts.push(`ProdutoID ${target.legacyId}: saldo atual ${row.stock_quantity}, esperado ${target.expectedBefore}.`)
    }
    return {
      legacyId: target.legacyId,
      variantId: row.id,
      club: row.club,
      model: row.model,
      type: row.type,
      size: row.size,
      before: row.stock_quantity,
      expectedBefore: target.expectedBefore,
      after: target.after,
      delta: target.after - target.expectedBefore,
      currentCost: row.current_cost,
    }
  })
}

async function inspectLegacyClosures(client: PoolClient, conflicts: string[], lockRows: boolean): Promise<LegacyClosureReport[]> {
  const pending = await client.query<{ legacy_id: string }>(
    `SELECT DISTINCT po.legacy_id::text
     FROM purchase_orders po JOIN purchase_order_items poi ON poi.purchase_order_id = po.id
     WHERE po.legacy_id IS NOT NULL AND poi.received_quantity < poi.ordered_quantity
     ORDER BY 1`,
  )
  const pendingIds = pending.rows.map((row) => Number(row.legacy_id))
  if (pendingIds.join(',') !== '2,5') {
    conflicts.push(`Pedidos legados pendentes fora do escopo esperado: [${pendingIds.join(', ')}].`)
  }

  const reports: LegacyClosureReport[] = []
  for (const expected of sourceDefinition.closures) {
    if (lockRows) {
      await client.query('SELECT id FROM purchase_orders WHERE legacy_id = $1 FOR UPDATE', [expected.legacyId])
    }
    const result = await client.query<{
      id: string
      supplier: string
      status: string
      ordered: string
      received: string
      receipts: string
    }>(
      `SELECT po.id, s.name AS supplier, po.status,
              sum(poi.ordered_quantity)::text AS ordered,
              sum(poi.received_quantity)::text AS received,
              (SELECT count(*)::text FROM goods_receipts gr WHERE gr.purchase_order_id = po.id) AS receipts
       FROM purchase_orders po
       JOIN suppliers s ON s.id = po.supplier_id
       JOIN purchase_order_items poi ON poi.purchase_order_id = po.id
       WHERE po.legacy_id = $1
       GROUP BY po.id, s.name`,
      [expected.legacyId],
    )
    const row = result.rows[0]
    if (!row) {
      conflicts.push(`Pedido legado ${expected.legacyId} não encontrado na homologação.`)
      continue
    }
    const ordered = Number(row.ordered)
    const received = Number(row.received)
    if (row.status !== expected.status || ordered !== expected.ordered || received !== expected.received) {
      conflicts.push(`Pedido legado ${expected.legacyId}: estado atual não coincide com o pré-estado conferido.`)
    }
    reports.push({
      legacyId: expected.legacyId,
      supplier: row.supplier,
      statusBefore: row.status,
      statusAfter: 'fully_received',
      ordered,
      receivedBefore: received,
      receivedAfter: ordered,
      pendingBefore: ordered - received,
      pendingAfter: 0,
      receiptCountBefore: Number(row.receipts),
      receiptCountAfter: Number(row.receipts),
    })
  }
  return reports
}

async function resolveExistingOrder(client: PoolClient, order: PlannedOrder, supplierId: string, conflicts: string[]): Promise<ConferenceOrderReport> {
  const items: ConferenceOrderItemReport[] = []
  for (const planned of order.items) {
    const result = await client.query<VariantCandidate>(
      `SELECT v.id, p.club, p.model, v.type, v.size,
              v.stock_quantity AS "stockQuantity", v.current_cost::text AS "currentCost"
       FROM product_variants v JOIN products p ON p.id = v.product_id
       WHERE lower(p.club) = lower($1) AND lower(p.model) = lower($2)
         AND v.type = $3 AND lower(v.size) = lower($4)`,
      [planned.club, planned.model, planned.type, planned.size],
    )
    if (result.rows.length !== 1) {
      conflicts.push(`Mapeamento ${planned.sourceLabel}/${planned.sourceSize ?? planned.size} → ${planned.club}/${planned.model}/${planned.size}: esperado 1 candidato, encontrado ${result.rows.length}.`)
      continue
    }
    items.push({ ...planned, variantId: result.rows[0]!.id, supplierUnitCost: order.unitCost, finalUnitCost: order.unitCost })
  }
  return {
    key: order.key,
    id: deterministicUuid(`${GEMINI_CONFERENCE_SOURCE_NAME}:purchase-order:${order.key}`),
    supplierId,
    orderedOn: order.orderedOn,
    status: 'placed',
    orderedQuantity: order.items.reduce((total, item) => total + item.quantity, 0),
    finalAmount: order.total,
    items,
  }
}

async function inspectNewProducts(client: PoolClient, conflicts: string[]): Promise<CreatedProductReport[]> {
  const products: CreatedProductReport[] = []
  for (const definition of newModelDefinitions) {
    const existing = await client.query<{ id: string }>(
      'SELECT id FROM products WHERE lower(club) = lower($1) AND lower(model) = lower($2)',
      [definition.club, definition.model],
    )
    const productId = deterministicUuid(`${GEMINI_CONFERENCE_SOURCE_NAME}:product:${definition.club}:${definition.model}`)
    if (existing.rows[0]) conflicts.push(`Modelo novo ${definition.club}/${definition.model} já existe; não será associado a variante antiga.`)
    products.push({
      productId,
      club: definition.club,
      model: definition.model,
      variantCount: definition.sizes.length,
      variants: definition.sizes.map(([size, quantity]) => ({
        id: deterministicUuid(`${GEMINI_CONFERENCE_SOURCE_NAME}:variant:${definition.club}:${definition.model}:Masculina:${size}`),
        size,
        quantity,
        sku: conferenceSku(`${definition.club}:${definition.model}:Masculina:${size}`),
      })),
    })
  }
  return products
}

async function applyStockAdjustments(client: PoolClient, plan: GeminiConferenceReport, runId: string, actorUserId: string) {
  for (const adjustment of plan.stockAdjustments) {
    if (!adjustment.variantId || adjustment.before === null || adjustment.delta === 0) continue
    const updated = await client.query(
      `UPDATE product_variants
       SET stock_quantity = $2, version = version + 1, updated_at = now()
       WHERE id = $1 AND stock_quantity = $3`,
      [adjustment.variantId, adjustment.after, adjustment.expectedBefore],
    )
    if (updated.rowCount !== 1) {
      throw new Error(`ProdutoID ${adjustment.legacyId} mudou durante a aplicação; operação abortada.`)
    }
    await client.query(
      `INSERT INTO inventory_movements
         (id, variant_id, type, quantity_delta, balance_after, reason, source_entity_type, source_entity_id, idempotency_key, user_id)
       VALUES ($1, $2, 'manual_adjustment', $3, $4, $5, 'gemini_conference', $6, $7, $8)`,
      [
        deterministicUuid(`${GEMINI_CONFERENCE_SOURCE_NAME}:stock:${adjustment.legacyId}`),
        adjustment.variantId,
        adjustment.delta,
        adjustment.after,
        'Reconciliação de estoque pós-dump; sem recebimento físico.',
        runId,
        `${GEMINI_CONFERENCE_SOURCE_NAME}:stock:${adjustment.legacyId}`,
        actorUserId,
      ],
    )
    await client.query(
      `INSERT INTO audit_log
         (id, user_id, action, entity_type, entity_id, request_id, before_data, after_data)
       VALUES ($1, $2, 'inventory.reconciliation_adjustment', 'product_variant', $3, $4, $5, $6)`,
      [
        randomUUID(), actorUserId, adjustment.variantId, `${GEMINI_CONFERENCE_SOURCE_NAME}:stock:${adjustment.legacyId}`,
        JSON.stringify({ legacyId: adjustment.legacyId, stockQuantity: adjustment.before, currentCost: adjustment.currentCost }),
        JSON.stringify({ legacyId: adjustment.legacyId, stockQuantity: adjustment.after, currentCost: adjustment.currentCost, reason: 'Reconciliação de estoque pós-dump' }),
      ],
    )
  }
}

async function closeLegacyOrders(client: PoolClient, plan: GeminiConferenceReport, actorUserId: string) {
  for (const closure of plan.legacyClosures) {
    const order = await client.query<{ id: string }>('SELECT id FROM purchase_orders WHERE legacy_id = $1 FOR UPDATE', [closure.legacyId])
    const orderId = order.rows[0]?.id
    if (!orderId) throw new Error(`Legacy purchase ${closure.legacyId} disappeared during apply.`)
    const beforeItems = await client.query(
      `SELECT id, ordered_quantity AS "orderedQuantity", received_quantity AS "receivedQuantity"
       FROM purchase_order_items WHERE purchase_order_id = $1 ORDER BY id`,
      [orderId],
    )
    await client.query(
      `UPDATE purchase_order_items SET received_quantity = ordered_quantity
       WHERE purchase_order_id = $1 AND received_quantity < ordered_quantity`,
      [orderId],
    )
    await client.query(
      `UPDATE purchase_orders SET status = 'fully_received', updated_at = now() WHERE id = $1`,
      [orderId],
    )
    await client.query(
      `INSERT INTO audit_log
         (id, user_id, action, entity_type, entity_id, request_id, before_data, after_data)
       VALUES ($1, $2, 'purchase_order.administrative_migration_close', 'purchase_order', $3, $4, $5, $6)`,
      [
        randomUUID(), actorUserId, orderId, `${GEMINI_CONFERENCE_SOURCE_NAME}:legacy:${closure.legacyId}`,
        JSON.stringify({ status: closure.statusBefore, items: beforeItems.rows, pending: closure.pendingBefore }),
        JSON.stringify({ status: 'fully_received', receivedQuantity: closure.ordered, pending: 0, reason: GEMINI_CONFERENCE_REASON }),
      ],
    )
  }
}

async function applyNewOrders(client: PoolClient, plan: GeminiConferenceReport, actorUserId: string) {
  if (plan.supplier.created) {
    await client.query(
      `INSERT INTO suppliers (id, name, active) VALUES ($1, $2, true)`,
      [plan.supplier.id, plan.supplier.name],
    )
  }
  for (const product of plan.createdProducts) {
    await client.query(
      `INSERT INTO products (id, club, model, description)
       VALUES ($1, $2, $3, $4)`,
      [product.productId, product.club, product.model, `Criado na migração de conferência Kakaric.`],
    )
    for (const variant of product.variants) {
      await client.query(
        `INSERT INTO product_variants
           (id, product_id, type, size, sku, sale_price, current_cost, stock_quantity)
         VALUES ($1, $2, 'Masculina', $3, $4, 0.00, 0.00, 0)`,
        [variant.id, product.productId, variant.size, variant.sku],
      )
    }
  }
  for (const order of plan.orders) {
    await client.query(
      `INSERT INTO purchase_orders
         (id, supplier_id, created_by, status, ordered_on, estimated_items_amount, import_fee_amount, final_amount)
       VALUES ($1, $2, $3, 'placed', $4, $5, 0.00, $5)`,
      [order.id, order.supplierId, actorUserId, order.orderedOn, order.finalAmount],
    )
    for (const [index, item] of order.items.entries()) {
      await client.query(
        `INSERT INTO purchase_order_items
           (id, purchase_order_id, variant_id, ordered_quantity, supplier_unit_cost, final_unit_cost)
         VALUES ($1, $2, $3, $4, $5, $5)`,
        [deterministicUuid(`${GEMINI_CONFERENCE_SOURCE_NAME}:item:${order.key}:${index}`), order.id, item.variantId, item.quantity, item.supplierUnitCost],
      )
    }
    await client.query(
      `INSERT INTO audit_log (id, user_id, action, entity_type, entity_id, request_id, after_data)
       VALUES ($1, $2, 'purchase_order.migration_create', 'purchase_order', $3, $4, $5)`,
      [randomUUID(), actorUserId, order.id, `${GEMINI_CONFERENCE_SOURCE_NAME}:order:${order.key}`, JSON.stringify(order)],
    )
  }
}

function orderReport(order: PlannedOrder, supplierId: string): ConferenceOrderReport {
  return {
    key: order.key,
    id: deterministicUuid(`${GEMINI_CONFERENCE_SOURCE_NAME}:purchase-order:${order.key}`),
    supplierId,
    orderedOn: order.orderedOn,
    status: 'placed',
    orderedQuantity: order.items.reduce((total, item) => total + item.quantity, 0),
    finalAmount: order.total,
    items: order.items.map((item) => ({ ...item, supplierUnitCost: order.unitCost, finalUnitCost: order.unitCost })),
  }
}

async function findCompletedRun(pool: Pool): Promise<GeminiConferenceReport | undefined> {
  const result = await pool.query<{ counts: GeminiConferenceReport }>(
    `SELECT counts FROM migration_runs
     WHERE source_name = $1 AND source_checksum = $2 AND status = 'completed'`,
    [GEMINI_CONFERENCE_SOURCE_NAME, GEMINI_CONFERENCE_SOURCE_CHECKSUM],
  )
  return result.rows[0]?.counts
}

function item(sourceLabel: string, club: string, model: string, sourceSize: string | null, size: string, quantity: number, newProduct: boolean) {
  return { sourceLabel, club, model, type: 'Masculina' as const, sourceSize, size, quantity, variantId: '', newProduct }
}

function conferenceSku(value: string): string {
  return `migration:gemini:${createHash('sha256').update(value).digest('hex').slice(0, 24)}`
}
