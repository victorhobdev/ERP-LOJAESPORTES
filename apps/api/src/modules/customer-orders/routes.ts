import { createHash, randomUUID } from 'node:crypto'

import type { FastifyInstance } from 'fastify'
import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'

import { hasValidCsrf, requirePermission, sendError } from '../../shared/auth/http.js'

const statuses = ['pending', 'supplier_ordered', 'product_arrived', 'delivered', 'cancelled'] as const
const createSchema = z.object({
  customerId: z.string().uuid(),
  variantId: z.string().uuid().optional(),
  linkedPurchaseOrderId: z.string().uuid().optional(),
  club: z.string().trim().min(1).max(150),
  model: z.string().trim().min(1).max(150),
  type: z.enum(['Masculina', 'Feminina', 'Infantil']),
  size: z.string().trim().min(1).max(20),
  notes: z.string().trim().max(1_000).optional(),
})
const statusSchema = z.object({ status: z.enum(statuses), reason: z.string().trim().max(500).optional() })
const idSchema = z.object({ id: z.string().uuid() })
const allowedTransitions: Record<string, readonly string[]> = {
  pending: ['supplier_ordered', 'cancelled'],
  supplier_ordered: ['product_arrived', 'cancelled'],
  product_arrived: ['delivered', 'cancelled'],
  delivered: [],
  cancelled: [],
}

type IdempotencyRow = { request_hash: string; response_status: number | null; response_body: unknown }

export function registerCustomerOrderRoutes(app: FastifyInstance, pool: Pool) {
  app.post('/customer-orders', async (request, reply) => {
    const session = await requirePermission(pool, request, reply, 'customer_orders:write')
    if (!session) return
    if (!hasValidCsrf(session, request)) return sendError(reply, request, 403, 'INVALID_CSRF', 'Token CSRF inválido.')
    const parsed = createSchema.safeParse(request.body)
    const key = request.headers['idempotency-key']
    if (!parsed.success || typeof key !== 'string' || key.length < 1 || key.length > 200) {
      return sendError(reply, request, 400, 'VALIDATION_ERROR', 'Revise os dados da encomenda e a chave de idempotência.')
    }

    const scope = `customer_order.create:${session.user_id}`
    const requestHash = createHash('sha256').update(JSON.stringify(parsed.data)).digest('hex')
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const cached = await claim(client, scope, key, requestHash)
      if (cached.kind === 'conflict') {
        await client.query('ROLLBACK')
        return sendError(reply, request, 409, 'IDEMPOTENCY_KEY_REUSED', 'A chave de idempotência já foi usada em outra requisição.')
      }
      if (cached.kind === 'cached') {
        await client.query('COMMIT')
        return reply.status(cached.status).send(cached.body)
      }

      const customer = await client.query('SELECT 1 FROM customers WHERE id = $1 AND active = true', [parsed.data.customerId])
      if (!customer.rowCount) {
        await client.query('ROLLBACK')
        return sendError(reply, request, 404, 'CUSTOMER_NOT_FOUND', 'Cliente não encontrado.')
      }
      if (parsed.data.variantId) {
        const variant = await client.query('SELECT 1 FROM product_variants WHERE id = $1', [parsed.data.variantId])
        if (!variant.rowCount) {
          await client.query('ROLLBACK')
          return sendError(reply, request, 404, 'VARIANT_NOT_FOUND', 'Variação não encontrada.')
        }
      }
      if (parsed.data.linkedPurchaseOrderId) {
        const purchase = await client.query('SELECT 1 FROM purchase_orders WHERE id = $1', [parsed.data.linkedPurchaseOrderId])
        if (!purchase.rowCount) {
          await client.query('ROLLBACK')
          return sendError(reply, request, 404, 'PURCHASE_ORDER_NOT_FOUND', 'Pedido de compra não encontrado.')
        }
      }

      const id = randomUUID()
      await client.query(
        `INSERT INTO customer_orders
           (id, customer_id, variant_id, created_by, club, model, type, size, notes, linked_purchase_order_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [id, parsed.data.customerId, parsed.data.variantId ?? null, session.user_id, parsed.data.club, parsed.data.model, parsed.data.type, parsed.data.size, parsed.data.notes ?? null, parsed.data.linkedPurchaseOrderId ?? null],
      )
      await insertEvent(client, id, null, 'pending', null, session.user_id)
      await client.query(
        `INSERT INTO audit_log (id, user_id, action, entity_type, entity_id, request_id)
         VALUES ($1, $2, 'customer_order.create', 'customer_order', $3, $4)`,
        [randomUUID(), session.user_id, id, request.id],
      )
      const response = {
        id,
        customerId: parsed.data.customerId,
        variantId: parsed.data.variantId ?? null,
        linkedPurchaseOrderId: parsed.data.linkedPurchaseOrderId ?? null,
        club: parsed.data.club,
        model: parsed.data.model,
        type: parsed.data.type,
        size: parsed.data.size,
        status: 'pending',
      }
      await store(client, scope, key, 201, response)
      await client.query('COMMIT')
      return reply.status(201).send(response)
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  })

  app.patch('/customer-orders/:id/status', async (request, reply) => {
    const session = await requirePermission(pool, request, reply, 'customer_orders:write')
    if (!session) return
    if (!hasValidCsrf(session, request)) return sendError(reply, request, 403, 'INVALID_CSRF', 'Token CSRF inválido.')
    const params = idSchema.safeParse(request.params)
    const parsed = statusSchema.safeParse(request.body)
    const key = request.headers['idempotency-key']
    if (!params.success || !parsed.success || typeof key !== 'string' || key.length < 1 || key.length > 200) {
      return sendError(reply, request, 400, 'VALIDATION_ERROR', 'Revise a mudança de status e a chave de idempotência.')
    }
    if (parsed.data.status === 'cancelled' && !parsed.data.reason) {
      return sendError(reply, request, 400, 'CANCELLATION_REASON_REQUIRED', 'Cancelamento exige motivo.')
    }

    const scope = `customer_order.status:${session.user_id}:${params.data.id}`
    const requestHash = createHash('sha256').update(JSON.stringify(parsed.data)).digest('hex')
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const cached = await claim(client, scope, key, requestHash)
      if (cached.kind === 'conflict') {
        await client.query('ROLLBACK')
        return sendError(reply, request, 409, 'IDEMPOTENCY_KEY_REUSED', 'A chave de idempotência já foi usada em outra requisição.')
      }
      if (cached.kind === 'cached') {
        await client.query('COMMIT')
        return reply.status(cached.status).send(cached.body)
      }

      const result = await client.query<{ status: string }>('SELECT status FROM customer_orders WHERE id = $1 FOR UPDATE', [params.data.id])
      const order = result.rows[0]
      if (!order) {
        await client.query('ROLLBACK')
        return sendError(reply, request, 404, 'CUSTOMER_ORDER_NOT_FOUND', 'Encomenda não encontrada.')
      }
      if (!allowedTransitions[order.status]?.includes(parsed.data.status)) {
        await client.query('ROLLBACK')
        return sendError(reply, request, 409, 'INVALID_STATUS_TRANSITION', 'A transição de status não é permitida.', {
          from: order.status,
          to: parsed.data.status,
        })
      }

      await client.query(
        `UPDATE customer_orders
         SET status = $2, cancellation_reason = CASE WHEN $2 = 'cancelled' THEN $3 ELSE cancellation_reason END, updated_at = now()
         WHERE id = $1`,
        [params.data.id, parsed.data.status, parsed.data.reason ?? null],
      )
      await insertEvent(client, params.data.id, order.status, parsed.data.status, parsed.data.reason ?? null, session.user_id)
      await client.query(
        `INSERT INTO audit_log (id, user_id, action, entity_type, entity_id, request_id, after_data)
         VALUES ($1, $2, 'customer_order.status_change', 'customer_order', $3, $4, $5)`,
        [randomUUID(), session.user_id, params.data.id, request.id, JSON.stringify({ from: order.status, to: parsed.data.status, reason: parsed.data.reason ?? null })],
      )
      const response = { id: params.data.id, status: parsed.data.status }
      await store(client, scope, key, 200, response)
      await client.query('COMMIT')
      return reply.send(response)
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  })

  app.get('/customer-orders/:id', async (request, reply) => {
    if (!await requirePermission(pool, request, reply, 'customer_orders:write')) return
    const params = idSchema.safeParse(request.params)
    if (!params.success) return sendError(reply, request, 400, 'VALIDATION_ERROR', 'Encomenda inválida.')
    const result = await pool.query(
      `SELECT id, customer_id AS "customerId", variant_id AS "variantId",
              linked_purchase_order_id AS "linkedPurchaseOrderId", club, model, type, size, notes,
              status, cancellation_reason AS "cancellationReason"
       FROM customer_orders WHERE id = $1`,
      [params.data.id],
    )
    const order = result.rows[0]
    if (!order) return sendError(reply, request, 404, 'CUSTOMER_ORDER_NOT_FOUND', 'Encomenda não encontrada.')
    const timeline = await pool.query(
      `SELECT id, from_status AS "fromStatus", to_status AS "toStatus", reason, created_at::text AS "createdAt"
       FROM customer_order_events WHERE customer_order_id = $1 ORDER BY created_at, id`,
      [params.data.id],
    )
    return reply.send({ ...order, timeline: timeline.rows })
  })
}

async function insertEvent(client: PoolClient, orderId: string, from: string | null, to: string, reason: string | null, userId: string) {
  await client.query(
    `INSERT INTO customer_order_events (id, customer_order_id, from_status, to_status, reason, user_id)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [randomUUID(), orderId, from, to, reason, userId],
  )
}

async function claim(
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

async function store(client: PoolClient, scope: string, key: string, status: number, response: unknown) {
  await client.query(
    `UPDATE idempotency_keys SET response_status = $3, response_body = $4, completed_at = now()
     WHERE scope = $1 AND key = $2`,
    [scope, key, status, JSON.stringify(response)],
  )
}
