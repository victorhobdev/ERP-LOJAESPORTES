import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useParams } from '@tanstack/react-router'
import { type FormEvent, useEffect, useMemo, useState } from 'react'

import { ApiError, UncertainResultError, api, currentCsrfToken, formatMoney, idempotencyHeaders } from '../lib/api.js'
import { formatCentsToMoney, moneyToCents } from '../lib/money.js'
import { variantLabel, type VariantDescription } from '../lib/variant-label.js'
import { useSessionPermissions } from './InventoryPages.js'
import { Field, Notice, Page, PageError, PageState } from './OperationalPages.js'

type PurchaseRow = {
  id: string; supplierName: string; orderedOn: string; status: string;
  pendingQuantity: number; finalAmount: string; orderedQuantity: number; receivedQuantity: number;
}
type PurchaseItem = VariantDescription & {
  id: string; variantId: string; orderedQuantity: number; receivedQuantity: number; pendingQuantity: number;
  supplierUnitCost: string; finalUnitCost: string;
}
type PurchaseReceipt = { id: string; receivedAt: string; notes: string | null; items: Array<{ purchaseOrderItemId: string; quantity: number; finalUnitCost: string }> }
type PurchaseDetail = {
  id: string; supplierId: string; supplierName: string; status: string; orderedOn: string;
  cancellationReason: string | null;
  estimatedItemsAmount: string; importFeeAmount: string; finalAmount: string;
  items: PurchaseItem[]; receipts: PurchaseReceipt[];
}
type Supplier = { id: string; name: string; contact: string | null }
type PickerVariant = { id: string; type: string; size: string; sku: string; salePrice: string; stockQuantity: number }

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const moneyPattern = /^(0|[1-9]\d*)\.\d{2}$/
const purchaseStatusLabels: Record<string, string> = {
  draft: 'Rascunho', placed: 'Realizado', partially_received: 'Recebido parcialmente',
  fully_received: 'Recebido', cancelled: 'Cancelado',
}

function formatDate(value: string): string {
  const date = new Date(`${value}T00:00:00Z`)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('pt-BR', { timeZone: 'UTC' }).format(date)
}

function formatDateTime(value: string | null): string {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value ?? '—'
  return new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date)
}

function localDate(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date())
}

export function PurchasesPage() {
  const [filters, setFilters] = useState(() => {
    const params = new URLSearchParams(window.location.search)
    return { status: params.get('status') ?? '', page: params.get('page') ?? '1' }
  })
  function update(patch: Partial<{ status: string; page: string }>) {
    setFilters((current) => {
      const next = { ...current, ...patch }
      if (patch.status !== undefined) next.page = '1'
      const params = new URLSearchParams()
      if (next.status !== '') params.set('status', next.status)
      if (next.page !== '' && next.page !== '1') params.set('page', next.page)
      const query = params.toString()
      window.history.replaceState(null, '', `/compras${query === '' ? '' : `?${query}`}`)
      return next
    })
  }
  function clear() {
    window.history.replaceState(null, '', '/compras')
    setFilters({ status: '', page: '1' })
  }
  const params = new URLSearchParams()
  if (filters.status !== '') params.set('status', filters.status)
  params.set('page', filters.page === '' ? '1' : filters.page)
  params.set('limit', '20')
  const query = useQuery({
    queryKey: ['purchases', filters.status, filters.page],
    queryFn: () => api<{ items: PurchaseRow[]; total: number; page: number; limit: number }>(`/purchase-orders?${params.toString()}`),
  })
  const filtered = filters.status !== '' || (filters.page !== '' && filters.page !== '1')
  return <Page title="Compras de fornecedores" subtitle="Pedidos e recebimentos."
    action={<a className="primary-action" href="/compras/nova">Novo pedido</a>}>
    <form className="panel inline-form" role="search" aria-label="Filtros de compras" onSubmit={(event) => event.preventDefault()}>
      <label className="field"><span>Status</span><select name="status" value={filters.status} onChange={(event) => update({ status: event.target.value })}>
        <option value="">Todos</option><option value="draft">Rascunho</option><option value="placed">Realizado</option><option value="partially_received">Recebido parcialmente</option>
        <option value="fully_received">Recebido</option><option value="cancelled">Cancelado</option>
      </select></label>
      {filters.status !== '' && <button className="secondary-action" type="button" onClick={clear}>Limpar filtros</button>}
    </form>
    {query.isPending ? <PageState>Carregando compras…</PageState> : query.isError ? <>
      <PageError error={query.error} /><button className="secondary-action" type="button" onClick={() => void query.refetch()}>Tentar novamente</button>
    </> : query.data.items.length === 0 ? <PageState>{filtered ? 'Nenhum pedido para estes filtros.' : 'Nenhum pedido registrado.'}
      {filtered && <button className="secondary-action" type="button" onClick={clear}>Ver todos os pedidos</button>}</PageState> :
      <><div className="table-wrap"><table>
        <thead><tr><th>Fornecedor</th><th>Data</th><th>Status</th><th>Pedido</th><th>Recebido</th><th>Pendente</th><th>Total</th></tr></thead>
        <tbody>{query.data.items.map((order) => <tr key={order.id}>
          <td><a href={`/compras/${order.id}`} aria-label={`Abrir pedido de ${order.supplierName}`}>{order.supplierName}</a></td>
          <td>{formatDate(order.orderedOn)}</td>
          <td>{purchaseStatusLabels[order.status] ?? order.status}</td>
          <td>{order.orderedQuantity} un.</td><td>{order.receivedQuantity} un.</td><td>{order.pendingQuantity} un.</td>
          <td>{formatMoney(order.finalAmount)}</td>
        </tr>)}</tbody>
      </table></div>
      <nav className="panel" aria-label="Paginação"><span>Página {query.data.page} de {Math.max(1, Math.ceil(query.data.total / query.data.limit))} · {query.data.total} registro(s)</span>{' '}
        <button className="secondary-action" type="button" disabled={query.data.page <= 1}
          onClick={() => update({ page: String(query.data.page - 1) })}>Anterior</button>{' '}
        <button className="secondary-action" type="button" disabled={query.data.page * query.data.limit >= query.data.total}
          onClick={() => update({ page: String(query.data.page + 1) })}>Próxima</button></nav></>}
  </Page>
}

type PendingOrder = { key: string; body: string; csrf: string }
const pendingOrderKey = 'erp.pendingPurchaseOperation.v1'

function savePendingOrder(pending: PendingOrder): boolean {
  try {
    const raw = JSON.stringify(pending)
    sessionStorage.setItem(pendingOrderKey, raw)
    return sessionStorage.getItem(pendingOrderKey) === raw
  } catch {
    return false
  }
}

function validOrderBody(body: string): boolean {
  try {
    const parsed = JSON.parse(body) as {
      supplierId?: unknown; orderedOn?: unknown; importFeeAmount?: unknown; items?: unknown;
    }
    if (typeof parsed.supplierId !== 'string' || !uuidPattern.test(parsed.supplierId)) return false
    if (typeof parsed.orderedOn !== 'string' || Number.isNaN(new Date(`${parsed.orderedOn}T00:00:00Z`).getTime())) return false
    if (typeof parsed.importFeeAmount !== 'string' || !moneyPattern.test(parsed.importFeeAmount)) return false
    if (!Array.isArray(parsed.items) || parsed.items.length === 0) return false
    return parsed.items.every((entry) => {
      if (typeof entry !== 'object' || entry === null) return false
      const item = entry as Record<string, unknown>
      return typeof item.variantId === 'string' && uuidPattern.test(item.variantId)
        && typeof item.orderedQuantity === 'number' && Number.isInteger(item.orderedQuantity) && item.orderedQuantity >= 1
        && typeof item.supplierUnitCost === 'string' && moneyPattern.test(item.supplierUnitCost)
    })
  } catch {
    return false
  }
}

function loadPendingOrder(): PendingOrder | null {
  let raw: string | null
  try {
    raw = sessionStorage.getItem(pendingOrderKey)
  } catch {
    return null
  }
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<PendingOrder>
    if (typeof parsed.key !== 'string' || parsed.key === '' || typeof parsed.body !== 'string'
      || typeof parsed.csrf !== 'string' || parsed.csrf !== (currentCsrfToken() ?? '') || !validOrderBody(parsed.body)) {
      clearPendingOrder()
      return null
    }
    return parsed as PendingOrder
  } catch {
    clearPendingOrder()
    return null
  }
}

function clearPendingOrder() {
  try {
    sessionStorage.removeItem(pendingOrderKey)
  } catch {
    return
  }
}

type NewItemRow = { variantId: string; label: string; quantity: string; unitCost: string }

export function NewPurchasePage() {
  const client = useQueryClient()
  const [supplierSearch, setSupplierSearch] = useState('')
  const [supplier, setSupplier] = useState<Supplier | null>(null)
  const [variantSearch, setVariantSearch] = useState('')
  const [rows, setRows] = useState<NewItemRow[]>([])
  const [orderedOn, setOrderedOn] = useState(localDate())
  const [importFee, setImportFee] = useState('0.00')
  const [validationError, setValidationError] = useState<string | null>(null)
  const [operation, setOperation] = useState<{ key: string; body: string } | null>(null)
  const [uncertain, setUncertain] = useState(false)
  const [persistError, setPersistError] = useState(false)
  const [created, setCreated] = useState(false)
  const suppliers = useQuery({
    queryKey: ['suppliers', 'purchase', supplierSearch],
    queryFn: () => api<{ items: Supplier[] }>(`/suppliers?search=${encodeURIComponent(supplierSearch)}&limit=20`),
    enabled: supplierSearch.trim().length >= 2,
    retry: false,
  })
  const variants = useQuery({
    queryKey: ['products', 'purchase-picker', variantSearch],
    queryFn: () => api<{ items: Array<{ id: string; club: string; model: string; variants: PickerVariant[] }> }>(
      `/products?search=${encodeURIComponent(variantSearch)}&limit=20`),
    enabled: variantSearch.trim().length >= 2,
    retry: false,
  })
  const order = useMutation({
    mutationFn: async (op: { key: string; body: string }) => {
      const response = await api<{ id: string; status: string; finalAmount: string }>('/purchase-orders', {
        method: 'POST', headers: idempotencyHeaders(op.key), body: op.body,
      })
      if (!response || typeof response.id !== 'string') throw new UncertainResultError(201)
      return response
    },
    onSuccess: async () => {
      setCreated(true); setOperation(null); setUncertain(false); setPersistError(false); setValidationError(null)
      clearPendingOrder()
      await client.invalidateQueries({ queryKey: ['purchases'] })
    },
    onError: (error) => {
      if (error instanceof TypeError || error instanceof UncertainResultError || (error instanceof ApiError && error.status >= 500)) {
        setUncertain(true)
        return
      }
      setUncertain(false)
      setOperation(null)
      clearPendingOrder()
    },
  })
  const locked = order.isPending || uncertain
  useEffect(() => {
    const pending = loadPendingOrder()
    if (pending) {
      setOperation({ key: pending.key, body: pending.body })
      setUncertain(true)
    }
  }, [])
  const estimatedTotal = useMemo(() => {
    try {
      const itemsCents = rows.reduce((sum, row) => {
        if (!moneyPattern.test(row.unitCost)) throw new Error('custo')
        const quantity = Number(row.quantity)
        if (!Number.isInteger(quantity) || quantity < 1) throw new Error('quantidade')
        return sum + moneyToCents(row.unitCost) * BigInt(quantity)
      }, 0n)
      if (!moneyPattern.test(importFee)) throw new Error('taxa')
      return formatCentsToMoney(itemsCents + moneyToCents(importFee))
    } catch {
      return null
    }
  }, [rows, importFee])
  function addVariant(productClub: string, productModel: string, variant: PickerVariant) {
    if (locked) return
    setRows((current) => current.some((row) => row.variantId === variant.id)
      ? current
      : [...current, {
        variantId: variant.id, label: `${productClub} ${productModel} · ${variant.type} ${variant.size} · ${variant.sku}`,
        quantity: '1', unitCost: '',
      }])
  }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (locked) return
    setValidationError(null)
    if (!supplier) {
      setValidationError('Selecione um fornecedor.')
      return
    }
    if (rows.length === 0) {
      setValidationError('Adicione ao menos uma variante.')
      return
    }
    if (!moneyPattern.test(importFee)) {
      setValidationError('Taxa de importação inválida. Use o formato 0.00.')
      return
    }
    for (const row of rows) {
      const quantity = Number(row.quantity)
      if (!Number.isInteger(quantity) || quantity < 1) {
        setValidationError(`Quantidade inválida para ${row.label}.`)
        return
      }
      if (!moneyPattern.test(row.unitCost)) {
        setValidationError(`Custo inválido para ${row.label}. Use o formato 0.00.`)
        return
      }
    }
    const body = JSON.stringify({
      supplierId: supplier.id,
      orderedOn,
      importFeeAmount: importFee,
      items: rows.map((row) => ({ variantId: row.variantId, orderedQuantity: Number(row.quantity), supplierUnitCost: row.unitCost })),
    })
    const op = { key: crypto.randomUUID(), body }
    if (!savePendingOrder({ ...op, csrf: currentCsrfToken() ?? '' })) {
      setPersistError(true)
      return
    }
    setPersistError(false)
    setCreated(false)
    setOperation(op)
    setUncertain(false)
    order.mutate(op)
  }
  return <Page title="Novo pedido de compra" subtitle="Fornecedor, variantes, quantidades e custos."
    action={<a className="primary-action" href="/compras">Voltar às compras</a>}>
    {created && <Notice tone="success">Pedido criado.</Notice>}
    {order.isError && <PageError error={order.error} />}
    {validationError && <Notice tone="danger">{validationError}</Notice>}
    {persistError && !order.isPending && !uncertain && <Notice tone="danger">Não foi possível garantir a recuperação do pedido após recarga; nada foi enviado. Tente novamente.</Notice>}
    {uncertain && !order.isPending && <div className="panel"><p>Resposta do pedido incerta. Não altere os dados.</p>
      <button className="primary-button" type="button" onClick={() => { if (operation) order.mutate(operation) }}>Tentar novamente</button></div>}
    <form className="panel form-grid" onSubmit={submit}>
      <fieldset className="panel" disabled={locked}>
        <legend>Fornecedor</legend>
        {supplier && <p>Selecionado: {supplier.name}{' '}
          <button className="secondary-action" type="button" onClick={() => setSupplier(null)}>Trocar</button></p>}
        <label className="field"><span>Buscar fornecedor</span>
          <input value={supplierSearch} placeholder="Digite ao menos 2 letras"
            onChange={(event) => setSupplierSearch(event.target.value)} /></label>
        {supplierSearch.trim().length >= 2 && (suppliers.isPending ? <PageState>Buscando fornecedores…</PageState>
          : suppliers.isError ? <><PageError error={suppliers.error} /><button className="secondary-action" type="button" onClick={() => void suppliers.refetch()}>Buscar novamente</button></>
          : suppliers.data && (suppliers.data.items.length === 0 ? <p>Nenhum fornecedor para esta busca.</p> :
            <div>{suppliers.data.items.map((item) => <label className="field" key={item.id}>
              <input type="radio" name="supplier" checked={supplier?.id === item.id}
                onChange={() => { setSupplier(item); setValidationError(null) }} />
              <span>{item.name}{item.contact ? ` · ${item.contact}` : ''}</span>
            </label>)}</div>))}
      </fieldset>
      <fieldset className="panel" disabled={locked}>
        <legend>Variantes</legend>
        <label className="field"><span>Buscar variante</span>
          <input value={variantSearch} placeholder="Clube, modelo ou SKU"
            onChange={(event) => setVariantSearch(event.target.value)} /></label>
        {variantSearch.trim().length >= 2 && (variants.isPending ? <PageState>Buscando variantes…</PageState>
          : variants.isError ? <><PageError error={variants.error} /><button className="secondary-action" type="button" onClick={() => void variants.refetch()}>Buscar novamente</button></>
          : variants.data && (variants.data.items.length === 0 ? <p>Nenhuma variante para esta busca.</p> :
            <div>{variants.data.items.flatMap((product) => product.variants.map((variant) => <label className="field" key={variant.id}>
              <input type="checkbox" checked={rows.some((row) => row.variantId === variant.id)}
                onChange={() => addVariant(product.club, product.model, variant)} />
              <span>{product.club} {product.model} · {variant.type} {variant.size} · {variant.sku} · saldo {variant.stockQuantity}</span>
            </label>))}</div>))}
        {rows.map((row) => <fieldset className="panel" key={row.variantId}>
          <legend>{row.label}</legend>
          <label className="field"><span>Quantidade</span><input type="number" min={1} step={1} value={row.quantity} required
            onChange={(event) => setRows((current) => current.map((entry) => entry.variantId === row.variantId ? { ...entry, quantity: event.target.value } : entry))} /></label>
          <label className="field"><span>Custo unitário</span><input value={row.unitCost} placeholder="0.00" required
            onChange={(event) => setRows((current) => current.map((entry) => entry.variantId === row.variantId ? { ...entry, unitCost: event.target.value } : entry))} /></label>
          <button className="secondary-action" type="button"
            onClick={() => setRows((current) => current.filter((entry) => entry.variantId !== row.variantId))}>Remover item</button>
        </fieldset>)}
      </fieldset>
      <label className="field"><span>Data do pedido</span><input name="orderedOn" type="date" value={orderedOn} disabled={locked} required
        onChange={(event) => setOrderedOn(event.target.value)} /></label>
      <label className="field"><span>Taxa de importação</span><input name="importFee" value={importFee} disabled={locked} placeholder="0.00" required
        onChange={(event) => setImportFee(event.target.value)} /></label>
      {estimatedTotal !== null && <p aria-live="polite">Total estimado: {formatMoney(estimatedTotal)}</p>}
      <button className="primary-button" disabled={locked}>{order.isPending ? 'Criando…' : 'Criar pedido'}</button>
    </form>
  </Page>
}

type PendingReceipt = { key: string; body: string; orderId: string; csrf: string }
const pendingReceiptKey = 'erp.pendingReceiptOperation.v1'

function savePendingReceipt(pending: PendingReceipt): boolean {
  try {
    const raw = JSON.stringify(pending)
    sessionStorage.setItem(pendingReceiptKey, raw)
    return sessionStorage.getItem(pendingReceiptKey) === raw
  } catch {
    return false
  }
}

function loadPendingReceipt(orderId: string): PendingReceipt | null {
  let raw: string | null
  try {
    raw = sessionStorage.getItem(pendingReceiptKey)
  } catch {
    return null
  }
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<PendingReceipt>
    if (typeof parsed.key !== 'string' || parsed.key === '' || typeof parsed.body !== 'string'
      || parsed.orderId !== orderId || typeof parsed.csrf !== 'string' || parsed.csrf !== (currentCsrfToken() ?? '')) {
      clearPendingReceipt()
      return null
    }
    const body = JSON.parse(parsed.body) as { items?: unknown; notes?: unknown }
    if (!Array.isArray(body.items) || body.items.length === 0
      || !body.items.every((entry) => {
        if (typeof entry !== 'object' || entry === null) return false
        const item = entry as Record<string, unknown>
        return typeof item.purchaseOrderItemId === 'string' && uuidPattern.test(item.purchaseOrderItemId)
          && typeof item.quantity === 'number' && Number.isInteger(item.quantity) && item.quantity >= 1 && item.quantity <= 100_000
      })
      || (body.notes !== undefined && (typeof body.notes !== 'string' || body.notes.trim().length > 1000))) {
      clearPendingReceipt()
      return null
    }
    return parsed as PendingReceipt
  } catch {
    clearPendingReceipt()
    return null
  }
}

function clearPendingReceipt() {
  try {
    sessionStorage.removeItem(pendingReceiptKey)
  } catch {
    return
  }
}

export function PurchaseDetailPage({ purchaseOrderId }: { purchaseOrderId?: string } = {}) {
  if (purchaseOrderId !== undefined) return <PurchaseDetail purchaseOrderId={purchaseOrderId} />
  return <RoutedPurchaseDetail />
}

function RoutedPurchaseDetail() {
  const { pedidoId } = useParams({ strict: false }) as { pedidoId?: string }
  return <PurchaseDetail purchaseOrderId={pedidoId} />
}

function PurchaseDetail({ purchaseOrderId }: { purchaseOrderId?: string | undefined }) {
  const client = useQueryClient()
  const permissions = useSessionPermissions()
  const detail = useQuery({
    queryKey: ['purchases', purchaseOrderId],
    queryFn: () => api<PurchaseDetail>(`/purchase-orders/${purchaseOrderId}`),
    retry: false,
  })
  if (detail.isPending) return <Page title="Pedido"><PageState>Carregando pedido…</PageState></Page>
  if (detail.isError) return <Page title="Pedido"><PageError error={detail.error} /><p><a href="/compras">Voltar às compras</a></p></Page>
  const order = detail.data
  const receivable = order.status === 'placed' || order.status === 'partially_received'
  const canReceive = receivable && (permissions.includes('*') || permissions.includes('purchases:receive'))
  const canCancel = (order.status === 'draft' || order.status === 'placed')
    && (permissions.includes('*') || permissions.includes('purchases:write'))
  async function refresh() {
    await client.invalidateQueries({ queryKey: ['purchases', purchaseOrderId] })
    await client.invalidateQueries({ queryKey: ['purchases'] })
  }
  return <Page title={`Pedido ${order.id.slice(0, 8)}`} subtitle={`${purchaseStatusLabels[order.status] ?? order.status} · ${order.supplierName}`}
    action={<a className="primary-action" href="/compras">Voltar às compras</a>}>
    <section className="panel" aria-label="Resumo do pedido">
      <p>Fornecedor {order.supplierName} · pedido em {formatDate(order.orderedOn)}</p>
      <p>Estimativa {formatMoney(order.estimatedItemsAmount)} · taxa {formatMoney(order.importFeeAmount)} · total {formatMoney(order.finalAmount)}</p>
      {order.cancellationReason && <p>Motivo do cancelamento: {order.cancellationReason}</p>}
    </section>
    <section className="panel" aria-label="Itens do pedido">
      <h2>Itens</h2>
      <div className="table-wrap"><table>
        <thead><tr><th>Variante</th><th>Pedido</th><th>Recebido</th><th>Pendente</th><th>Custo final</th></tr></thead>
        <tbody>{order.items.map((item) => <tr key={item.id}>
          <td>{variantLabel(item)}</td><td>{item.orderedQuantity} un.</td><td>{item.receivedQuantity} un.</td>
          <td>{item.pendingQuantity} un.</td><td>{formatMoney(item.finalUnitCost)}</td>
        </tr>)}</tbody>
      </table></div>
    </section>
    <section className="panel" aria-label="Recebimentos">
      <h2>Recebimentos</h2>
      {order.receipts.length === 0 ? <PageState>Nenhum recebimento registrado.</PageState> :
        order.receipts.map((receipt) => <article className="panel" key={receipt.id}>
          <h3>Recebimento {receipt.id.slice(0, 8)} · {formatDateTime(receipt.receivedAt)}</h3>
          {receipt.notes && <p>{receipt.notes}</p>}
          <ul className="plain-list">{receipt.items.map((item) => <li key={item.purchaseOrderItemId}>
            {variantLabel(order.items.find((entry) => entry.id === item.purchaseOrderItemId)!)} · {item.quantity} un. · {formatMoney(item.finalUnitCost)}
          </li>)}</ul>
        </article>)}
      {!receivable
        ? <PageState>{order.status === 'fully_received' ? 'Pedido totalmente recebido; não há novo recebimento.' : 'Pedido cancelado; não há novo recebimento.'}</PageState>
        : canReceive ? <ReceiveForm order={order} onConfirmed={() => { void refresh() }} />
        : <PageState>Seu perfil não tem permissão para receber pedidos.</PageState>}
    </section>
    <section className="panel" aria-label="Cancelamento">
      <h2>Cancelamento</h2>
      {order.status === 'cancelled' ? <PageState>Pedido cancelado.</PageState>
        : (order.status === 'draft' || order.status === 'placed')
          ? (canCancel ? <CancelForm order={order} onConfirmed={() => { void refresh() }} />
            : <PageState>Seu perfil não tem permissão para cancelar pedidos.</PageState>)
          : <PageState>Cancelamento não é permitido depois de recebimento.</PageState>}
    </section>
  </Page>
}

function CancelForm({ order, onConfirmed }: { order: PurchaseDetail; onConfirmed: () => void }) {
  const [validationError, setValidationError] = useState<string | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  const cancel = useMutation({
    mutationFn: async (motivo: string) => {
      return api<{ id: string; status: string; cancellationReason: string }>(`/purchase-orders/${order.id}/cancel`, {
        method: 'POST', body: JSON.stringify({ reason: motivo }),
      })
    },
    onSuccess: () => {
      setConfirmed(true)
      setValidationError(null)
      onConfirmed()
    },
  })
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (cancel.isPending) return
    const data = new FormData(event.currentTarget)
    const motivo = String(data.get('reason') ?? '').trim()
    if (motivo === '') {
      setValidationError('Informe o motivo do cancelamento.')
      return
    }
    setValidationError(null)
    cancel.mutate(motivo)
  }
  return <div>
    <h3>Cancelar pedido</h3>
    {confirmed && <Notice tone="success">Pedido cancelado.</Notice>}
    {cancel.isError && <PageError error={cancel.error} />}
    {validationError && <Notice tone="danger">{validationError}</Notice>}
    <p>Cancelamentos não são permitidos depois de recebimento e ficam registrados na auditoria.</p>
    <form className="form-grid" onSubmit={submit}>
      <Field label="Motivo do cancelamento" name="reason" disabled={cancel.isPending} />
      <button className="secondary-action" type="submit" disabled={cancel.isPending}>
        {cancel.isPending ? 'Cancelando…' : 'Cancelar pedido'}
      </button>
    </form>
  </div>
}

function ReceiveForm({ order, onConfirmed }: { order: PurchaseDetail; onConfirmed: () => void }) {
  const [quantities, setQuantities] = useState<Record<string, string>>({})
  const [operation, setOperation] = useState<{ key: string; body: string } | null>(null)
  const [uncertain, setUncertain] = useState(false)
  const [persistError, setPersistError] = useState(false)
  const [validationError, setValidationError] = useState<string | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  const receipt = useMutation({
    mutationFn: async (op: { key: string; body: string }) => {
      const response = await api<{ id: string; purchaseOrderId: string; status: string }>(`/purchase-orders/${order.id}/receipts`, {
        method: 'POST', headers: idempotencyHeaders(op.key), body: op.body,
      })
      if (!response || typeof response.id !== 'string') throw new UncertainResultError(201)
      return response
    },
    onSuccess: () => {
      setConfirmed(true); setOperation(null); setUncertain(false); setPersistError(false); setValidationError(null)
      setQuantities({})
      clearPendingReceipt()
      onConfirmed()
    },
    onError: (error) => {
      if (error instanceof TypeError || error instanceof UncertainResultError || (error instanceof ApiError && error.status >= 500)) {
        setUncertain(true)
        return
      }
      setUncertain(false)
      setOperation(null)
      clearPendingReceipt()
    },
  })
  const locked = receipt.isPending || uncertain
  useEffect(() => {
    const pending = loadPendingReceipt(order.id)
    if (pending) {
      setOperation({ key: pending.key, body: pending.body })
      setUncertain(true)
    }
  }, [order.id])
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (locked) return
    setValidationError(null)
    const data = new FormData(event.currentTarget)
    const notes = String(data.get('notes') ?? '').trim()
    const items: Array<{ purchaseOrderItemId: string; quantity: number }> = []
    for (const item of order.items) {
      if (item.pendingQuantity <= 0) continue
      const quantity = Number(quantities[item.id] ?? '')
      if (quantities[item.id] === undefined || quantities[item.id] === '') continue
      if (!Number.isInteger(quantity) || quantity < 1) {
        setValidationError(`Quantidade inválida para o item ${variantLabel(item)}.`)
        return
      }
      if (quantity > item.pendingQuantity) {
        setValidationError(`Quantidade acima do pendente (${item.pendingQuantity} un.) para o item ${variantLabel(item)}.`)
        return
      }
      items.push({ purchaseOrderItemId: item.id, quantity })
    }
    if (items.length === 0) {
      setValidationError('Informe ao menos um item com quantidade.')
      return
    }
    const body = JSON.stringify(notes === '' ? { items } : { items, notes })
    const op = { key: crypto.randomUUID(), body }
    if (!savePendingReceipt({ ...op, orderId: order.id, csrf: currentCsrfToken() ?? '' })) {
      setPersistError(true)
      return
    }
    setPersistError(false)
    setConfirmed(false)
    setOperation(op)
    setUncertain(false)
    receipt.mutate(op)
  }
  return <section aria-label="Novo recebimento">
    <h3>Registrar recebimento</h3>
    {confirmed && <Notice tone="success">Recebimento registrado.</Notice>}
    {receipt.isError && <PageError error={receipt.error} />}
    {validationError && <Notice tone="danger">{validationError}</Notice>}
    {persistError && !receipt.isPending && !uncertain && <Notice tone="danger">Não foi possível garantir a recuperação do recebimento após recarga; nada foi enviado. Tente novamente.</Notice>}
    {uncertain && !receipt.isPending && <div className="panel"><p>Resposta do recebimento incerta. Não altere os dados.</p>
      <button className="primary-button" type="button" onClick={() => { if (operation) receipt.mutate(operation) }}>Tentar novamente</button></div>}
    <form className="form-grid" onSubmit={submit}>
      {order.items.filter((item) => item.pendingQuantity > 0).map((item) => <label className="field" key={item.id}>
        <span>Receber item {variantLabel(item)} (pendente {item.pendingQuantity})</span>
        <input type="number" step={1} disabled={locked}
          value={quantities[item.id] ?? ''}
          onChange={(event) => setQuantities((current) => ({ ...current, [item.id]: event.target.value }))} />
      </label>)}
      <Field label="Notas (opcional)" name="notes" disabled={locked} />
      <button className="primary-button" disabled={locked}>{receipt.isPending ? 'Registrando…' : 'Registrar recebimento'}</button>
    </form>
  </section>
}
