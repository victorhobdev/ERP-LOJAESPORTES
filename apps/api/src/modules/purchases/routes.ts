import { createHash, randomUUID } from 'node:crypto'

import type { FastifyInstance } from 'fastify'
import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'

import { hasValidCsrf, requirePermission, sendError } from '../../shared/auth/http.js'

const money = z.string().regex(/^(0|[1-9]\d*)\.\d{2}$/)
const orderSchema = z.object({
  supplierId: z.string().uuid(),
  orderedOn: z.iso.date(),
  importFeeAmount: money,
  items: z.array(z.object({
    variantId: z.string().uuid(),
    orderedQuantity: z.number().int().positive().max(100_000),
    supplierUnitCost: money,
  })).min(1).max(500),
}).superRefine((value, context) => {
  const ids = new Set<string>()
  for (const [index, item] of value.items.entries()) {
    if (ids.has(item.variantId)) context.addIssue({ code: 'custom', message: 'Duplicate variant.', path: ['items', index, 'variantId'] })
    ids.add(item.variantId)
  }
})
const receiptSchema = z.object({
  items: z.array(z.object({ purchaseOrderItemId: z.string().uuid(), quantity: z.number().int().positive().max(100_000) })).min(1).max(500),
  notes: z.string().trim().max(1_000).optional(),
}).superRefine((value, context) => {
  const ids = new Set<string>()
  for (const [index, item] of value.items.entries()) {
    if (ids.has(item.purchaseOrderItemId)) context.addIssue({ code: 'custom', message: 'Duplicate item.', path: ['items', index, 'purchaseOrderItemId'] })
    ids.add(item.purchaseOrderItemId)
  }
})
const idSchema = z.object({ id: z.string().uuid() })
const maxMoneyCents = 99_999_999_999_999n

type IdempotencyRow = { request_hash: string; response_status: number | null; response_body: unknown }
type ReceiptItemRow = {
  id: string
  variant_id: string
  ordered_quantity: number
  received_quantity: number
  final_unit_cost: string
  stock_quantity: number
  current_cost: string
}

export function registerPurchaseRoutes(app: FastifyInstance, pool: Pool) {
  app.post('/purchase-orders', async (request, reply) => {
    const session = await requirePermission(pool, request, reply, 'purchases:write')
    if (!session) return
    if (!hasValidCsrf(session, request)) return sendError(reply, request, 403, 'INVALID_CSRF', 'Token CSRF inválido.')

    const parsed = orderSchema.safeParse(request.body)
    const key = request.headers['idempotency-key']
    if (!parsed.success || typeof key !== 'string' || key.length < 1 || key.length > 200) {
      return sendError(reply, request, 400, 'VALIDATION_ERROR', 'Revise os dados do pedido e a chave de idempotência.')
    }

    const estimatedCents = parsed.data.items.reduce(
      (total, item) => total + toCents(item.supplierUnitCost) * BigInt(item.orderedQuantity),
      0n,
    )
    const feeCents = toCents(parsed.data.importFeeAmount)
    const finalCents = estimatedCents + feeCents
    if (finalCents > maxMoneyCents || (estimatedCents === 0n && feeCents > 0n)) {
      return sendError(reply, request, 400, 'INVALID_PURCHASE_TOTAL', 'Não foi possível ratear o custo final do pedido.')
    }

    const scope = `purchase_order.create:${session.user_id}`
    const requestHash = createHash('sha256').update(JSON.stringify(parsed.data)).digest('hex')
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const cached = await claimIdempotency(client, scope, key, requestHash)
      if (cached.kind === 'conflict') {
        await client.query('ROLLBACK')
        return sendError(reply, request, 409, 'IDEMPOTENCY_KEY_REUSED', 'A chave de idempotência já foi usada em outra requisição.')
      }
      if (cached.kind === 'cached') {
        await client.query('COMMIT')
        return reply.status(cached.status).send(cached.body)
      }

      const supplier = await client.query('SELECT 1 FROM suppliers WHERE id = $1 AND active = true', [parsed.data.supplierId])
      if (!supplier.rowCount) {
        await client.query('ROLLBACK')
        return sendError(reply, request, 404, 'SUPPLIER_NOT_FOUND', 'Fornecedor não encontrado.')
      }
      const variantIds = parsed.data.items.map(({ variantId }) => variantId)
      const variants = await client.query<{ id: string }>('SELECT id FROM product_variants WHERE id = ANY($1::uuid[])', [variantIds])
      if (variants.rowCount !== variantIds.length) {
        await client.query('ROLLBACK')
        return sendError(reply, request, 404, 'VARIANT_NOT_FOUND', 'Uma das variações não foi encontrada.')
      }

      const orderId = randomUUID()
      await client.query(
        `INSERT INTO purchase_orders
           (id, supplier_id, created_by, status, ordered_on, estimated_items_amount, import_fee_amount, final_amount)
         VALUES ($1, $2, $3, 'placed', $4, $5, $6, $7)`,
        [orderId, parsed.data.supplierId, session.user_id, parsed.data.orderedOn, formatCents(estimatedCents), formatCents(feeCents), formatCents(finalCents)],
      )
      const responseItems = []
      for (const item of parsed.data.items) {
        const itemId = randomUUID()
        const supplierCostCents = toCents(item.supplierUnitCost)
        const finalUnitCostCents = estimatedCents === 0n ? 0n : divideRounded(supplierCostCents * finalCents, estimatedCents)
        await client.query(
          `INSERT INTO purchase_order_items
             (id, purchase_order_id, variant_id, ordered_quantity, supplier_unit_cost, final_unit_cost)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [itemId, orderId, item.variantId, item.orderedQuantity, item.supplierUnitCost, formatCents(finalUnitCostCents)],
        )
        responseItems.push({
          id: itemId,
          variantId: item.variantId,
          orderedQuantity: item.orderedQuantity,
          receivedQuantity: 0,
          supplierUnitCost: item.supplierUnitCost,
          finalUnitCost: formatCents(finalUnitCostCents),
        })
      }
      await client.query(
        `INSERT INTO audit_log (id, user_id, action, entity_type, entity_id, request_id)
         VALUES ($1, $2, 'purchase_order.create', 'purchase_order', $3, $4)`,
        [randomUUID(), session.user_id, orderId, request.id],
      )
      const response = {
        id: orderId,
        supplierId: parsed.data.supplierId,
        status: 'placed',
        orderedOn: parsed.data.orderedOn,
        estimatedItemsAmount: formatCents(estimatedCents),
        importFeeAmount: formatCents(feeCents),
        finalAmount: formatCents(finalCents),
        items: responseItems,
      }
      await storeIdempotentResponse(client, scope, key, response)
      await client.query('COMMIT')
      return reply.status(201).send(response)
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  })

  app.post('/purchase-orders/:id/receipts', async (request, reply) => {
    const session = await requirePermission(pool, request, reply, 'purchases:receive')
    if (!session) return
    if (!hasValidCsrf(session, request)) return sendError(reply, request, 403, 'INVALID_CSRF', 'Token CSRF inválido.')

    const params = idSchema.safeParse(request.params)
    const parsed = receiptSchema.safeParse(request.body)
    const key = request.headers['idempotency-key']
    if (!params.success || !parsed.success || typeof key !== 'string' || key.length < 1 || key.length > 200) {
      return sendError(reply, request, 400, 'VALIDATION_ERROR', 'Revise o recebimento e a chave de idempotência.')
    }

    const scope = `purchase_order.receive:${session.user_id}:${params.data.id}`
    const requestHash = createHash('sha256').update(JSON.stringify(parsed.data)).digest('hex')
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const cached = await claimIdempotency(client, scope, key, requestHash)
      if (cached.kind === 'conflict') {
        await client.query('ROLLBACK')
        return sendError(reply, request, 409, 'IDEMPOTENCY_KEY_REUSED', 'A chave de idempotência já foi usada em outra requisição.')
      }
      if (cached.kind === 'cached') {
        await client.query('COMMIT')
        return reply.status(cached.status).send(cached.body)
      }

      const orderResult = await client.query<{ status: string }>('SELECT status FROM purchase_orders WHERE id = $1 FOR UPDATE', [params.data.id])
      const order = orderResult.rows[0]
      if (!order) {
        await client.query('ROLLBACK')
        return sendError(reply, request, 404, 'PURCHASE_ORDER_NOT_FOUND', 'Pedido não encontrado.')
      }
      if (!['placed', 'partially_received'].includes(order.status)) {
        await client.query('ROLLBACK')
        return sendError(reply, request, 409, 'PURCHASE_ORDER_NOT_RECEIVABLE', 'O pedido não aceita novos recebimentos.')
      }

      const itemIds = parsed.data.items.map(({ purchaseOrderItemId }) => purchaseOrderItemId).sort()
      const itemsResult = await client.query<ReceiptItemRow>(
        `SELECT poi.id, poi.variant_id, poi.ordered_quantity, poi.received_quantity,
                poi.final_unit_cost::text, v.stock_quantity, v.current_cost::text
         FROM purchase_order_items poi JOIN product_variants v ON v.id = poi.variant_id
         WHERE poi.purchase_order_id = $1 AND poi.id = ANY($2::uuid[])
         ORDER BY poi.id FOR UPDATE OF poi, v`,
        [params.data.id, itemIds],
      )
      if (itemsResult.rowCount !== itemIds.length) {
        await client.query('ROLLBACK')
        return sendError(reply, request, 404, 'PURCHASE_ORDER_ITEM_NOT_FOUND', 'Um dos itens não pertence ao pedido.')
      }
      const items = new Map(itemsResult.rows.map((item) => [item.id, item]))
      for (const requested of parsed.data.items) {
        const item = items.get(requested.purchaseOrderItemId)!
        const pending = item.ordered_quantity - item.received_quantity
        if (requested.quantity > pending) {
          await client.query('ROLLBACK')
          return sendError(reply, request, 409, 'RECEIPT_QUANTITY_EXCEEDED', 'O recebimento excede a quantidade pendente.', {
            purchaseOrderItemId: item.id,
            pending,
            requested: requested.quantity,
          })
        }
      }

      const receiptId = randomUUID()
      await client.query(
        `INSERT INTO goods_receipts (id, purchase_order_id, received_by, idempotency_key, notes)
         VALUES ($1, $2, $3, $4, $5)`,
        [receiptId, params.data.id, session.user_id, `${scope}:${key}`, parsed.data.notes ?? null],
      )
      for (const requested of parsed.data.items) {
        const item = items.get(requested.purchaseOrderItemId)!
        const balanceAfter = item.stock_quantity + requested.quantity
        await client.query(
          `INSERT INTO goods_receipt_items
             (id, goods_receipt_id, purchase_order_item_id, quantity, final_unit_cost)
           VALUES ($1, $2, $3, $4, $5)`,
          [randomUUID(), receiptId, item.id, requested.quantity, item.final_unit_cost],
        )
        await client.query(
          `UPDATE purchase_order_items SET received_quantity = received_quantity + $2 WHERE id = $1`,
          [item.id, requested.quantity],
        )
        await client.query(
          `UPDATE product_variants
           SET current_cost = round(((stock_quantity * current_cost) + ($2 * $3::numeric)) / (stock_quantity + $2), 2),
               stock_quantity = stock_quantity + $2, version = version + 1,
               last_stock_entry_at = now(), updated_at = now()
           WHERE id = $1`,
          [item.variant_id, requested.quantity, item.final_unit_cost],
        )
        await client.query(
          `INSERT INTO inventory_movements
             (id, variant_id, type, quantity_delta, balance_after, unit_cost, source_entity_type, source_entity_id, idempotency_key, user_id)
           VALUES ($1, $2, 'purchase_receipt', $3, $4, $5, 'goods_receipt', $6, $7, $8)`,
          [randomUUID(), item.variant_id, requested.quantity, balanceAfter, item.final_unit_cost, receiptId, `receipt:${receiptId}:${item.id}`, session.user_id],
        )
      }

      const pendingResult = await client.query<{ count: string }>(
        `SELECT count(*) FROM purchase_order_items WHERE purchase_order_id = $1 AND received_quantity < ordered_quantity`,
        [params.data.id],
      )
      const status = pendingResult.rows[0]?.count === '0' ? 'fully_received' : 'partially_received'
      await client.query('UPDATE purchase_orders SET status = $2, updated_at = now() WHERE id = $1', [params.data.id, status])
      await client.query(
        `INSERT INTO audit_log (id, user_id, action, entity_type, entity_id, request_id, after_data)
         VALUES ($1, $2, 'purchase_order.receive', 'purchase_order', $3, $4, $5)`,
        [randomUUID(), session.user_id, params.data.id, request.id, JSON.stringify({ receiptId, status, items: parsed.data.items })],
      )
      const response = { id: receiptId, purchaseOrderId: params.data.id, status, items: parsed.data.items }
      await storeIdempotentResponse(client, scope, key, response)
      await client.query('COMMIT')
      return reply.status(201).send(response)
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  })

  app.get('/purchase-orders/:id', async (request, reply) => {
    if (!await requirePermission(pool, request, reply, 'purchases:read')) return
    const params = idSchema.safeParse(request.params)
    if (!params.success) return sendError(reply, request, 400, 'VALIDATION_ERROR', 'Pedido inválido.')

    const orderResult = await pool.query(
      `SELECT id, supplier_id AS "supplierId", status, ordered_on::text AS "orderedOn",
              estimated_items_amount::text AS "estimatedItemsAmount",
              import_fee_amount::text AS "importFeeAmount", final_amount::text AS "finalAmount"
       FROM purchase_orders WHERE id = $1`,
      [params.data.id],
    )
    const order = orderResult.rows[0]
    if (!order) return sendError(reply, request, 404, 'PURCHASE_ORDER_NOT_FOUND', 'Pedido não encontrado.')
    const items = await pool.query(
      `SELECT id, variant_id AS "variantId", ordered_quantity AS "orderedQuantity",
              received_quantity AS "receivedQuantity", (ordered_quantity - received_quantity) AS "pendingQuantity",
              supplier_unit_cost::text AS "supplierUnitCost", final_unit_cost::text AS "finalUnitCost"
       FROM purchase_order_items WHERE purchase_order_id = $1 ORDER BY created_at, id`,
      [params.data.id],
    )
    const receipts = await pool.query(
      `SELECT gr.id, gr.received_at::text AS "receivedAt", gr.notes,
              jsonb_agg(jsonb_build_object(
                'purchaseOrderItemId', gri.purchase_order_item_id, 'quantity', gri.quantity,
                'finalUnitCost', gri.final_unit_cost::text
              ) ORDER BY gri.created_at, gri.id) AS items
       FROM goods_receipts gr JOIN goods_receipt_items gri ON gri.goods_receipt_id = gr.id
       WHERE gr.purchase_order_id = $1 GROUP BY gr.id ORDER BY gr.received_at, gr.id`,
      [params.data.id],
    )
    return reply.send({ ...order, items: items.rows, receipts: receipts.rows })
  })
}

async function claimIdempotency(
  client: PoolClient,
  scope: string,
  key: string,
  requestHash: string,
): Promise<{ kind: 'new' } | { kind: 'conflict' } | { kind: 'cached'; status: number; body: unknown }> {
  const inserted = await client.query(
    `INSERT INTO idempotency_keys (id, scope, key, request_hash)
     VALUES ($1, $2, $3, $4) ON CONFLICT (scope, key) DO NOTHING RETURNING id`,
    [randomUUID(), scope, key, requestHash],
  )
  if (inserted.rowCount) return { kind: 'new' }
  const existing = await client.query<IdempotencyRow>(
    `SELECT request_hash, response_status, response_body FROM idempotency_keys
     WHERE scope = $1 AND key = $2 FOR UPDATE`,
    [scope, key],
  )
  const prior = existing.rows[0]
  if (!prior || prior.request_hash !== requestHash) return { kind: 'conflict' }
  if (prior.response_status && prior.response_body !== null) return { kind: 'cached', status: prior.response_status, body: prior.response_body }
  return { kind: 'new' }
}

async function storeIdempotentResponse(client: PoolClient, scope: string, key: string, response: unknown) {
  await client.query(
    `UPDATE idempotency_keys SET response_status = 201, response_body = $3, completed_at = now()
     WHERE scope = $1 AND key = $2`,
    [scope, key, JSON.stringify(response)],
  )
}

function toCents(value: string): bigint {
  const [whole = '0', fraction = '00'] = value.split('.')
  return BigInt(whole) * 100n + BigInt(fraction)
}

function formatCents(value: bigint): string {
  return `${value / 100n}.${(value % 100n).toString().padStart(2, '0')}`
}

function divideRounded(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator / 2n) / denominator
}
