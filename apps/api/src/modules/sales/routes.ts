import { createHash, randomUUID } from 'node:crypto'

import type { FastifyInstance } from 'fastify'
import type { Pool } from 'pg'
import { z } from 'zod'

import { hasPermission } from '../../shared/auth/authorization.js'
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
const paymentSchema = z.object({ amount: money.refine((value) => toCents(value) > 0n), method: z.enum(paymentMethods) })
const salesListSchema = z.object({
  status: z.enum(['paid', 'pending', 'partially_paid', 'reversed', 'open']).optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
})
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
      if (status !== 'paid' && parsed.data.paymentDueDate && parsed.data.paymentDueDate <= localTodayIso()) {
        await client.query('ROLLBACK')
        return sendError(reply, request, 400, 'PENDING_SALE_DUE_DATE_PAST', 'A venda pendente ou parcial exige vencimento futuro.')
      }

      const saleId = randomUUID()
      await client.query(
        `INSERT INTO sales
           (id, customer_id, operator_id, status, subtotal_amount, discount_amount, final_amount, payment_due_date)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [saleId, parsed.data.customerId ?? null, session.user_id, status, formatCents(subtotalCents), formatCents(discountCents), formatCents(finalCents), parsed.data.paymentDueDate ?? null],
      )

      const responseItems: Array<{ variantId: string; quantity: number; unitPrice: string; unitCost?: string }> = []
      const includeCost = hasPermission(session.permissions, 'products:write')
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
        responseItems.push({
          variantId: item.variantId, quantity: item.quantity, unitPrice: variant.sale_price,
          ...(includeCost ? { unitCost: variant.current_cost } : {}),
        })
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

  app.post('/sales/:id/payments', async (request, reply) => {
    const session = await requirePermission(pool, request, reply, 'sales:payment')
    if (!session) return
    if (!hasValidCsrf(session, request)) return sendError(reply, request, 403, 'INVALID_CSRF', 'Token CSRF inválido.')

    const params = idSchema.safeParse(request.params)
    const payment = paymentSchema.safeParse(request.body)
    const idempotencyKey = request.headers['idempotency-key']
    if (!params.success || !payment.success || typeof idempotencyKey !== 'string' || idempotencyKey.length < 1 || idempotencyKey.length > 200) {
      return sendError(reply, request, 400, 'VALIDATION_ERROR', 'Revise os dados do pagamento e a chave de idempotência.')
    }

    const idempotencyScope = `sales.payment:${session.user_id}:${params.data.id}`
    const requestHash = createHash('sha256').update(JSON.stringify(payment.data)).digest('hex')
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

      const saleResult = await client.query<{ final_amount: string; status: string }>(
        'SELECT final_amount, status FROM sales WHERE id = $1 FOR UPDATE',
        [params.data.id],
      )
      const sale = saleResult.rows[0]
      if (!sale) {
        await client.query('ROLLBACK')
        return sendError(reply, request, 404, 'SALE_NOT_FOUND', 'Venda não encontrada.')
      }
      if (sale.status === 'reversed') {
        await client.query('ROLLBACK')
        return sendError(reply, request, 409, 'SALE_REVERSED', 'Venda estornada não pode receber pagamento.')
      }

      const paidResult = await client.query<{ amount: string }>(
        `SELECT coalesce(sum(amount), 0)::text AS amount FROM payments
         WHERE sale_id = $1 AND status = 'confirmed'`,
        [params.data.id],
      )
      const finalCents = toCents(sale.final_amount)
      const paidCents = toCents(paidResult.rows[0]!.amount)
      const paymentCents = toCents(payment.data.amount)
      const amountDue = finalCents - paidCents
      if (paymentCents > amountDue) {
        await client.query('ROLLBACK')
        return sendError(reply, request, 409, 'PAYMENT_EXCEEDS_AMOUNT_DUE', 'O pagamento excede o saldo devido.', {
          amountDue: formatCents(amountDue),
        })
      }

      const paymentId = randomUUID()
      await client.query(
        `INSERT INTO payments (id, sale_id, received_by, amount, method, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [paymentId, params.data.id, session.user_id, payment.data.amount, payment.data.method, `${idempotencyScope}:${idempotencyKey}`],
      )
      const remainingCents = amountDue - paymentCents
      const status = remainingCents === 0n ? 'paid' : 'partially_paid'
      await client.query('UPDATE sales SET status = $2, updated_at = now() WHERE id = $1', [params.data.id, status])
      await client.query(
        `INSERT INTO audit_log (id, user_id, action, entity_type, entity_id, request_id, after_data)
         VALUES ($1, $2, 'sale.payment', 'sale', $3, $4, $5)`,
        [randomUUID(), session.user_id, params.data.id, request.id, JSON.stringify({ paymentId, amount: payment.data.amount, method: payment.data.method, status, amountDue: formatCents(remainingCents) })],
      )

      const response = { id: paymentId, saleId: params.data.id, status, amountDue: formatCents(remainingCents) }
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

  // Estorno de venda (doc 06: correção usa estorno autorizado; decisão do
  // proprietário: o administrador pode estornar sem motivo). Restaura estoque,
  // marca pagamentos como estornados e preserva tudo em auditoria. Venda com
  // troca não é estornada porque as trocas já movimentaram estoque.
  const reversalSchema = z.object({ reason: z.string().trim().max(500).optional() })

  app.post('/sales/:id/reversal', async (request, reply) => {
    const session = await requirePermission(pool, request, reply, 'sales:reverse')
    if (!session) return
    if (!hasValidCsrf(session, request)) return sendError(reply, request, 403, 'INVALID_CSRF', 'Token CSRF inválido.')

    const params = idSchema.safeParse(request.params)
    const parsed = reversalSchema.safeParse(request.body ?? {})
    if (!params.success || !parsed.success) {
      return sendError(reply, request, 400, 'VALIDATION_ERROR', 'Revise a venda e o motivo do estorno.')
    }

    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const saleResult = await client.query<{ status: string }>('SELECT status FROM sales WHERE id = $1 FOR UPDATE', [params.data.id])
      const sale = saleResult.rows[0]
      if (!sale) {
        await client.query('ROLLBACK')
        return sendError(reply, request, 404, 'SALE_NOT_FOUND', 'Venda não encontrada.')
      }
      if (sale.status === 'reversed') {
        await client.query('ROLLBACK')
        return sendError(reply, request, 409, 'SALE_ALREADY_REVERSED', 'A venda já está estornada.')
      }
      const exchanges = await client.query('SELECT 1 FROM exchanges WHERE sale_id = $1 LIMIT 1', [params.data.id])
      if ((exchanges.rowCount ?? 0) > 0) {
        await client.query('ROLLBACK')
        return sendError(reply, request, 409, 'SALE_HAS_EXCHANGES', 'Venda com troca não pode ser estornada; corrija pelas trocas.')
      }

      const paymentsResult = await client.query(
        `UPDATE payments SET status = 'reversed'
         WHERE sale_id = $1 AND status = 'confirmed' RETURNING id`,
        [params.data.id],
      )

      const items = await client.query<{ variant_id: string; quantity: number }>(
        'SELECT variant_id, quantity FROM sale_items WHERE sale_id = $1 ORDER BY variant_id FOR UPDATE',
        [params.data.id],
      )
      for (const item of items.rows) {
        const variantResult = await client.query<{ stock_quantity: number }>(
          'SELECT stock_quantity FROM product_variants WHERE id = $1 FOR UPDATE',
          [item.variant_id],
        )
        const variant = variantResult.rows[0]
        if (!variant) {
          throw new Error(`Variant ${item.variant_id} missing while reversing sale ${params.data.id}`)
        }
        const balanceAfter = variant.stock_quantity + item.quantity
        await client.query(
          'UPDATE product_variants SET stock_quantity = $2, version = version + 1, updated_at = now() WHERE id = $1',
          [item.variant_id, balanceAfter],
        )
        await client.query(
          `INSERT INTO inventory_movements
             (id, variant_id, type, quantity_delta, balance_after, source_entity_type, source_entity_id, idempotency_key, user_id)
           VALUES ($1, $2, 'reversal', $3, $4, 'sale', $5, $6, $7)`,
          [randomUUID(), item.variant_id, item.quantity, balanceAfter, params.data.id, `sales.reversal:${params.data.id}:${item.variant_id}`, session.user_id],
        )
      }

      await client.query("UPDATE sales SET status = 'reversed', updated_at = now() WHERE id = $1", [params.data.id])
      await client.query(
        `INSERT INTO audit_log (id, user_id, action, entity_type, entity_id, request_id, after_data)
         VALUES ($1, $2, 'sale.reverse', 'sale', $3, $4, $5)`,
        [randomUUID(), session.user_id, params.data.id, request.id, JSON.stringify({
          reason: parsed.data.reason ?? null, paymentsReversed: paymentsResult.rowCount ?? 0, previousStatus: sale.status,
        })],
      )
      await client.query('COMMIT')
      return reply.send({ id: params.data.id, status: 'reversed', paymentsReversed: paymentsResult.rowCount ?? 0 })
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  })

  app.get('/sales', async (request, reply) => {
    if (!await requirePermission(pool, request, reply, 'sales:read')) return
    const parsed = salesListSchema.safeParse(request.query)
    if (!parsed.success) return sendError(reply, request, 400, 'VALIDATION_ERROR', 'Filtros de venda inválidos.')

    const offset = (parsed.data.page - 1) * parsed.data.limit
    const result = await pool.query<{
      id: string
      customerId: string | null
      customerName: string
      productSummary: string | null
      productPreviews: Array<{ productId: string; label: string; mediaId: string | null }>
      status: string
      finalAmount: string
      amountDue: string
      createdAt: string
      total: string
    }>(
       `SELECT s.id, s.customer_id AS "customerId", s.status,
               coalesce((SELECT c.name FROM customers c WHERE c.id = s.customer_id), 'Consumidor Final') AS "customerName",
               (SELECT string_agg(x.label, ' · ' ORDER BY x.label) FROM (
                 SELECT p.club || ' ' || p.model || ' ×' || sum(si.quantity)::text AS label
                 FROM sale_items si JOIN product_variants v ON v.id = si.variant_id JOIN products p ON p.id = v.product_id
                 WHERE si.sale_id = s.id GROUP BY p.id, p.club, p.model
               ) x) AS "productSummary",
               coalesce((SELECT jsonb_agg(jsonb_build_object(
                 'productId', x.id, 'label', x.label,
                 'mediaId', (SELECT m.id FROM media m WHERE m.product_id = x.id AND m.active
                             ORDER BY m.created_at DESC, m.id DESC LIMIT 1)
               ) ORDER BY x.label, x.id) FROM (
                 SELECT DISTINCT p.id, p.club || ' ' || p.model AS label
                 FROM sale_items si JOIN product_variants v ON v.id = si.variant_id JOIN products p ON p.id = v.product_id
                 WHERE si.sale_id = s.id ORDER BY label, p.id LIMIT 3
               ) x), '[]'::jsonb) AS "productPreviews",
               s.final_amount::text AS "finalAmount",
               (s.final_amount - coalesce((SELECT sum(p.amount) FROM payments p WHERE p.sale_id = s.id AND p.status = 'confirmed'), 0))::text AS "amountDue",
               s.created_at::text AS "createdAt", count(*) OVER()::text AS total
        FROM sales s
        WHERE ($1::text IS NULL OR s.status = $1 OR ($1 = 'open' AND s.status IN ('pending', 'partially_paid')))
        ORDER BY s.created_at DESC, s.id DESC
        LIMIT $2 OFFSET $3`,
      [parsed.data.status ?? null, parsed.data.limit, offset],
    )
    const total = Number(result.rows[0]?.total ?? 0)
    return reply.send({
      items: result.rows.map((sale) => ({
        id: sale.id,
        customerId: sale.customerId,
        customerName: sale.customerName,
        productSummary: sale.productSummary,
        productPreviews: sale.productPreviews,
        status: sale.status,
        finalAmount: sale.finalAmount,
        amountDue: sale.amountDue,
        createdAt: sale.createdAt,
      })),
      total,
      page: parsed.data.page,
      limit: parsed.data.limit,
    })
  })

  app.get('/sales/:id', async (request, reply) => {
    const session = await requirePermission(pool, request, reply, 'sales:read')
    if (!session) return
    const parsed = idSchema.safeParse(request.params)
    if (!parsed.success) return sendError(reply, request, 400, 'VALIDATION_ERROR', 'Venda inválida.')

    const saleResult = await pool.query<{
      id: string
      customerId: string | null
      status: string
      subtotalAmount: string
      discountAmount: string
      finalAmount: string
      createdAt: string
    }>(
      `SELECT id, customer_id AS "customerId", status, subtotal_amount::text AS "subtotalAmount",
              discount_amount::text AS "discountAmount", final_amount::text AS "finalAmount",
              created_at::text AS "createdAt"
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
      `SELECT variant_id AS "variantId", p.club, p.model, v.type, v.size,
              quantity, unit_price::text AS "unitPrice", unit_cost::text AS "unitCost"
       FROM sale_items si JOIN product_variants v ON v.id = si.variant_id JOIN products p ON p.id = v.product_id
       WHERE sale_id = $1 ORDER BY si.created_at, si.id`,
      [sale.id],
    )
    const payments = await pool.query<{ id: string; amount: string; method: string; status: string; receivedAt: string }>(
      `SELECT id, amount::text AS amount, method, status, received_at::text AS "receivedAt"
       FROM payments WHERE sale_id = $1 ORDER BY received_at, id`,
      [sale.id],
    )
    const exchanges = await pool.query<{
      id: string
      reason: string
      createdAt: string
      items: Array<{ variantId: string; direction: string; quantity: number; unitPrice: string; unitCost?: string }>
    }>(
      `SELECT e.id, e.reason, e.created_at::text AS "createdAt",
              jsonb_agg(jsonb_build_object(
                'variantId', ei.variant_id, 'club', p.club, 'model', p.model, 'type', v.type, 'size', v.size,
                'direction', ei.direction, 'quantity', ei.quantity,
                'unitPrice', ei.unit_price::text, 'unitCost', ei.unit_cost::text
              ) ORDER BY ei.created_at, ei.id) AS items
       FROM exchanges e JOIN exchange_items ei ON ei.exchange_id = e.id
       JOIN product_variants v ON v.id = ei.variant_id JOIN products p ON p.id = v.product_id
       WHERE e.sale_id = $1 GROUP BY e.id ORDER BY e.created_at, e.id`,
      [sale.id],
    )
    const paidCents = payments.rows.filter(({ status }) => status === 'confirmed').reduce((total, payment) => total + toCents(payment.amount), 0n)
    const includeCost = hasPermission(session.permissions, 'products:write')
    const publicItems = includeCost ? items.rows : items.rows.map((item) => stripUnitCost(item))
    const publicExchanges = includeCost ? exchanges.rows : exchanges.rows.map((exchange) => ({
      ...exchange,
      items: exchange.items.map((item) => stripUnitCost(item)),
    }))
    type TimelineEntry = { kind: string; id: string; at: string; status?: string; amount?: string; receivedAt?: string }
    const timeline: TimelineEntry[] = [
      { kind: 'sale.created', id: sale.id, at: sale.createdAt, status: sale.status },
      ...payments.rows
        .filter((payment) => payment.status === 'confirmed')
        .map((payment): TimelineEntry => ({
          kind: 'payment.confirmed', id: payment.id, at: payment.receivedAt,
          status: payment.status, amount: payment.amount, receivedAt: payment.receivedAt,
        })),
      ...exchanges.rows.map((exchange): TimelineEntry => ({ kind: 'exchange.created', id: exchange.id, at: exchange.createdAt })),
    ].sort((a, b) => a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : 1)
    return reply.send({
      ...sale,
      amountDue: formatCents(toCents(sale.finalAmount) - paidCents),
      items: publicItems,
      payments: payments.rows,
      exchanges: publicExchanges,
      timeline,
    })
  })
}

function stripUnitCost<T extends { unitCost?: unknown }>(row: T): Omit<T, 'unitCost'> {
  const { unitCost: _removed, ...rest } = row
  void _removed
  return rest
}

function toCents(value: string): bigint {
  const [whole = '0', fraction = '00'] = value.split('.')
  return BigInt(whole) * 100n + BigInt(fraction)
}

/** Data local do servidor em YYYY-MM-DD; o fuso do PC da loja define o dia, não o UTC. */
function localTodayIso(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

function formatCents(value: bigint): string {
  const whole = value / 100n
  const fraction = (value % 100n).toString().padStart(2, '0')
  return `${whole}.${fraction}`
}
