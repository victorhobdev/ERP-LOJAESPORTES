import { z } from 'zod'

export const moneySchema = z.string().regex(/^(0|[1-9]\d*)\.\d{2}$/)

export const saleStatusSchema = z.enum(['paid', 'pending', 'partially_paid', 'reversed'])

export const purchaseOrderStatusSchema = z.enum([
  'draft',
  'placed',
  'partially_received',
  'fully_received',
  'cancelled',
])

export const apiErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  fieldErrors: z.record(z.string(), z.array(z.string())).nullable().optional(),
  requestId: z.string().min(1),
  details: z.record(z.string(), z.unknown()).optional(),
})

export type ApiError = z.infer<typeof apiErrorSchema>
export type PurchaseOrderStatus = z.infer<typeof purchaseOrderStatusSchema>
export type SaleStatus = z.infer<typeof saleStatusSchema>
