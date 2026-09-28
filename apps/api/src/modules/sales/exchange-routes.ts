import { createHash, randomUUID } from 'node:crypto'

import type { FastifyInstance } from 'fastify'
import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'

import { hasValidCsrf, requirePermission, sendError } from '../../shared/auth/http.js'

const exchangeItem = z.object({ variantId: z.string().uuid(), quantity: z.number().int().positive().max(10_000) })
const exchangeSchema = z.object({
  reason: z.string().trim().min(1).max(500),
  returned: z.array(exchangeItem).min(1).max(100),
  delivered: z.array(exchangeItem).min(1).max(100),
}).superRefine((value, context) => {
  for (const field of ['returned', 'delivered'] as const) {
    const ids = new Set<string>()
    for (const [index, item] of value[field].entries()) {
      if (ids.has(item.variantId)) context.addIssue({ code: 'custom', message: 'Duplicate variant.', path: [field, index, 'variantId'] })
      ids.add(item.variantId)
    }
  }
  const returnedUnits = value.returned.reduce((total, item) => total + item.quantity, 0)
  const deliveredUnits = value.delivered.reduce((total, item) => total + item.quantity, 0)
  if (returnedUnits !== deliveredUnits) context.addIssue({ code: 'custom', message: 'Exchange quantities must match.', path: ['delivered'] })
})
const idSchema = z.object({ id: z.string().uuid() })

type IdempotencyRow = { request_hash: string; response_status: number | null; response_body: unknown }
type VariantRow = { id: string; sale_price: string; current_cost: string; stock_quantity: number }
type SoldRow = { variant_id: string; sold_quantity: string; unit_price: string; unit_cost: string }

export function registerExchangeRoutes(app: FastifyInstance, pool: Pool) {
  app.post('/sales/:id/exchanges', async (request, reply) => {
    const session = await requirePermission(pool, request, reply, 'sales:exchange')
    if (!session) return
    if (!hasValidCsrf(session, request)) return sendError(reply, request, 403, 'INVALID_CSRF', 'Token CSRF inválido.')

    const params = idSchema.safeParse(request.params)
    const exchange = exchangeSchema.safeParse(request.body)
    const idempotencyKey = request.headers['idempotency-key']
    if (!params.success || !exchange.success || typeof idempotencyKey !== 'string' || idempotencyKey.length < 1 || idempotencyKey.length > 200) {
      return sendError(reply, request, 400, 'VALIDATION_ERROR', 'Revise os itens, o motivo e a chave de idempotência.')
    }

    const idempotencyScope = `sales.exchange:${session.user_id}:${params.data.id}`
    const requestHash = createHash('sha256').update(JSON.stringify(exchange.data)).digest('hex')
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const inserted = await client.query(
        `INSERT INTO idempotency_keys (id, scope, key, request_hash)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (scope, key) DO NOTHING RETURNING id`,
        [randomUUID(), idempotencyScope, idempotencyKey, requestHash],
      )
      if (inserted.rowCount === 0) {
        const existing = await client.query<IdempotencyRow>(
          `SELECT request_hash, response_status, response_body FROM idempotency_keys
           WHERE scope = $1 AND key = $2 FOR UPDATE`,
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

      const saleResult = await client.query<{ status: string }>('SELECT status FROM sales WHERE id = $1 FOR UPDATE', [params.data.id])
      const sale = saleResult.rows[0]
      if (!sale) {
        await client.query('ROLLBACK')
        return sendError(reply, request, 404, 'SALE_NOT_FOUND', 'Venda não encontrada.')
      }
      if (sale.status === 'reversed') {
        await client.query('ROLLBACK')
        return sendError(reply, request, 409, 'SALE_REVERSED', 'Venda estornada não pode ser trocada.')
      }

      const variantIds = [...new Set([...exchange.data.returned, ...exchange.data.delivered].map(({ variantId }) => variantId))].sort()
      const variantsResult = await client.query<VariantRow>(
        `SELECT id, sale_price, current_cost, stock_quantity FROM product_variants
         WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE`,
        [variantIds],
      )
      if (variantsResult.rowCount !== variantIds.length) {
        await client.query('ROLLBACK')
        return sendError(reply, request, 404, 'VARIANT_NOT_FOUND', 'Uma das variações não foi encontrada.')
      }
      const variants = new Map(variantsResult.rows.map((variant) => [variant.id, variant]))

      const returnedIds = exchange.data.returned.map(({ variantId }) => variantId)
      const soldResult = await client.query<SoldRow>(
        `SELECT variant_id, sum(quantity)::text AS sold_quantity,
                max(unit_price)::text AS unit_price, max(unit_cost)::text AS unit_cost
         FROM sale_items WHERE sale_id = $1 AND variant_id = ANY($2::uuid[])
         GROUP BY variant_id`,
        [params.data.id, returnedIds],
      )
      const sold = new Map(soldResult.rows.map((item) => [item.variant_id, item]))
      const priorReturns = await client.query<{ variant_id: string; quantity: string }>(
        `SELECT ei.variant_id, sum(ei.quantity)::text AS quantity
         FROM exchange_items ei JOIN exchanges e ON e.id = ei.exchange_id
         WHERE e.sale_id = $1 AND ei.direction = 'returned' AND ei.variant_id = ANY($2::uuid[])
         GROUP BY ei.variant_id`,
        [params.data.id, returnedIds],
      )
      const returnedBefore = new Map(priorReturns.rows.map((item) => [item.variant_id, Number(item.quantity)]))

      let returnedValue = 0n
      for (const item of exchange.data.returned) {
        const soldItem = sold.get(item.variantId)
        const returnable = Number(soldItem?.sold_quantity ?? 0) - (returnedBefore.get(item.variantId) ?? 0)
        if (!soldItem || item.quantity > returnable) {
          await client.query('ROLLBACK')
          return sendError(reply, request, 409, 'RETURN_QUANTITY_EXCEEDED', 'A devolução excede a quantidade vendida ainda disponível para troca.', {
            variantId: item.variantId,
            returnable,
            requested: item.quantity,
          })
        }
        returnedValue += toCents(soldItem.unit_price) * BigInt(item.quantity)
      }

      let deliveredValue = 0n
      const returnedByVariant = new Map(exchange.data.returned.map((item) => [item.variantId, item.quantity]))
      for (const item of exchange.data.delivered) {
        const variant = variants.get(item.variantId)!
        const available = variant.stock_quantity + (returnedByVariant.get(item.variantId) ?? 0)
        if (item.quantity > available) {
          await client.query('ROLLBACK')
          return sendError(reply, request, 409, 'INSUFFICIENT_STOCK', 'Estoque insuficiente para entregar o item da troca.', {
            variantId: item.variantId,
            available,
            requested: item.quantity,
          })
        }
        deliveredValue += toCents(variant.sale_price) * BigInt(item.quantity)
      }
      if (returnedValue !== deliveredValue) {
        await client.query('ROLLBACK')
        return sendError(reply, request, 409, 'EXCHANGE_VALUE_MISMATCH', 'Trocas com diferença de valor exigem tratamento financeiro ainda não aprovado.')
      }

      const exchangeId = randomUUID()
      await client.query(
        `INSERT INTO exchanges (id, sale_id, operator_id, reason, idempotency_key)
         VALUES ($1, $2, $3, $4, $5)`,
        [exchangeId, params.data.id, session.user_id, exchange.data.reason, `${idempotencyScope}:${idempotencyKey}`],
      )
      const balances = new Map(variantsResult.rows.map((variant) => [variant.id, variant.stock_quantity]))
      for (const item of exchange.data.returned) {
        const soldItem = sold.get(item.variantId)!
        const balanceAfter = balances.get(item.variantId)! + item.quantity
        balances.set(item.variantId, balanceAfter)
        await insertExchangeItem(client, exchangeId, item.variantId, 'returned', item.quantity, soldItem.unit_price, soldItem.unit_cost)
        await updateStock(client, item.variantId, balanceAfter)
        await insertMovement(client, exchangeId, item.variantId, 'exchange_in', item.quantity, balanceAfter, session.user_id)
      }
      for (const item of exchange.data.delivered) {
        const variant = variants.get(item.variantId)!
        const balanceAfter = balances.get(item.variantId)! - item.quantity
        balances.set(item.variantId, balanceAfter)
        await insertExchangeItem(client, exchangeId, item.variantId, 'delivered', item.quantity, variant.sale_price, variant.current_cost)
        await updateStock(client, item.variantId, balanceAfter)
        await insertMovement(client, exchangeId, item.variantId, 'exchange_out', -item.quantity, balanceAfter, session.user_id)
      }
      await client.query(
        `INSERT INTO audit_log (id, user_id, action, entity_type, entity_id, request_id, after_data)
         VALUES ($1, $2, 'sale.exchange', 'sale', $3, $4, $5)`,
        [randomUUID(), session.user_id, params.data.id, request.id, JSON.stringify({ exchangeId, reason: exchange.data.reason, returned: exchange.data.returned, delivered: exchange.data.delivered })],
      )

      const response = {
        id: exchangeId,
        saleId: params.data.id,
        returnedUnits: exchange.data.returned.reduce((total, item) => total + item.quantity, 0),
        deliveredUnits: exchange.data.delivered.reduce((total, item) => total + item.quantity, 0),
      }
      await client.query(
        `UPDATE idempotency_keys SET response_status = 201, response_body = $3, completed_at = now()
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

async function insertExchangeItem(
  client: PoolClient,
  exchangeId: string,
  variantId: string,
  direction: 'returned' | 'delivered',
  quantity: number,
  unitPrice: string,
  unitCost: string,
) {
  await client.query(
    `INSERT INTO exchange_items (id, exchange_id, variant_id, direction, quantity, unit_price, unit_cost)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [randomUUID(), exchangeId, variantId, direction, quantity, unitPrice, unitCost],
  )
}

async function updateStock(client: PoolClient, variantId: string, balance: number) {
  await client.query(
    'UPDATE product_variants SET stock_quantity = $2, version = version + 1, updated_at = now() WHERE id = $1',
    [variantId, balance],
  )
}

async function insertMovement(
  client: PoolClient,
  exchangeId: string,
  variantId: string,
  type: 'exchange_in' | 'exchange_out',
  delta: number,
  balance: number,
  userId: string,
) {
  await client.query(
    `INSERT INTO inventory_movements
       (id, variant_id, type, quantity_delta, balance_after, source_entity_type, source_entity_id, idempotency_key, user_id)
     VALUES ($1, $2, $3, $4, $5, 'exchange', $6, $7, $8)`,
    [randomUUID(), variantId, type, delta, balance, exchangeId, `exchange:${exchangeId}:${type}:${variantId}`, userId],
  )
}

function toCents(value: string): bigint {
  const [whole = '0', fraction = '00'] = value.split('.')
  return BigInt(whole) * 100n + BigInt(fraction)
}
