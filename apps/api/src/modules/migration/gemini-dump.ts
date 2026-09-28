import { z } from 'zod'

import { legacyTimestamp, type MysqlDumpTable } from './mysql-dump.js'

/**
 * Normaliza as tabelas do dump `gemini_teste` para os contratos dos módulos de
 * migração. O legado modela cada variante como uma linha de `produtos` (clube +
 * modelo + tipo + tamanho) — igual ao contrato de `legacy-products`.
 */
const money = z.string().regex(/^(0|[1-9]\d*)\.\d{2}$/)

export type NormalizedProduct = {
  legacyId: number
  club: string
  model: string
  type: 'Masculina' | 'Feminina' | 'Infantil'
  size: string
  description: string | null
  salePrice: string
  stockQuantity: number
  currentCost: string
  imagePath: string | null
}

export type NormalizedCustomer = { legacyId: number; name: string; contact: string | null }

export type NormalizedSale = {
  legacyId: number
  soldOn: string
  customer: { legacyId: number; name: string; contact: string | null } | null
  itemsTotal: string
  discount: string
  finalAmount: string
  paymentStatus: 'Pago' | 'Pendente'
  promisedDueDate: string | null
  paidAmount: string
  paymentMethod: string | null
  items: Array<{ legacyProductId: number; quantity: number; unitPrice: string; unitCost: string }>
}

export type NormalizedPurchase = {
  legacyId: number
  orderedOn: string
  supplierName: string | null
  estimatedItemsAmount: string
  importFee: string
  finalAmount: string
  status: 'Realizado' | 'Recebido Parcialmente' | 'Recebido Integralmente'
  items: Array<{
    legacyId: number
    legacyProductId: number
    orderedQuantity: number
    supplierUnitCost: string
    finalUnitCost: string
    receivedQuantity: number
    receivedOn: string | null
  }>
}

export type NormalizedCustomerOrder = {
  legacyId: number
  customerLegacyId: number
  orderedOn: string
  club: string
  model: string
  type: 'Masculina' | 'Feminina' | 'Infantil'
  size: string
  notes: string | null
  status: 'Pendente' | 'PedidoAoFornecedorFeito' | 'ProdutoChegou' | 'EntregueAoCliente' | 'Cancelada'
  legacyProductId: number | null
}

export type NormalizedGeminiDump = {
  products: NormalizedProduct[]
  customers: NormalizedCustomer[]
  sales: NormalizedSale[]
  purchases: NormalizedPurchase[]
  customerOrders: NormalizedCustomerOrder[]
  productRejections: Array<{ legacyId: string | null; reasonCode: string; reason: string; raw: unknown }>
}

const productRow = z.object({
  ProdutoID: z.number().int().positive(),
  Modelo: z.string().trim().min(1).max(150),
  Clube: z.string().trim().min(1).max(150),
  Tipo: z.enum(['Masculina', 'Feminina', 'Infantil']),
  Tamanho: z.string().trim().min(1).max(20),
  DescricaoCompleta: z.string().trim().max(500).nullish(),
  PrecoVendaAtual: z.number(),
  QuantidadeEstoque: z.number().int().min(0),
  CustoMedioPonderado: z.number(),
  CaminhoImagem: z.string().trim().max(500).nullish(),
})

const customerRow = z.object({
  ClienteID: z.number().int().positive(),
  NomeCliente: z.string().trim().min(1).max(255),
  ContatoCliente: z.string().trim().max(255).nullish(),
})

const saleRow = z.object({
  VendaID: z.number().int().positive(),
  ClienteID: z.number().int().positive().nullish(),
  DataVenda: z.string(),
  ValorTotalItens: z.number(),
  ValorDesconto: z.number(),
  ValorFinalVenda: z.number(),
  StatusPagamento: z.enum(['Pago', 'Pendente']),
  DataPrometidaPagamento: z.string().nullish(),
  MetodoPagamento: z.string().nullish(),
  ValorPago: z.number(),
})

const saleItemRow = z.object({
  ItemVendaID: z.number().int().positive(),
  VendaID: z.number().int().positive(),
  ProdutoID: z.number().int().positive(),
  Quantidade: z.number().int().positive(),
  PrecoVendaUnitarioRegistrado: z.number(),
  CustoMedioUnitarioRegistrado: z.number(),
})

const purchaseRow = z.object({
  PedidoFornecedorID: z.number().int().positive(),
  DataPedido: z.string(),
  NomeFornecedor: z.string().trim().max(255).nullish(),
  CustoTotalEstimadoItens: z.number(),
  TaxaImportacaoTotal: z.number(),
  CustoTotalFinalPedido: z.number(),
  StatusPedido: z.enum(['Realizado', 'Recebido Parcialmente', 'Recebido Integralmente']),
})

const purchaseItemRow = z.object({
  ItemPedidoFornecedorID: z.number().int().positive(),
  PedidoFornecedorID: z.number().int().positive(),
  ProdutoID: z.number().int().positive(),
  QuantidadePedida: z.number().int().positive(),
  CustoUnitarioFornecedor: z.number(),
  CustoUnitarioComTaxas: z.number().nullish(),
  QuantidadeRecebida: z.number().int().min(0),
  DataRecebimento: z.string().nullish(),
})

const customerOrderRow = z.object({
  EncomendaClienteID: z.number().int().positive(),
  ClienteID: z.number().int().positive(),
  DataEncomenda: z.string(),
  Clube: z.string().trim().min(1).max(150),
  Modelo: z.string().trim().min(1).max(150),
  Tipo: z.enum(['Masculina', 'Feminina', 'Infantil']),
  Tamanho: z.string().trim().min(1).max(20),
  Observacao: z.string().nullish(),
  StatusEncomenda: z.enum(['Pendente', 'PedidoAoFornecedorFeito', 'ProdutoChegou', 'EntregueAoCliente', 'Cancelada']),
  ProdutoIDAssociado: z.number().int().positive().nullish(),
})

function moneyOf(value: number): string {
  return value.toFixed(2)
}

export function normalizeGeminiDump(tables: MysqlDumpTable[]): NormalizedGeminiDump {
  const byName = new Map(tables.map((table) => [table.name, table.rows]))
  const productRejections: NormalizedGeminiDump['productRejections'] = []

  const products: NormalizedProduct[] = []
  const customersByLegacyId = new Map<number, NormalizedCustomer>()
  const sales: NormalizedSale[] = []
  const purchases: NormalizedPurchase[] = []
  const customerOrders: NormalizedCustomerOrder[] = []

  for (const raw of byName.get('produtos') ?? []) {
    const fixed = coerceSize(raw)
    const parsed = productRow.safeParse(fixed)
    if (!parsed.success) {
      productRejections.push({
        legacyId: legacyIdOf(raw, 'ProdutoID'),
        reasonCode: 'INVALID_LEGACY_PRODUCT',
        reason: 'A linha não atende ao contrato de produto legado.',
        raw,
      })
      continue
    }
    const row = parsed.data
    products.push({
      legacyId: row.ProdutoID,
      club: row.Clube,
      model: row.Modelo,
      type: row.Tipo,
      size: row.Tamanho,
      description: row.DescricaoCompleta ?? null,
      salePrice: moneyOf(row.PrecoVendaAtual),
      stockQuantity: row.QuantidadeEstoque,
      currentCost: moneyOf(row.CustoMedioPonderado),
      imagePath: row.CaminhoImagem ?? null,
    })
  }

  for (const raw of byName.get('clientes') ?? []) {
    const parsed = customerRow.safeParse(raw)
    if (!parsed.success) continue
    customersByLegacyId.set(parsed.data.ClienteID, {
      legacyId: parsed.data.ClienteID,
      name: parsed.data.NomeCliente,
      contact: parsed.data.ContatoCliente ?? null,
    })
  }

  const itemsBySaleId = new Map<number, NormalizedSale['items']>()
  for (const raw of byName.get('itensvenda') ?? []) {
    const parsed = saleItemRow.safeParse(raw)
    if (!parsed.success) continue
    const row = parsed.data
    const list = itemsBySaleId.get(row.VendaID) ?? []
    list.push({
      legacyProductId: row.ProdutoID,
      quantity: row.Quantidade,
      unitPrice: moneyOf(row.PrecoVendaUnitarioRegistrado),
      unitCost: moneyOf(row.CustoMedioUnitarioRegistrado),
    })
    itemsBySaleId.set(row.VendaID, list)
  }

  for (const raw of byName.get('vendas') ?? []) {
    const parsed = saleRow.safeParse(raw)
    if (!parsed.success) continue
    const row = parsed.data
    const customer = row.ClienteID != null ? customersByLegacyId.get(row.ClienteID) ?? null : null
    sales.push({
      legacyId: row.VendaID,
      soldOn: legacyTimestamp(row.DataVenda) ?? new Date(0).toISOString(),
      customer: customer ? { ...customer } : null,
      itemsTotal: moneyOf(row.ValorTotalItens),
      discount: moneyOf(row.ValorDesconto),
      finalAmount: moneyOf(row.ValorFinalVenda),
      paymentStatus: row.StatusPagamento,
      promisedDueDate: legacyTimestamp(row.DataPrometidaPagamento)?.slice(0, 10) ?? null,
      paidAmount: moneyOf(row.ValorPago),
      paymentMethod: row.MetodoPagamento ?? null,
      items: itemsBySaleId.get(row.VendaID) ?? [],
    })
  }

  const purchaseItemsByOrderId = new Map<number, NormalizedPurchase['items']>()
  for (const raw of byName.get('itenspedidofornecedor') ?? []) {
    const parsed = purchaseItemRow.safeParse(raw)
    if (!parsed.success) continue
    const row = parsed.data
    const list = purchaseItemsByOrderId.get(row.PedidoFornecedorID) ?? []
    list.push({
      legacyId: row.ItemPedidoFornecedorID,
      legacyProductId: row.ProdutoID,
      orderedQuantity: row.QuantidadePedida,
      supplierUnitCost: moneyOf(row.CustoUnitarioFornecedor),
      finalUnitCost: moneyOf(row.CustoUnitarioComTaxas ?? row.CustoUnitarioFornecedor),
      receivedQuantity: row.QuantidadeRecebida,
      receivedOn: legacyTimestamp(row.DataRecebimento)?.slice(0, 10) ?? null,
    })
    purchaseItemsByOrderId.set(row.PedidoFornecedorID, list)
  }

  for (const raw of byName.get('pedidosfornecedor') ?? []) {
    const parsed = purchaseRow.safeParse(raw)
    if (!parsed.success) continue
    const row = parsed.data
    purchases.push({
      legacyId: row.PedidoFornecedorID,
      orderedOn: legacyTimestamp(row.DataPedido)!.slice(0, 10),
      supplierName: row.NomeFornecedor ?? null,
      estimatedItemsAmount: moneyOf(row.CustoTotalEstimadoItens),
      importFee: moneyOf(row.TaxaImportacaoTotal),
      finalAmount: moneyOf(row.CustoTotalFinalPedido),
      status: row.StatusPedido,
      items: purchaseItemsByOrderId.get(row.PedidoFornecedorID) ?? [],
    })
  }

  for (const raw of byName.get('encomendascliente') ?? []) {
    const parsed = customerOrderRow.safeParse(raw)
    if (!parsed.success) continue
    const row = parsed.data
    customerOrders.push({
      legacyId: row.EncomendaClienteID,
      customerLegacyId: row.ClienteID,
      orderedOn: legacyTimestamp(row.DataEncomenda)!.slice(0, 10),
      club: row.Clube,
      model: row.Modelo,
      type: row.Tipo,
      size: row.Tamanho,
      notes: row.Observacao?.trim() || null,
      status: row.StatusEncomenda,
      legacyProductId: row.ProdutoIDAssociado ?? null,
    })
  }

  return { products, customers: [...customersByLegacyId.values()], sales, purchases, customerOrders, productRejections }
}

/**
 * O legado grava campos textuais sem aspas quando o conteúdo é numérico
 * (tamanho infantil `28`, modelo `2006`); o parser entrega número e o
 * contrato exige string.
 */
function coerceSize(raw: unknown): unknown {
  if (typeof raw === 'object' && raw !== null) {
    const record = raw as Record<string, unknown>
    let changed = false
    const copy: Record<string, unknown> = { ...record }
    for (const key of ['Modelo', 'Clube', 'Tamanho']) {
      if (typeof copy[key] === 'number') {
        copy[key] = String(copy[key])
        changed = true
      }
    }
    if (changed) return copy
  }
  return raw
}

function legacyIdOf(raw: unknown, key: string): string | null {
  if (typeof raw === 'object' && raw !== null && key in raw) {
    const value = (raw as Record<string, unknown>)[key]
    return value == null ? null : String(value)
  }
  return null
}

export const geminiMoneySchema = money
