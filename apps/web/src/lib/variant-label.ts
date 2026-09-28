export type VariantDescription = { club: string; model: string; type: string; size: string }

export function variantLabel(item: VariantDescription): string {
  return `${item.club} ${item.model} · ${item.type} ${item.size}`
}
