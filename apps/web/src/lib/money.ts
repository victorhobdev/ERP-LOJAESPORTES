const moneyPattern = /^(0|[1-9]\d*)\.\d{2}$/
export const maxMoneyCents = 99_999_999_999_999n

export function moneyToCents(value: string): bigint {
  if (!moneyPattern.test(value)) throw new RangeError(`Valor monetário inválido: ${value}`)
  const separator = value.indexOf('.')
  return BigInt(value.slice(0, separator)) * 100n + BigInt(value.slice(separator + 1))
}

export function formatCentsToMoney(cents: bigint): string {
  const negative = cents < 0n
  const absolute = negative ? -cents : cents
  const whole = absolute / 100n
  const fraction = (absolute % 100n).toString().padStart(2, '0')
  return `${negative ? '-' : ''}${whole}.${fraction}`
}

export function saleTotalCents(items: Array<{ salePrice: string; quantity: number }>): bigint {
  let total = 0n
  for (const item of items) {
    if (!Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 10_000) {
      throw new RangeError(`Quantidade inválida: ${item.quantity}`)
    }
    total += moneyToCents(item.salePrice) * BigInt(item.quantity)
  }
  if (total > maxMoneyCents) throw new RangeError('O total da venda excede o limite permitido.')
  return total
}
