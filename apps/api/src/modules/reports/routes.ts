import type { FastifyInstance } from 'fastify'
import type { Pool } from 'pg'
import { z } from 'zod'

import { requirePermission, sendError } from '../../shared/auth/http.js'

const periodSchema = z.object({ from: z.iso.date(), to: z.iso.date() }).refine(({ from, to }) => from <= to)
const dashboardSchema = z.object({ date: z.iso.date() })
const timezone = 'America/Sao_Paulo'

export function registerReportRoutes(app: FastifyInstance, pool: Pool) {
  app.get('/reports/financial', async (request, reply) => {
    if (!await requirePermission(pool, request, reply, 'reports:read')) return
    const parsed = periodSchema.safeParse(request.query)
    if (!parsed.success) return sendError(reply, request, 400, 'VALIDATION_ERROR', 'Período inválido.')
    const values = [parsed.data.from, parsed.data.to]

    const [sales, payments, costs, inventory, purchases, methods] = await Promise.all([
      pool.query<{ amount: string; count: string; outstanding: string }>(
        `SELECT coalesce(sum(s.final_amount), 0)::numeric(14,2)::text AS amount,
                count(*)::text AS count,
                coalesce(sum(s.final_amount - coalesce((
                  SELECT sum(p.amount) FROM payments p WHERE p.sale_id = s.id AND p.status = 'confirmed'
                ), 0)), 0)::numeric(14,2)::text AS outstanding
         FROM sales s
         WHERE s.status <> 'reversed'
           AND (s.created_at AT TIME ZONE '${timezone}')::date BETWEEN $1 AND $2`,
        values,
      ),
      pool.query<{ amount: string }>(
        `SELECT coalesce(sum(amount), 0)::numeric(14,2)::text AS amount
         FROM payments WHERE status = 'confirmed'
           AND (received_at AT TIME ZONE '${timezone}')::date BETWEEN $1 AND $2`,
        values,
      ),
      pool.query<{ amount: string }>(
        `SELECT coalesce(sum(si.quantity * si.unit_cost), 0)::numeric(14,2)::text AS amount
         FROM sale_items si JOIN sales s ON s.id = si.sale_id
         WHERE s.status <> 'reversed'
           AND (s.created_at AT TIME ZONE '${timezone}')::date BETWEEN $1 AND $2`,
        values,
      ),
      pool.query<{ cost: string; potential: string }>(
        `SELECT coalesce(sum(stock_quantity * current_cost), 0)::numeric(14,2)::text AS cost,
                coalesce(sum(stock_quantity * sale_price), 0)::numeric(14,2)::text AS potential
         FROM product_variants v JOIN products p ON p.id = v.product_id WHERE p.active = true`,
      ),
      pool.query<{ amount: string }>(
        `SELECT coalesce(sum((poi.ordered_quantity - poi.received_quantity) * poi.final_unit_cost), 0)::numeric(14,2)::text AS amount
         FROM purchase_order_items poi JOIN purchase_orders po ON po.id = poi.purchase_order_id
         WHERE po.status IN ('placed', 'partially_received')`,
      ),
      pool.query<{ method: string; amount: string }>(
        `SELECT method, sum(amount)::numeric(14,2)::text AS amount
         FROM payments WHERE status = 'confirmed'
           AND (received_at AT TIME ZONE '${timezone}')::date BETWEEN $1 AND $2
         GROUP BY method ORDER BY method`,
        values,
      ),
    ])

    const salesAmount = toCents(sales.rows[0]!.amount)
    const costAmount = toCents(costs.rows[0]!.amount)
    const grossProfit = salesAmount - costAmount
    const saleCount = BigInt(sales.rows[0]!.count)
    return reply.send({
      period: { ...parsed.data, timezone },
      bases: { sales: 'sale_created_at', cash: 'payment_received_at' },
      salesBySaleDate: formatCents(salesAmount),
      confirmedPaymentsByReceiptDate: payments.rows[0]!.amount,
      outstandingForPeriodSales: sales.rows[0]!.outstanding,
      historicalCostOfPeriodSales: formatCents(costAmount),
      grossProfitOnSalesBasis: formatCents(grossProfit),
      grossMarginPercentOnSalesBasis: salesAmount === 0n ? '0.00' : formatHundredths(divideRounded(grossProfit * 10_000n, salesAmount)),
      averageTicketOnSalesBasis: saleCount === 0n ? '0.00' : formatCents(divideRounded(salesAmount, saleCount)),
      inventoryCostValue: inventory.rows[0]!.cost,
      inventoryPotentialValue: inventory.rows[0]!.potential,
      openPurchaseCapital: purchases.rows[0]!.amount,
      paymentsByMethod: methods.rows,
      updatedAt: new Date().toISOString(),
    })
  })

  app.get('/reports/products', async (request, reply) => {
    if (!await requirePermission(pool, request, reply, 'reports:read')) return
    const parsed = periodSchema.safeParse(request.query)
    if (!parsed.success) return sendError(reply, request, 400, 'VALIDATION_ERROR', 'Período inválido.')

    const result = await pool.query(
      `SELECT v.id AS "variantId", p.club, p.model, v.type, v.size, v.sku,
              v.stock_quantity AS "currentStockQuantity",
              sum(si.quantity)::integer AS "unitsSold",
              sum(si.quantity * si.unit_price)::numeric(14,2)::text AS "salesAmount",
              sum(si.quantity * si.unit_cost)::numeric(14,2)::text AS "historicalCost",
              sum(si.quantity * (si.unit_price - si.unit_cost))::numeric(14,2)::text AS "grossProfit"
       FROM sale_items si
       JOIN sales s ON s.id = si.sale_id
       JOIN product_variants v ON v.id = si.variant_id
       JOIN products p ON p.id = v.product_id
       WHERE s.status <> 'reversed'
         AND (s.created_at AT TIME ZONE '${timezone}')::date BETWEEN $1 AND $2
       GROUP BY v.id, p.id
       ORDER BY "unitsSold" DESC, "salesAmount" DESC, v.id`,
      [parsed.data.from, parsed.data.to],
    )
    return reply.send({ period: { ...parsed.data, timezone }, items: result.rows })
  })

  app.get('/dashboard', async (request, reply) => {
    if (!await requirePermission(pool, request, reply, 'reports:read')) return
    const parsed = dashboardSchema.safeParse(request.query)
    if (!parsed.success) return sendError(reply, request, 400, 'VALIDATION_ERROR', 'Data inválida.')
    const date = parsed.data.date

    const [events, receivables, inventory, purchases, customerOrders] = await Promise.all([
      pool.query<{ sales: string; cash: string }>(
        `SELECT
           coalesce((SELECT sum(final_amount) FROM sales
             WHERE status <> 'reversed' AND (created_at AT TIME ZONE '${timezone}')::date = $1), 0)::numeric(14,2)::text AS sales,
           coalesce((SELECT sum(amount) FROM payments
             WHERE status = 'confirmed' AND (received_at AT TIME ZONE '${timezone}')::date = $1), 0)::numeric(14,2)::text AS cash`,
        [date],
      ),
      pool.query<{ pending: number; overdue: number }>(
        `SELECT count(*) FILTER (WHERE status IN ('pending', 'partially_paid'))::integer AS pending,
                count(*) FILTER (WHERE status IN ('pending', 'partially_paid') AND payment_due_date < $1)::integer AS overdue
         FROM sales`,
        [date],
      ),
      pool.query<{ low: number; empty: number }>(
        `SELECT count(*) FILTER (WHERE v.stock_quantity > 0 AND v.stock_quantity <= v.low_stock_threshold)::integer AS low,
                count(*) FILTER (WHERE v.stock_quantity = 0)::integer AS empty
         FROM product_variants v JOIN products p ON p.id = v.product_id WHERE p.active = true`,
      ),
      pool.query<{ orders: number; units: number }>(
        `SELECT count(DISTINCT po.id)::integer AS orders,
                coalesce(sum(poi.ordered_quantity - poi.received_quantity), 0)::integer AS units
         FROM purchase_orders po JOIN purchase_order_items poi ON poi.purchase_order_id = po.id
         WHERE po.status IN ('placed', 'partially_received')`,
      ),
      pool.query<{ orders: number }>(
        `SELECT count(*)::integer AS orders FROM customer_orders
         WHERE status IN ('pending', 'supplier_ordered', 'product_arrived')`,
      ),
    ])

    return reply.send({
      date,
      timezone,
      bases: { sales: 'sale_created_at', cash: 'payment_received_at', pending: 'current_state_as_of_request' },
      salesCreatedToday: events.rows[0]!.sales,
      confirmedPaymentsToday: events.rows[0]!.cash,
      pendingSalesCount: receivables.rows[0]!.pending,
      overdueSalesCount: receivables.rows[0]!.overdue,
      lowStockVariants: inventory.rows[0]!.low,
      outOfStockVariants: inventory.rows[0]!.empty,
      openPurchaseOrders: purchases.rows[0]!.orders,
      pendingPurchaseUnits: purchases.rows[0]!.units,
      openCustomerOrders: customerOrders.rows[0]!.orders,
    })
  })
}

function toCents(value: string): bigint {
  const [whole = '0', fraction = '00'] = value.split('.')
  return BigInt(whole) * 100n + BigInt(fraction)
}

function formatCents(value: bigint): string {
  return `${value / 100n}.${(value % 100n).toString().padStart(2, '0')}`
}

function formatHundredths(value: bigint): string {
  return formatCents(value)
}

function divideRounded(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator / 2n) / denominator
}
