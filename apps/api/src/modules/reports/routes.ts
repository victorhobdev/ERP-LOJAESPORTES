import type { FastifyInstance } from 'fastify'
import type { Pool } from 'pg'
import { z } from 'zod'

import { requirePermission, sendError } from '../../shared/auth/http.js'

export const maxReportDays = 366
export const minCivilDate = '0001-01-01'
export const maxCivilDate = '9999-12-31'

const financialQuerySchema = z.object({
  from: z.iso.date(),
  to: z.iso.date(),
  compare: z.enum(['true', 'false']).optional(),
}).refine(({ from, to }) => from <= to && isSupportedRange(from, to))
const productQuerySchema = z.object({
  from: z.iso.date(),
  to: z.iso.date(),
  club: z.string().max(120).optional(),
  type: z.string().max(60).optional(),
  size: z.string().max(20).optional(),
}).refine(({ from, to }) => from <= to)
const dashboardSchema = z.object({ date: z.iso.date() })
const timezone = 'America/Sao_Paulo'

function parseCivilDate(value: string): Date {
  return new Date(`${value}T00:00:00Z`)
}

function formatCivilDate(value: Date): string {
  return value.toISOString().slice(0, 10)
}

function inclusiveDays(from: string, to: string): number {
  return Math.round((parseCivilDate(to).getTime() - parseCivilDate(from).getTime()) / 86_400_000) + 1
}

function previousPeriod(from: string, to: string): { from: string; to: string } {
  const fromDate = parseCivilDate(from)
  const days = inclusiveDays(from, to)
  const prevTo = new Date(fromDate.getTime() - 86_400_000)
  const prevFrom = new Date(prevTo.getTime() - (days - 1) * 86_400_000)
  return { from: formatCivilDate(prevFrom), to: formatCivilDate(prevTo) }
}

export function isSupportedRange(from: string, to: string): boolean {
  if (from < minCivilDate || to > maxCivilDate || from > to) return false
  const days = inclusiveDays(from, to)
  if (!Number.isInteger(days) || days < 1 || days > maxReportDays) return false
  return previousPeriod(from, to).from >= minCivilDate
}

type PeriodMetrics = {
  salesAmount: string
  saleCount: string
  outstanding: string
  receipts: string
  cost: string
  methods: Array<{ method: string; amount: string }>
}

type ProductReportRow = {
  variantId: string
  club: string
  model: string
  type: string
  size: string
  sku: string
  currentStockQuantity: number
  lowStockThreshold: number
  unitsSold: string
  salesAmount: string
  historicalCost: string
  grossProfit: string
  noTurnover: boolean
  lowStock: boolean
}

type ProductRankingEntry = { units: bigint; sales: bigint }
type ProductRanking = { name: string; unitsSold: string; salesAmount: string; sharePercent: string }

function normalizeFilter(value: string | undefined): string | null {
  if (value === undefined) return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

function summarizeProducts(items: ProductReportRow[]): Record<string, unknown> {
  let totalUnits = 0n
  let totalSales = 0n
  let totalProfit = 0n
  let noTurnoverCount = 0
  let lowStockCount = 0
  const byClub = new Map<string, ProductRankingEntry>()
  const byType = new Map<string, ProductRankingEntry>()
  const bySize = new Map<string, ProductRankingEntry>()
  const accumulate = (entries: Map<string, ProductRankingEntry>, name: string, units: bigint, sales: bigint): void => {
    const current = entries.get(name) ?? { units: 0n, sales: 0n }
    entries.set(name, { units: current.units + units, sales: current.sales + sales })
  }
  for (const item of items) {
    const units = BigInt(item.unitsSold)
    const sales = toCents(item.salesAmount)
    totalUnits += units
    totalSales += sales
    totalProfit += toCents(item.grossProfit)
    if (item.noTurnover) noTurnoverCount += 1
    if (item.lowStock) lowStockCount += 1
    accumulate(byClub, item.club, units, sales)
    accumulate(byType, item.type, units, sales)
    accumulate(bySize, item.size, units, sales)
  }
  const rankOf = (entries: Map<string, ProductRankingEntry>): ProductRanking[] =>
    [...entries.entries()]
      .sort((a, b) => {
        if (b[1].units !== a[1].units) return b[1].units > a[1].units ? 1 : -1
        if (b[1].sales !== a[1].sales) return b[1].sales > a[1].sales ? 1 : -1
        return a[0] < b[0] ? -1 : 1
      })
      .map(([name, totals]) => ({
        name,
        unitsSold: totals.units.toString(),
        salesAmount: formatCents(totals.sales),
        sharePercent: totalSales === 0n ? '0.00' : formatHundredths(divideRounded(totals.sales * 10_000n, totalSales)),
      }))
  return {
    variantCount: items.length,
    totalUnitsSold: totalUnits.toString(),
    totalSalesAmount: formatCents(totalSales),
    totalGrossProfit: formatCents(totalProfit),
    noTurnoverCount,
    lowStockCount,
    salesByClub: rankOf(byClub),
    salesByType: rankOf(byType),
    salesBySize: rankOf(bySize),
  }
}

async function queryPeriodMetrics(db: Pick<Pool, 'query'>, from: string, to: string): Promise<PeriodMetrics> {
  const values = [from, to]
  const sales = await db.query<{ amount: string; count: string; outstanding: string }>(
    `SELECT round(coalesce(sum(s.final_amount), 0), 2)::text AS amount,
            count(*)::text AS count,
            round(coalesce(sum(s.final_amount - coalesce((
              SELECT sum(p.amount) FROM payments p WHERE p.sale_id = s.id AND p.status = 'confirmed'
            ), 0)), 0), 2)::text AS outstanding
     FROM sales s
     WHERE s.status <> 'reversed'
       AND (s.created_at AT TIME ZONE '${timezone}')::date BETWEEN $1 AND $2`,
    values,
  )
  const payments = await db.query<{ amount: string }>(
    `SELECT round(coalesce(sum(amount), 0), 2)::text AS amount
     FROM payments WHERE status = 'confirmed'
       AND (received_at AT TIME ZONE '${timezone}')::date BETWEEN $1 AND $2`,
    values,
  )
  const costs = await db.query<{ amount: string }>(
    `SELECT round(coalesce(sum(si.quantity * si.unit_cost), 0), 2)::text AS amount
     FROM sale_items si JOIN sales s ON s.id = si.sale_id
     WHERE s.status <> 'reversed'
       AND (s.created_at AT TIME ZONE '${timezone}')::date BETWEEN $1 AND $2`,
    values,
  )
  const methods = await db.query<{ method: string; amount: string }>(
    `SELECT method, round(sum(amount), 2)::text AS amount
     FROM payments WHERE status = 'confirmed'
       AND (received_at AT TIME ZONE '${timezone}')::date BETWEEN $1 AND $2
     GROUP BY method ORDER BY method`,
    values,
  )
  return {
    salesAmount: sales.rows[0]!.amount,
    saleCount: sales.rows[0]!.count,
    outstanding: sales.rows[0]!.outstanding,
    receipts: payments.rows[0]!.amount,
    cost: costs.rows[0]!.amount,
    methods: methods.rows,
  }
}

function summarize(metrics: PeriodMetrics): Record<string, unknown> {
  const salesAmount = toCents(metrics.salesAmount)
  const costAmount = toCents(metrics.cost)
  const grossProfit = salesAmount - costAmount
  const saleCount = BigInt(metrics.saleCount)
  return {
    salesBySaleDate: formatCents(salesAmount),
    confirmedPaymentsByReceiptDate: metrics.receipts,
    outstandingForPeriodSales: metrics.outstanding,
    historicalCostOfPeriodSales: formatCents(costAmount),
    grossProfitOnSalesBasis: formatCents(grossProfit),
    grossMarginPercentOnSalesBasis: salesAmount === 0n ? '0.00' : formatHundredths(divideRounded(grossProfit * 10_000n, salesAmount)),
    averageTicketOnSalesBasis: saleCount === 0n ? '0.00' : formatCents(divideRounded(salesAmount, saleCount)),
    paymentsByMethod: metrics.methods,
  }
}

export function registerReportRoutes(app: FastifyInstance, pool: Pool) {
  app.get('/reports/financial', async (request, reply) => {
    if (!await requirePermission(pool, request, reply, 'reports:read')) return
    const parsed = financialQuerySchema.safeParse(request.query)
    if (!parsed.success) return sendError(reply, request, 400, 'VALIDATION_ERROR', 'Período inválido.')
    const { from, to, compare } = parsed.data
    const values = [from, to]

    const client = await pool.connect()
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
      const metrics = await queryPeriodMetrics(client, from, to)
      const inventory = await client.query<{ cost: string; potential: string }>(
        `SELECT round(coalesce(sum(stock_quantity * current_cost), 0), 2)::text AS cost,
                round(coalesce(sum(stock_quantity * sale_price), 0), 2)::text AS potential
         FROM product_variants v JOIN products p ON p.id = v.product_id WHERE p.active = true`,
      )
      const purchases = await client.query<{ amount: string }>(
        `SELECT round(coalesce(sum((poi.ordered_quantity - poi.received_quantity) * poi.final_unit_cost), 0), 2)::text AS amount
         FROM purchase_order_items poi JOIN purchase_orders po ON po.id = poi.purchase_order_id
         WHERE po.status IN ('placed', 'partially_received')`,
      )
      const series = await client.query<{ date: string; salesBySaleDate: string; confirmedPaymentsByReceiptDate: string }>(
        `SELECT d::date::text AS date,
                coalesce(s.amount, '0.00') AS "salesBySaleDate",
                coalesce(p.amount, '0.00') AS "confirmedPaymentsByReceiptDate"
         FROM generate_series($1::date, $2::date, '1 day') AS d
         LEFT JOIN (
           SELECT (created_at AT TIME ZONE '${timezone}')::date AS day,
                  round(sum(final_amount), 2)::text AS amount
           FROM sales WHERE status <> 'reversed'
             AND (created_at AT TIME ZONE '${timezone}')::date BETWEEN $1 AND $2
           GROUP BY 1
         ) s ON s.day = d::date
         LEFT JOIN (
           SELECT (received_at AT TIME ZONE '${timezone}')::date AS day,
                  round(sum(amount), 2)::text AS amount
           FROM payments WHERE status = 'confirmed'
             AND (received_at AT TIME ZONE '${timezone}')::date BETWEEN $1 AND $2
           GROUP BY 1
         ) p ON p.day = d::date
         ORDER BY d`,
        values,
      )
      const receivablesRows = await client.query<{ saleId: string; customerDisplay: string; dueDate: string | null; amountDue: string; overdue: boolean }>(
        `SELECT s.id AS "saleId",
                coalesce(c.name, 'Consumidor Final') AS "customerDisplay",
                s.payment_due_date::text AS "dueDate",
                round(s.final_amount - coalesce((
                  SELECT sum(p.amount) FROM payments p WHERE p.sale_id = s.id AND p.status = 'confirmed'
                ), 0), 2)::text AS "amountDue",
                (s.payment_due_date < (now() AT TIME ZONE '${timezone}')::date) AS overdue
         FROM sales s LEFT JOIN customers c ON c.id = s.customer_id
         WHERE s.status IN ('pending', 'partially_paid')
           AND (s.created_at AT TIME ZONE '${timezone}')::date BETWEEN $1 AND $2
         ORDER BY s.payment_due_date, s.id`,
        values,
      )
      const asOf = await client.query<{ today: string }>(
        `SELECT ((now() AT TIME ZONE '${timezone}')::date)::text AS today`,
      )

      const summary = summarize(metrics)
      const body: Record<string, unknown> = {
        period: { from, to, timezone },
        bases: { sales: 'sale_created_at', cash: 'payment_received_at' },
        ...summary,
        inventoryCostValue: inventory.rows[0]!.cost,
        inventoryPotentialValue: inventory.rows[0]!.potential,
        openPurchaseCapital: purchases.rows[0]!.amount,
        dailySeries: series.rows,
        receivables: receivablesRows.rows,
        receivablesBasis: 'sales_created_in_period_with_open_balance',
        overdueAsOf: asOf.rows[0]!.today,
        updatedAt: new Date().toISOString(),
      }
      if (compare === 'true') {
        const prev = previousPeriod(from, to)
        const prevMetrics = await queryPeriodMetrics(client, prev.from, prev.to)
        body.comparison = { period: { ...prev, timezone }, ...summarize(prevMetrics) }
      }
      await client.query('COMMIT')
      return reply.send(body)
    } catch (error) {
      try {
        await client.query('ROLLBACK')
      } catch {
        // Preserve the original failure when rollback itself cannot run.
      }
      throw error
    } finally {
      client.release()
    }
  })

  app.get('/reports/products', async (request, reply) => {
    if (!await requirePermission(pool, request, reply, 'reports:read')) return
    const parsed = productQuerySchema.safeParse(request.query)
    if (!parsed.success || !isSupportedRange(parsed.data.from, parsed.data.to)) {
      return sendError(reply, request, 400, 'VALIDATION_ERROR', 'Período inválido.')
    }
    const { from, to } = parsed.data
    const filters = {
      club: normalizeFilter(parsed.data.club),
      type: normalizeFilter(parsed.data.type),
      size: normalizeFilter(parsed.data.size),
    }
    const conditions: string[] = ['p.active = true']
    const values: string[] = [from, to]
    if (filters.club !== null) {
      values.push(filters.club)
      conditions.push(`p.club ILIKE '%' || $${values.length} || '%'`)
    }
    if (filters.type !== null) {
      values.push(filters.type)
      conditions.push(`v.type = $${values.length}`)
    }
    if (filters.size !== null) {
      values.push(filters.size)
      conditions.push(`v.size = $${values.length}`)
    }

    const result = await pool.query<ProductReportRow>(
      `WITH period_sales AS (
         SELECT si.variant_id,
                sum(si.quantity) AS units_num,
                sum(si.quantity)::text AS units,
                sum(si.quantity * si.unit_price) AS amount_num,
                round(sum(si.quantity * si.unit_price), 2)::text AS amount,
                round(sum(si.quantity * si.unit_cost), 2)::text AS cost,
                round(sum(si.quantity * (si.unit_price - si.unit_cost)), 2)::text AS profit
         FROM sale_items si
         JOIN sales s ON s.id = si.sale_id
         WHERE s.status <> 'reversed'
           AND (s.created_at AT TIME ZONE '${timezone}')::date BETWEEN $1 AND $2
         GROUP BY si.variant_id
       )
       SELECT v.id AS "variantId", p.club, p.model, v.type, v.size, v.sku,
              v.stock_quantity AS "currentStockQuantity",
              v.low_stock_threshold AS "lowStockThreshold",
              coalesce(ps.units, '0') AS "unitsSold",
              coalesce(ps.amount, '0.00') AS "salesAmount",
              coalesce(ps.cost, '0.00') AS "historicalCost",
              coalesce(ps.profit, '0.00') AS "grossProfit",
              (ps.units IS NULL) AS "noTurnover",
              (v.stock_quantity > 0 AND v.stock_quantity <= v.low_stock_threshold) AS "lowStock"
       FROM product_variants v
       JOIN products p ON p.id = v.product_id
       LEFT JOIN period_sales ps ON ps.variant_id = v.id
       WHERE ${conditions.join(' AND ')}
       ORDER BY coalesce(ps.units_num, 0) DESC, ps.amount_num DESC NULLS LAST, v.id`,
      values,
    )
    const clock = await pool.query<{ now: string }>('SELECT now()::text AS now')
    const instant = new Date(clock.rows[0]!.now).toISOString()
    return reply.send({
      period: { from, to, timezone },
      filters,
      timezone,
      bases: { sales: 'sale_created_at', stock: 'current_state_as_of_request' },
      items: result.rows,
      summary: summarizeProducts(result.rows),
      updatedAt: instant,
      stockAsOf: instant,
    })
  })

  app.get('/dashboard', async (request, reply) => {
    if (!await requirePermission(pool, request, reply, 'reports:read')) return
    const parsed = dashboardSchema.safeParse(request.query)
    if (!parsed.success) return sendError(reply, request, 400, 'VALIDATION_ERROR', 'Data inválida.')
    const date = parsed.data.date

    const [events, receivables, inventory, purchases, customerOrders] = await Promise.all([
      pool.query<{ sales: string; cash: string }>(
        `SELECT
           round(coalesce((SELECT sum(final_amount) FROM sales
             WHERE status <> 'reversed' AND (created_at AT TIME ZONE '${timezone}')::date = $1), 0), 2)::text AS sales,
           round(coalesce((SELECT sum(amount) FROM payments
             WHERE status = 'confirmed' AND (received_at AT TIME ZONE '${timezone}')::date = $1), 0), 2)::text AS cash`,
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
  const negative = value.startsWith('-')
  const abs = negative ? value.slice(1) : value
  const [whole = '0', fraction = '00'] = abs.split('.')
  const cents = BigInt(whole) * 100n + BigInt((`${fraction}00`).slice(0, 2))
  return negative ? -cents : cents
}

function formatCents(value: bigint): string {
  const sign = value < 0n ? '-' : ''
  const abs = value < 0n ? -value : value
  return `${sign}${abs / 100n}.${(abs % 100n).toString().padStart(2, '0')}`
}

function formatHundredths(value: bigint): string {
  return formatCents(value)
}

function divideRounded(numerator: bigint, denominator: bigint): bigint {
  const quotient = numerator / denominator
  const remainder = numerator % denominator
  if (remainder === 0n) return quotient
  const absRemainder = remainder < 0n ? -remainder : remainder
  const absDenominator = denominator < 0n ? -denominator : denominator
  if (absRemainder * 2n < absDenominator) return quotient
  return quotient + (numerator < 0n !== denominator < 0n ? -1n : 1n)
}
