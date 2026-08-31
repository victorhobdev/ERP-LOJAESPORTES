import { createHash, randomUUID } from 'node:crypto'

import type { FastifyInstance } from 'fastify'
import type { Pool } from 'pg'
import { z } from 'zod'

import { hasValidCsrf, requirePermission, sendError } from '../../shared/auth/http.js'

const adjustmentSchema = z.object({
  variantId: z.string().uuid(),
  quantityDelta: z.number().int().refine((value) => value !== 0),
  reason: z.string().trim().min(1).max(500),
})
const listSchema = z.object({ availability: z.enum(['all', 'low']).default('all') })
const adjustmentScope = 'inventory.manual_adjustment'

type IdempotencyRow = {
  request_hash: string
  response_status: number | null
  response_body: unknown
}

export function registerInventoryRoutes(app: FastifyInstance, pool: Pool) {
  app.get('/inventory', async (request, reply) => {
    if (!await requirePermission(pool, request, reply, 'inventory:read')) return
    const parsed = listSchema.safeParse(request.query)
    if (!parsed.success) return sendError(reply, request, 400, 'VALIDATION_ERROR', 'Filtro de estoque inválido.')

    const lowStockClause = parsed.data.availability === 'low' ? 'AND v.stock_quantity <= v.low_stock_threshold' : ''
    const result = await pool.query<{
      variantId: string
      productId: string
      club: string
      model: string
      type: string
      size: string
      sku: string
      stockQuantity: number
      lowStockThreshold: number
    }>(
      `SELECT v.id AS "variantId", p.id AS "productId", p.club, p.model, v.type, v.size, v.sku,
              v.stock_quantity AS "stockQuantity", v.low_stock_threshold AS "lowStockThreshold"
       FROM product_variants v
       JOIN products p ON p.id = v.product_id
       WHERE p.active = true ${lowStockClause}
       ORDER BY p.club, p.model, v.type, v.size`,
    )
    return reply.send({ items: result.rows })
  })

  app.post('/inventory/movements', async (request, reply) => {
    const session = await requirePermission(pool, request, reply, 'inventory:adjust')
    if (!session) return
    if (!hasValidCsrf(session, request)) return sendError(reply, request, 403, 'INVALID_CSRF', 'Token CSRF inválido.')

    const parsed = adjustmentSchema.safeParse(request.body)
    const idempotencyKey = request.headers['idempotency-key']
    if (!parsed.success || typeof idempotencyKey !== 'string' || idempotencyKey.length < 1 || idempotencyKey.length > 200) {
      return sendError(reply, request, 400, 'VALIDATION_ERROR', 'Revise o ajuste e a chave de idempotência.')
    }

    const requestHash = createHash('sha256').update(JSON.stringify(parsed.data)).digest('hex')
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const inserted = await client.query(
        `INSERT INTO idempotency_keys (id, scope, key, request_hash)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (scope, key) DO NOTHING
         RETURNING id`,
        [randomUUID(), adjustmentScope, idempotencyKey, requestHash],
      )

      if (inserted.rowCount === 0) {
        const existing = await client.query<IdempotencyRow>(
          `SELECT request_hash, response_status, response_body
           FROM idempotency_keys WHERE scope = $1 AND key = $2 FOR UPDATE`,
          [adjustmentScope, idempotencyKey],
        )
        const prior = existing.rows[0]
        if (!prior || prior.request_hash !== requestHash) {
          await client.query('ROLLBACK')
          return sendError(reply, request, 409, 'IDEMPOTENCY_KEY_REUSED', 'A chave de idempotência já foi usada em outra requisição.')
        }
        if (prior.response_status && prior.response_body !== null) {
          await client.query('COMMIT')
          return reply.status(prior.response_status).send(prior.response_body)
        }
      }

      const variantResult = await client.query<{ stock_quantity: number }>(
        'SELECT stock_quantity FROM product_variants WHERE id = $1 FOR UPDATE',
        [parsed.data.variantId],
      )
      const variant = variantResult.rows[0]
      if (!variant) {
        await client.query('ROLLBACK')
        return sendError(reply, request, 404, 'VARIANT_NOT_FOUND', 'Variação não encontrada.')
      }

      const balanceAfter = variant.stock_quantity + parsed.data.quantityDelta
      if (balanceAfter < 0) {
        await client.query('ROLLBACK')
        return sendError(reply, request, 409, 'INSUFFICIENT_STOCK', 'Estoque insuficiente para concluir a movimentação.', {
          available: variant.stock_quantity,
          requested: Math.abs(parsed.data.quantityDelta),
        })
      }

      const movementId = randomUUID()
      await client.query(
        `UPDATE product_variants
         SET stock_quantity = $2, version = version + 1, updated_at = now()
         WHERE id = $1`,
        [parsed.data.variantId, balanceAfter],
      )
      await client.query(
        `INSERT INTO inventory_movements
           (id, variant_id, type, quantity_delta, balance_after, reason, idempotency_key, user_id)
         VALUES ($1, $2, 'manual_adjustment', $3, $4, $5, $6, $7)`,
        [movementId, parsed.data.variantId, parsed.data.quantityDelta, balanceAfter, parsed.data.reason, `${adjustmentScope}:${idempotencyKey}`, session.user_id],
      )
      await client.query(
        `INSERT INTO audit_log (id, user_id, action, entity_type, entity_id, request_id, after_data)
         VALUES ($1, $2, $3, 'product_variant', $4, $5, $6)`,
        [randomUUID(), session.user_id, adjustmentScope, parsed.data.variantId, request.id, JSON.stringify({ quantityDelta: parsed.data.quantityDelta, balanceAfter, reason: parsed.data.reason })],
      )

      const response = { id: movementId, variantId: parsed.data.variantId, quantityDelta: parsed.data.quantityDelta, balanceAfter }
      await client.query(
        `UPDATE idempotency_keys
         SET response_status = 201, response_body = $3, completed_at = now()
         WHERE scope = $1 AND key = $2`,
        [adjustmentScope, idempotencyKey, JSON.stringify(response)],
      )
      await client.query('COMMIT')
      return reply.status(201).send(response)
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  })
}
