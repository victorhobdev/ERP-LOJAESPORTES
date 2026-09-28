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
const listSchema = z.object({
  search: z.string().trim().max(120).optional(),
  club: z.string().trim().max(120).optional(),
  type: z.enum(['Masculina', 'Feminina', 'Infantil']).optional(),
  size: z.string().trim().max(30).optional(),
  availability: z.enum(['all', 'low', 'in_stock', 'out_of_stock']).default('all'),
  image: z.enum(['all', 'with', 'without']).default('all'),
  sort: z.enum(['club', 'model', 'type', 'size', 'stock', 'price', 'updated']).default('club'),
  order: z.enum(['asc', 'desc']).default('asc'),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(50),
})
const movementsQuerySchema = z.object({
  variantId: z.string().uuid().optional(),
  productId: z.string().uuid().optional(),
  type: z.enum(['opening_balance', 'purchase_receipt', 'sale', 'exchange_in', 'exchange_out', 'manual_adjustment', 'reversal']).optional(),
  order: z.enum(['asc', 'desc']).default('desc'),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
})
const adjustmentAction = 'inventory.manual_adjustment'

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

    const conditions: string[] = []
    const params: unknown[] = []
    const push = (value: unknown) => { params.push(value); return `$${params.length}` }
    if (parsed.data.search) {
      const term = `%${parsed.data.search}%`
      conditions.push(`(v.sku ILIKE ${push(term)} OR p.club ILIKE ${push(term)} OR p.model ILIKE ${push(term)})`)
    }
    if (parsed.data.club) conditions.push(`p.club ILIKE ${push(`%${parsed.data.club}%`)}`)
    if (parsed.data.type) conditions.push(`v.type = ${push(parsed.data.type)}`)
    if (parsed.data.size) conditions.push(`v.size ILIKE ${push(`%${parsed.data.size}%`)}`)
    if (parsed.data.availability === 'low') conditions.push('v.stock_quantity <= v.low_stock_threshold')
    if (parsed.data.availability === 'in_stock') conditions.push('v.stock_quantity > 0')
    if (parsed.data.availability === 'out_of_stock') conditions.push('v.stock_quantity = 0')
    if (parsed.data.image === 'with') conditions.push('EXISTS(SELECT 1 FROM media d WHERE d.product_id = p.id AND d.active)')
    if (parsed.data.image === 'without') conditions.push('NOT EXISTS(SELECT 1 FROM media d WHERE d.product_id = p.id AND d.active)')
    const sortColumn = {
      club: 'p.club', model: 'p.model', type: 'v.type', size: 'v.size',
      stock: 'v.stock_quantity', price: 'v.sale_price', updated: 'v.updated_at',
    }[parsed.data.sort]
    const direction = parsed.data.order === 'asc' ? 'ASC' : 'DESC'
    const offset = (parsed.data.page - 1) * parsed.data.limit

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
      total: string
    }>(
      `SELECT v.id AS "variantId", p.id AS "productId", p.club, p.model, v.type, v.size, v.sku,
              v.stock_quantity AS "stockQuantity", v.low_stock_threshold AS "lowStockThreshold",
              count(*) OVER()::text AS total
       FROM product_variants v
       JOIN products p ON p.id = v.product_id
       ${conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''}
       ORDER BY ${sortColumn} ${direction}, p.club ASC, p.model ASC, v.type ASC, v.size ASC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, parsed.data.limit, offset],
    )
    const total = Number(result.rows[0]?.total ?? 0)
    return reply.send({
      items: result.rows.map((row) => {
        const { total: _total, ...rest } = row
        void _total
        return rest
      }),
      total, page: parsed.data.page, limit: parsed.data.limit,
    })
  })

  app.get('/inventory/movements', async (request, reply) => {
    if (!await requirePermission(pool, request, reply, 'inventory:read')) return
    const parsed = movementsQuerySchema.safeParse(request.query)
    if (!parsed.success) return sendError(reply, request, 400, 'VALIDATION_ERROR', 'Filtro de movimentos inválido.')

    if (parsed.data.variantId) {
      const variant = await pool.query('SELECT 1 FROM product_variants WHERE id = $1', [parsed.data.variantId])
      if (!variant.rowCount) return sendError(reply, request, 404, 'VARIANT_NOT_FOUND', 'Variação não encontrada.')
    }
    if (parsed.data.productId) {
      const product = await pool.query('SELECT 1 FROM products WHERE id = $1', [parsed.data.productId])
      if (!product.rowCount) return sendError(reply, request, 404, 'PRODUCT_NOT_FOUND', 'Produto não encontrado.')
    }

    const conditions: string[] = []
    const params: unknown[] = []
    const push = (value: unknown) => { params.push(value); return `$${params.length}` }
    if (parsed.data.variantId) conditions.push(`m.variant_id = ${push(parsed.data.variantId)}`)
    if (parsed.data.productId) conditions.push(`v.product_id = ${push(parsed.data.productId)}`)
    if (parsed.data.type) conditions.push(`m.type = ${push(parsed.data.type)}`)
    const direction = parsed.data.order === 'asc' ? 'ASC' : 'DESC'
    const offset = (parsed.data.page - 1) * parsed.data.limit

    const result = await pool.query<{
      id: string
      variantId: string
      productId: string
      club: string
      model: string
      type: string
      size: string
      sku: string
      movementType: string
      quantityDelta: number
      balanceAfter: number
      reason: string | null
      sourceEntityType: string | null
      sourceEntityId: string | null
      userId: string
      userDisplayName: string
      createdAt: string
      total: string
    }>(
      `SELECT m.id, m.variant_id AS "variantId", v.product_id AS "productId",
              p.club, p.model, v.type, v.size, v.sku,
              m.type AS "movementType", m.quantity_delta AS "quantityDelta", m.balance_after AS "balanceAfter",
              m.reason, m.source_entity_type AS "sourceEntityType", m.source_entity_id::text AS "sourceEntityId",
              m.user_id AS "userId", u.display_name AS "userDisplayName", m.created_at::text AS "createdAt",
              count(*) OVER()::text AS total
       FROM inventory_movements m
       JOIN product_variants v ON v.id = m.variant_id
       JOIN products p ON p.id = v.product_id
       JOIN users u ON u.id = m.user_id
       ${conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''}
       ORDER BY m.created_at ${direction}, m.id ${direction}
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, parsed.data.limit, offset],
    )
    const total = Number(result.rows[0]?.total ?? 0)
    return reply.send({
      items: result.rows.map((row) => {
        const { total: _movementsTotal, ...rest } = row
        void _movementsTotal
        return rest
      }),
      total, page: parsed.data.page, limit: parsed.data.limit,
    })
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
    const idempotencyScope = `${adjustmentAction}:${session.user_id}`
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const inserted = await client.query(
        `INSERT INTO idempotency_keys (id, scope, key, request_hash)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (scope, key) DO NOTHING
         RETURNING id`,
        [randomUUID(), idempotencyScope, idempotencyKey, requestHash],
      )

      if (inserted.rowCount === 0) {
        const existing = await client.query<IdempotencyRow>(
          `SELECT request_hash, response_status, response_body
           FROM idempotency_keys WHERE scope = $1 AND key = $2 FOR UPDATE`,
          [idempotencyScope, idempotencyKey],
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
        [movementId, parsed.data.variantId, parsed.data.quantityDelta, balanceAfter, parsed.data.reason, `${idempotencyScope}:${idempotencyKey}`, session.user_id],
      )
      await client.query(
        `INSERT INTO audit_log (id, user_id, action, entity_type, entity_id, request_id, after_data)
         VALUES ($1, $2, $3, 'product_variant', $4, $5, $6)`,
        [randomUUID(), session.user_id, adjustmentAction, parsed.data.variantId, request.id, JSON.stringify({ quantityDelta: parsed.data.quantityDelta, balanceAfter, reason: parsed.data.reason })],
      )

      const response = { id: movementId, variantId: parsed.data.variantId, quantityDelta: parsed.data.quantityDelta, balanceAfter }
      await client.query(
        `UPDATE idempotency_keys
         SET response_status = 201, response_body = $3, completed_at = now()
         WHERE scope = $1 AND key = $2`,
        [idempotencyScope, idempotencyKey, JSON.stringify(response)],
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
