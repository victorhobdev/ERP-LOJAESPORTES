import { createHash, randomUUID } from 'node:crypto'

import type { FastifyInstance } from 'fastify'
import type { Pool } from 'pg'
import { z } from 'zod'

import { hasValidCsrf, requirePermission, sendError } from '../../shared/auth/http.js'

const money = z.string().regex(/^(0|[1-9]\d*)\.\d{2}$/)
const paymentMethods = ['cash', 'pix', 'debit_card', 'credit_card', 'bank_transfer', 'other'] as const
const saleSchema = z.object({
  customerId: z.string().uuid().optional(),
  paymentDueDate: z.iso.date().optional(),
  items: z.array(z.object({ variantId: z.string().uuid(), quantity: z.number().int().positive().max(10_000) })).min(1).max(100),
  discountAmount: money,
  payment: z.object({ amount: money.refine((value) => toCents(value) > 0n), method: z.enum(paymentMethods) }).optional(),
}).superRefine((value, context) => {
  const ids = new Set<string>()
  for (const [index, item] of value.items.entries()) {
    if (ids.has(item.variantId)) context.addIssue({ code: 'custom', message: 'Duplicate variant.', path: ['items', index, 'variantId'] })
    ids.add(item.variantId)
  }
})
const idSchema = z.object({ id: z.string().uuid() })
const saleCreateAction = 'sales.create'
const maxMoneyCents = 99_999_999_999_999n

type LockedVariant = {
  id: string
  sale_price: string
  current_cost: string
  stock_quantity: number
}
type IdempotencyRow = {
  request_hash: string
  response_status: number | null
  response_body: unknown
}

export function registerSalesRoutes(app: FastifyInstance, pool: Pool) {
  app.post('/sales', async (request, reply) => {
    const session = await requirePermission(pool, request, reply, 'sales:create')
    if (!session) return
    if (!hasValidCsrf(session, request)) return sendError(reply, request, 403, 'INVALID_CSRF', 'Token CSRF inválido.')

    const parsed = saleSchema.safeParse(request.body)
    const idempotencyKey = request.headers['idempotency-key']
    if (!parsed.success || typeof idempotencyKey !== 'string' || idempotencyKey.length < 1 || idempotencyKey.length > 200) {
      return sendError(reply, request, 400, 'VALIDATION_ERROR', 'Revise os dados da venda e a chave de idempotência.')
    }
    const discountCents = toCents(parsed.data.discountAmount)
    if (discountCents > 0n && !session.permissions.includes('*') && !session.permissions.includes('sales:discount')) {
      return sendError(reply, request, 403, 'FORBIDDEN', 'Você não tem permissão para aplicar desconto.')
    }

    const requestHash = createHash('sha256').update(JSON.stringify(parsed.data)).digest('hex')
    const idempotencyScope = `${saleCreateAction}:${session.user_id}`
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

      if (parsed.data.customerId) {
        const customer = await client.query('SELECT 1 FROM customers WHERE id = $1 AND active = true', [parsed.data.customerId])
        if (!customer.rowCount) {
          await client.query('ROLLBACK')
          return sendError(reply, request, 404, 'CUSTOMER_NOT_FOUND', 'Cliente não encontrado.')
        }
      }

      const variantIds = parsed.data.items.map(({ variantId }) => variantId).sort()
      const variants = await client.query<LockedVariant>(
        `SELECT id, sale_price, current_cost, stock_quantity
         FROM product_variants WHERE id = ANY($1::uuid[])
         ORDER BY id FOR UPDATE`,
        [variantIds],
      )
      if (variants.rowCount !== variantIds.length) {
        await client.query('ROLLBACK')
        return sendError(reply, request, 404, 'VARIANT_NOT_FOUND', 'Uma das variações não foi encontrada.')
      }
      const variantsById = new Map(variants.rows.map((variant) => [variant.id, variant]))

      let subtotalCents = 0n
      for (const item of parsed.data.items) {
        const variant = variantsById.get(item.variantId)!
        if (variant.stock_quantity < item.quantity) {
          await client.query('ROLLBACK')
          return sendError(reply, request, 409, 'INSUFFICIENT_STOCK', 'Estoque insuficiente para concluir a venda.', {
            variantId: item.variantId,
            available: variant.stock_quantity,
            requested: item.quantity,
          })
        }
        subtotalCents += toCents(variant.sale_price) * BigInt(item.quantity)
      }
      if (subtotalCents > maxMoneyCents) {
        await client.query('ROLLBACK')
        return sendError(reply, request, 400, 'TOTAL_TOO_LARGE', 'O total da venda excede o limite permitido.')
      }
      if (discountCents > subtotalCents) {
        await client.query('ROLLBACK')
        return sendError(reply, request, 400, 'INVALID_DISCOUNT', 'O desconto não pode exceder o subtotal.')
      }

      const finalCents = subtotalCents - discountCents
      const paidCents = parsed.data.payment ? toCents(parsed.data.payment.amount) : 0n
      if (paidCents > finalCents) {
        await client.query('ROLLBACK')
        return sendError(reply, request, 400, 'PAYMENT_EXCEEDS_TOTAL', 'O pagamento não pode exceder o total da venda.')
      }
      const status = paidCents === finalCents ? 'paid' : paidCents > 0n ? 'partially_paid' : 'pending'
      if (status !== 'paid' && (!parsed.data.customerId || !parsed.data.paymentDueDate)) {
        await client.query('ROLLBACK')
        return sendError(reply, request, 400, 'PENDING_SALE_REQUIRES_CUSTOMER', 'Venda pendente exige cliente e vencimento.')
      }

      const saleId = randomUUID()
      await client.query(
        `INSERT INTO sales
           (id, customer_id, operator_id, status, subtotal_amount, discount_amount, final_amount, payment_due_date)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [saleId, parsed.data.customerId ?? null, session.user_id, status, formatCents(subtotalCents), formatCents(discountCents), formatCents(finalCents), parsed.data.paymentDueDate ?? null],
      )

      const responseItems = []
      for (const item of parsed.data.items) {
        const variant = variantsById.get(item.variantId)!
        const balanceAfter = variant.stock_quantity - item.quantity
        await client.query(
          `INSERT INTO sale_items (id, sale_id, variant_id, quantity, unit_price, unit_cost)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [randomUUID(), saleId, item.variantId, item.quantity, variant.sale_price, variant.current_cost],
        )
        await client.query(
          `UPDATE product_variants SET stock_quantity = $2, version = version + 1, updated_at = now() WHERE id = $1`,
          [item.variantId, balanceAfter],
        )
        await client.query(
          `INSERT INTO inventory_movements
             (id, variant_id, type, quantity_delta, balance_after, source_entity_type, source_entity_id, idempotency_key, user_id)
           VALUES ($1, $2, 'sale', $3, $4, 'sale', $5, $6, $7)`,
          [randomUUID(), item.variantId, -item.quantity, balanceAfter, saleId, `sales:${saleId}:${item.variantId}`, session.user_id],
        )
        responseItems.push({ variantId: item.variantId, quantity: item.quantity, unitPrice: variant.sale_price, unitCost: variant.current_cost })
      }

      if (parsed.data.payment) {
        await client.query(
          `INSERT INTO payments (id, sale_id, received_by, amount, method, idempotency_key)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [randomUUID(), saleId, session.user_id, parsed.data.payment.amount, parsed.data.payment.method, `sales:${saleId}:initial-payment`],
        )
      }
      await client.query(
        `INSERT INTO audit_log (id, user_id, action, entity_type, entity_id, request_id, after_data)
         VALUES ($1, $2, 'sale.create', 'sale', $3, $4, $5)`,
        [randomUUID(), session.user_id, saleId, request.id, JSON.stringify({ status, subtotalAmount: formatCents(subtotalCents), discountAmount: formatCents(discountCents), finalAmount: formatCents(finalCents) })],
      )

      const response = {
        id: saleId,
        customerId: parsed.data.customerId ?? null,
        status,
        subtotalAmount: formatCents(subtotalCents),
        discountAmount: formatCents(discountCents),
        finalAmount: formatCents(finalCents),
        amountDue: formatCents(finalCents - paidCents),
        items: responseItems,
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

  app.get('/sales/:id', async (request, reply) => {
    if (!await requirePermission(pool, request, reply, 'sales:read')) return
    const parsed = idSchema.safeParse(request.params)
    if (!parsed.success) return sendError(reply, request, 400, 'VALIDATION_ERROR', 'Venda inválida.')

    const saleResult = await pool.query<{
      id: string
      customerId: string | null
      status: string
      subtotalAmount: string
      discountAmount: string
      finalAmount: string
    }>(
      `SELECT id, customer_id AS "customerId", status, subtotal_amount::text AS "subtotalAmount",
              discount_amount::text AS "discountAmount", final_amount::text AS "finalAmount"
       FROM sales WHERE id = $1`,
      [parsed.data.id],
    )
    const sale = saleResult.rows[0]
    if (!sale) return sendError(reply, request, 404, 'SALE_NOT_FOUND', 'Venda não encontrada.')

    const items = await pool.query<{
      variantId: string
      quantity: number
      unitPrice: string
      unitCost: string
    }>(
      `SELECT variant_id AS "variantId", quantity, unit_price::text AS "unitPrice", unit_cost::text AS "unitCost"
       FROM sale_items WHERE sale_id = $1 ORDER BY created_at, id`,
      [sale.id],
    )
    const payments = await pool.query<{ id: string; amount: string; method: string; status: string }>(
      `SELECT id, amount::text, method, status FROM payments WHERE sale_id = $1 ORDER BY received_at, id`,
      [sale.id],
    )
    const paidCents = payments.rows.filter(({ status }) => status === 'confirmed').reduce((total, payment) => total + toCents(payment.amount), 0n)
    return reply.send({ ...sale, amountDue: formatCents(toCents(sale.finalAmount) - paidCents), items: items.rows, payments: payments.rows })
  })
}

function toCents(value: string): bigint {
  const [whole, fraction] = value.split('.') as [string, string]
  return BigInt(whole) * 100n + BigInt(fraction)
}

function formatCents(value: bigint): string {
  const whole = value / 100n
  const fraction = (value % 100n).toString().padStart(2, '0')
  return `${whole}.${fraction}`
}
