import { describe, expect, it } from 'vitest'

import {
  apiErrorSchema,
  moneySchema,
  purchaseOrderStatusSchema,
  saleStatusSchema,
} from './index.js'

describe('shared API contracts', () => {
  it('accepts canonical non-negative decimal money strings', () => {
    expect(moneySchema.parse('150.00')).toBe('150.00')
    expect(moneySchema.parse('0.01')).toBe('0.01')
  })

  it.each([150, '1.2', '-1.00', '1,00', '01.00'])('rejects non-canonical money: %j', (value) => {
    expect(() => moneySchema.parse(value)).toThrow()
  })

  it('keeps operational statuses finite and explicit', () => {
    expect(saleStatusSchema.parse('pending')).toBe('pending')
    expect(purchaseOrderStatusSchema.parse('partially_received')).toBe('partially_received')
    expect(() => purchaseOrderStatusSchema.parse('unknown')).toThrow()
  })

  it('requires a safe error envelope with a request id', () => {
    expect(
      apiErrorSchema.parse({
        code: 'VALIDATION_ERROR',
        message: 'Revise os campos informados.',
        fieldErrors: { name: ['Campo obrigatório.'] },
        requestId: 'req-123',
      }),
    ).toMatchObject({ code: 'VALIDATION_ERROR', requestId: 'req-123' })
  })
})
