import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useParams } from '@tanstack/react-router'
import { type FormEvent, useEffect, useState } from 'react'

import { ApiError, UncertainResultError, api, currentCsrfToken, idempotencyHeaders } from '../lib/api.js'
import { Field, Notice, Page, PageError, PageState } from './OperationalPages.js'

type CustomerOrderRow = {
  id: string; status: string; club: string; model: string; type: string; size: string;
  createdAt: string; customerName: string; customerContact: string | null;
}
type OrderEvent = {
  id: string; fromStatus: string | null; toStatus: string; reason: string | null;
  createdAt: string; userDisplayName: string;
}
type CustomerOrderDetail = {
  id: string; customerId: string; variantId: string | null; linkedPurchaseOrderId: string | null;
  club: string; model: string; type: string; size: string; notes: string | null;
  status: string; cancellationReason: string | null; createdAt: string; updatedAt: string;
  customerName: string; customerContact: string | null; operatorDisplayName: string;
  variantType: string | null; variantSize: string | null; variantSku: string | null;
  variantSalePrice: string | null; variantStockQuantity: number | null;
  variantClub: string | null; variantModel: string | null;
  timeline: OrderEvent[];
}
type Customer = { id: string; name: string; contact: string | null }

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const orderStatusLabels: Record<string, string> = {
  pending: 'Pendente', supplier_ordered: 'Pedido ao fornecedor', product_arrived: 'Produto chegou',
  delivered: 'Entregue', cancelled: 'Cancelado',
}
const nextActions: Record<string, Array<{ status: string; label: string }>> = {
  pending: [{ status: 'supplier_ordered', label: 'Pedir ao fornecedor' }],
  supplier_ordered: [{ status: 'product_arrived', label: 'Marcar produto chegado' }],
  product_arrived: [{ status: 'delivered', label: 'Entregar ao cliente' }],
  delivered: [],
  cancelled: [],
}

function formatDateTime(value: string | null): string {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value ?? '—'
  return new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date)
}

export function CustomerOrdersPage() {
  const [filters, setFilters] = useState(() => {
    const params = new URLSearchParams(window.location.search)
    return { search: params.get('search') ?? '', status: params.get('status') ?? '', page: params.get('page') ?? '1' }
  })
  const [showCreate, setShowCreate] = useState(false)
  function update(patch: Partial<{ search: string; status: string; page: string }>) {
    setFilters((current) => {
      const next = { ...current, ...patch }
      if (patch.search !== undefined || patch.status !== undefined) next.page = '1'
      const params = new URLSearchParams()
      if (next.search !== '') params.set('search', next.search)
      if (next.status !== '') params.set('status', next.status)
      if (next.page !== '' && next.page !== '1') params.set('page', next.page)
      const query = params.toString()
      window.history.replaceState(null, '', `/encomendas${query === '' ? '' : `?${query}`}`)
      return next
    })
  }
  function clear() {
    window.history.replaceState(null, '', '/encomendas')
    setFilters({ search: '', status: '', page: '1' })
  }
  const params = new URLSearchParams()
  if (filters.search !== '') params.set('search', filters.search)
  if (filters.status !== '') params.set('status', filters.status)
  params.set('page', filters.page === '' ? '1' : filters.page)
  params.set('limit', '20')
  const query = useQuery({
    queryKey: ['customer-orders', filters.search, filters.status, filters.page],
    queryFn: () => api<{ items: CustomerOrderRow[]; total: number; page: number; limit: number }>(`/customer-orders?${params.toString()}`),
  })
  const filtered = filters.search !== '' || filters.status !== ''
  return <Page title="Encomendas de clientes" subtitle="Solicitações livres; nenhuma compra ou reserva é criada automaticamente."
    action={<button className="primary-action" type="button" onClick={() => setShowCreate((value) => !value)}>
      {showCreate ? 'Fechar formulário' : 'Nova encomenda'}</button>}>
    {showCreate && <NewCustomerOrderForm onCreated={() => { void query.refetch() }} />}
    <form className="panel inline-form" role="search" aria-label="Filtros de encomendas" onSubmit={(event) => event.preventDefault()}>
      <label className="field"><span>Busca</span><input name="search" value={filters.search} placeholder="Cliente, contato, clube ou modelo"
        onChange={(event) => update({ search: event.target.value })} /></label>
      <label className="field"><span>Status</span><select name="status" value={filters.status} onChange={(event) => update({ status: event.target.value })}>
        <option value="">Todos</option><option value="pending">Pendente</option><option value="supplier_ordered">Pedido ao fornecedor</option>
        <option value="product_arrived">Produto chegou</option><option value="delivered">Entregue</option><option value="cancelled">Cancelado</option>
      </select></label>
      {filtered && <button className="secondary-action" type="button" onClick={clear}>Limpar filtros</button>}
    </form>
    {query.isPending ? <PageState>Carregando encomendas…</PageState> : query.isError ? <>
      <PageError error={query.error} /><button className="secondary-action" type="button" onClick={() => void query.refetch()}>Tentar novamente</button>
    </> : query.data.items.length === 0 ? <PageState>{filtered ? 'Nenhuma encomenda para estes filtros.' : 'Nenhuma encomenda registrada.'}
      {filtered && <button className="secondary-action" type="button" onClick={clear}>Ver todas as encomendas</button>}</PageState> :
      <><div className="table-wrap"><table>
        <thead><tr><th>Cliente</th><th>Produto solicitado</th><th>Status</th><th>Criada em</th></tr></thead>
        <tbody>{query.data.items.map((order) => <tr key={order.id}>
          <td><a href={`/encomendas/${order.id}`} aria-label={`Abrir encomenda de ${order.customerName}`}>{order.customerName}</a></td>
          <td>{order.club} · {order.model}</td>
          <td>{orderStatusLabels[order.status] ?? order.status}</td>
          <td>{formatDateTime(order.createdAt)}</td>
        </tr>)}</tbody>
      </table></div>
      <nav className="panel" aria-label="Paginação"><span>Página {query.data.page} de {Math.max(1, Math.ceil(query.data.total / query.data.limit))} · {query.data.total} registro(s)</span>{' '}
        <button className="secondary-action" type="button" disabled={query.data.page <= 1}
          onClick={() => update({ page: String(query.data.page - 1) })}>Anterior</button>{' '}
        <button className="secondary-action" type="button" disabled={query.data.page * query.data.limit >= query.data.total}
          onClick={() => update({ page: String(query.data.page + 1) })}>Próxima</button></nav></>}
  </Page>
}

type PendingCustomerOrder = { key: string; body: string; csrf: string }
const pendingCustomerOrderKey = 'erp.pendingCustomerOrderOperation.v1'

function savePendingCustomerOrder(pending: PendingCustomerOrder): boolean {
  try {
    const raw = JSON.stringify(pending)
    sessionStorage.setItem(pendingCustomerOrderKey, raw)
    return sessionStorage.getItem(pendingCustomerOrderKey) === raw
  } catch {
    return false
  }
}

function validCustomerOrderBody(body: string): boolean {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>
    if (typeof parsed.customerId !== 'string' || !uuidPattern.test(parsed.customerId)) return false
    if (parsed.variantId !== undefined && parsed.variantId !== null
      && (typeof parsed.variantId !== 'string' || !uuidPattern.test(parsed.variantId))) return false
    if (parsed.linkedPurchaseOrderId !== undefined && parsed.linkedPurchaseOrderId !== null
      && (typeof parsed.linkedPurchaseOrderId !== 'string' || !uuidPattern.test(parsed.linkedPurchaseOrderId))) return false
    for (const field of ['club', 'model', 'size'] as const) {
      if (typeof parsed[field] !== 'string' || parsed[field].trim() === '') return false
    }
    if (parsed.type !== 'Masculina' && parsed.type !== 'Feminina' && parsed.type !== 'Infantil') return false
    if (parsed.notes !== undefined && parsed.notes !== null
      && (typeof parsed.notes !== 'string' || parsed.notes.trim().length > 1000)) return false
    return true
  } catch {
    return false
  }
}

function loadPendingCustomerOrder(): PendingCustomerOrder | null {
  let raw: string | null
  try {
    raw = sessionStorage.getItem(pendingCustomerOrderKey)
  } catch {
    return null
  }
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<PendingCustomerOrder>
    if (typeof parsed.key !== 'string' || parsed.key === '' || typeof parsed.body !== 'string'
      || typeof parsed.csrf !== 'string' || parsed.csrf !== (currentCsrfToken() ?? '') || !validCustomerOrderBody(parsed.body)) {
      clearPendingCustomerOrder()
      return null
    }
    return parsed as PendingCustomerOrder
  } catch {
    clearPendingCustomerOrder()
    return null
  }
}

function clearPendingCustomerOrder() {
  try {
    sessionStorage.removeItem(pendingCustomerOrderKey)
  } catch {
    return
  }
}

export function NewCustomerOrderForm({ onCreated }: { onCreated?: () => void }) {
  const client = useQueryClient()
  const [customerSearch, setCustomerSearch] = useState('')
  const [customer, setCustomer] = useState<Customer | null>(null)
  const [variantSearch, setVariantSearch] = useState('')
  const [variantId, setVariantId] = useState<string | null>(null)
  const [selectedVariantLabel, setSelectedVariantLabel] = useState('')
  const [validationError, setValidationError] = useState<string | null>(null)
  const [operation, setOperation] = useState<{ key: string; body: string } | null>(null)
  const [uncertain, setUncertain] = useState(false)
  const [persistError, setPersistError] = useState(false)
  const [created, setCreated] = useState(false)
  const customers = useQuery({
    queryKey: ['customers', 'order', customerSearch],
    queryFn: () => api<{ items: Customer[] }>(`/customers?search=${encodeURIComponent(customerSearch)}&limit=20`),
    enabled: customerSearch.trim().length >= 2,
    retry: false,
  })
  const variants = useQuery({
    queryKey: ['products', 'order-picker', variantSearch],
    queryFn: () => api<{ items: Array<{ id: string; club: string; model: string; variants: Array<{ id: string; type: string; size: string; sku: string; stockQuantity: number }> }> }>(
      `/products?search=${encodeURIComponent(variantSearch)}&limit=20`),
    enabled: variantSearch.trim().length >= 2,
    retry: false,
  })
  const order = useMutation({
    mutationFn: async (op: { key: string; body: string }) => {
      const response = await api<{ id: string; status: string }>('/customer-orders', {
        method: 'POST', headers: idempotencyHeaders(op.key), body: op.body,
      })
      if (!response || typeof response.id !== 'string') throw new UncertainResultError(201)
      return response
    },
    onSuccess: async () => {
      setCreated(true); setOperation(null); setUncertain(false); setPersistError(false); setValidationError(null)
      clearPendingCustomerOrder()
      await client.invalidateQueries({ queryKey: ['customer-orders'] })
      onCreated?.()
    },
    onError: (error) => {
      if (error instanceof TypeError || error instanceof UncertainResultError || (error instanceof ApiError && error.status >= 500)) {
        setUncertain(true)
        return
      }
      setUncertain(false)
      setOperation(null)
      clearPendingCustomerOrder()
    },
  })
  const locked = order.isPending || uncertain
  useEffect(() => {
    const pending = loadPendingCustomerOrder()
    if (pending) {
      setOperation({ key: pending.key, body: pending.body })
      setUncertain(true)
    }
  }, [])
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (locked) return
    setValidationError(null)
    const data = new FormData(event.currentTarget)
    const club = String(data.get('club') ?? '').trim()
    const model = String(data.get('model') ?? '').trim()
    const type = String(data.get('type') ?? '')
    const size = String(data.get('size') ?? '').trim()
    const notes = String(data.get('notes') ?? '').trim()
    if (!customer) {
      setValidationError('Selecione um cliente.')
      return
    }
    if (club === '' || model === '' || size === '') {
      setValidationError('Informe clube, modelo e tamanho.')
      return
    }
    if (type !== 'Masculina' && type !== 'Feminina' && type !== 'Infantil') {
      setValidationError('Selecione o tipo.')
      return
    }
    const body = JSON.stringify({
      customerId: customer.id,
      ...(variantId ? { variantId } : {}),
      club, model, type, size,
      ...(notes === '' ? {} : { notes }),
    })
    const op = { key: crypto.randomUUID(), body }
    if (!savePendingCustomerOrder({ ...op, csrf: currentCsrfToken() ?? '' })) {
      setPersistError(true)
      return
    }
    setPersistError(false)
    setCreated(false)
    setOperation(op)
    setUncertain(false)
    order.mutate(op)
  }
  return <section className="panel" aria-label="Nova encomenda">
    <h2>Nova encomenda</h2>
    {created && <Notice tone="success">Encomenda criada.</Notice>}
    {order.isError && <PageError error={order.error} />}
    {validationError && <Notice tone="danger">{validationError}</Notice>}
    {persistError && !order.isPending && !uncertain && <Notice tone="danger">Não foi possível garantir a recuperação da encomenda após recarga; nada foi enviado. Tente novamente.</Notice>}
    {uncertain && !order.isPending && <div className="panel"><p>Resposta da encomenda incerta. Não altere os dados.</p>
      <button className="primary-button" type="button" onClick={() => { if (operation) order.mutate(operation) }}>Tentar novamente</button></div>}
    <form className="form-grid" onSubmit={submit}>
      <fieldset className="panel" disabled={locked}>
        <legend>Cliente</legend>
        {customer && <p>Selecionado: {customer.name}{' '}
          <button className="secondary-action" type="button" onClick={() => setCustomer(null)}>Trocar</button></p>}
        <label className="field"><span>Buscar cliente</span>
          <input value={customerSearch} placeholder="Digite ao menos 2 letras"
            onChange={(event) => setCustomerSearch(event.target.value)} /></label>
        {customerSearch.trim().length >= 2 && (customers.isPending ? <PageState>Buscando clientes…</PageState>
          : customers.isError ? <><PageError error={customers.error} /><button className="secondary-action" type="button" onClick={() => void customers.refetch()}>Buscar novamente</button></>
          : customers.data && (customers.data.items.length === 0 ? <p>Nenhum cliente para esta busca.</p> :
            <div>{customers.data.items.map((item) => <label className="field" key={item.id}>
              <input type="radio" name="customer" checked={customer?.id === item.id}
                onChange={() => { setCustomer(item); setValidationError(null) }} />
              <span>{item.name}{item.contact ? ` · ${item.contact}` : ''}</span>
            </label>)}</div>))}
      </fieldset>
      <Field label="Clube" name="club" required disabled={locked} />
      <Field label="Modelo" name="model" required disabled={locked} />
      <label className="field"><span>Tipo</span><select name="type" defaultValue="Masculina" disabled={locked}>
        <option value="Masculina">Masculina</option><option value="Feminina">Feminina</option><option value="Infantil">Infantil</option>
      </select></label>
      <Field label="Tamanho" name="size" required disabled={locked} />
      <Field label="Observação (opcional)" name="notes" disabled={locked} />
      <fieldset className="panel" disabled={locked}>
        <legend>Variante associada (opcional)</legend>
        {variantId && <p>Associada: {selectedVariantLabel}{' '}
          <button className="secondary-action" type="button" onClick={() => setVariantId(null)}>Remover</button></p>}
        <label className="field"><span>Buscar variante</span>
          <input value={variantSearch} placeholder="Clube, modelo ou SKU"
            onChange={(event) => setVariantSearch(event.target.value)} /></label>
        {variantSearch.trim().length >= 2 && (variants.isPending ? <PageState>Buscando variantes…</PageState>
          : variants.isError ? <><PageError error={variants.error} /><button className="secondary-action" type="button" onClick={() => void variants.refetch()}>Buscar novamente</button></>
          : variants.data && (variants.data.items.length === 0 ? <p>Nenhuma variante para esta busca.</p> :
            <div>{variants.data.items.flatMap((product) => product.variants.map((variant) => <label className="field" key={variant.id}>
              <input type="radio" name="variant" checked={variantId === variant.id} onChange={() => {
                setVariantId(variant.id)
                setSelectedVariantLabel(`${product.club} ${product.model} · ${variant.type} ${variant.size}`)
              }} />
              <span>{product.club} {product.model} · {variant.type} {variant.size} · {variant.sku}</span>
            </label>))}</div>))}
      </fieldset>
      <button className="primary-button" disabled={locked}>{order.isPending ? 'Criando…' : 'Criar encomenda'}</button>
    </form>
  </section>
}

type PendingOrderStatus = { key: string; body: string; orderId: string; csrf: string }
const pendingOrderStatusKey = 'erp.pendingOrderStatusOperation.v1'

function savePendingOrderStatus(pending: PendingOrderStatus): boolean {
  try {
    const raw = JSON.stringify(pending)
    sessionStorage.setItem(pendingOrderStatusKey, raw)
    return sessionStorage.getItem(pendingOrderStatusKey) === raw
  } catch {
    return false
  }
}

function loadPendingOrderStatus(orderId: string): PendingOrderStatus | null {
  let raw: string | null
  try {
    raw = sessionStorage.getItem(pendingOrderStatusKey)
  } catch {
    return null
  }
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<PendingOrderStatus>
    if (typeof parsed.key !== 'string' || parsed.key === '' || typeof parsed.body !== 'string'
      || parsed.orderId !== orderId || typeof parsed.csrf !== 'string' || parsed.csrf !== (currentCsrfToken() ?? '')) {
      clearPendingOrderStatus()
      return null
    }
    const body = JSON.parse(parsed.body) as { status?: unknown; reason?: unknown }
    if (typeof body.status !== 'string' || !['supplier_ordered', 'product_arrived', 'delivered', 'cancelled'].includes(body.status)
      || (body.reason !== undefined && (typeof body.reason !== 'string' || body.reason.trim() === '' || body.reason.trim().length > 500))) {
      clearPendingOrderStatus()
      return null
    }
    return parsed as PendingOrderStatus
  } catch {
    clearPendingOrderStatus()
    return null
  }
}

function clearPendingOrderStatus() {
  try {
    sessionStorage.removeItem(pendingOrderStatusKey)
  } catch {
    return
  }
}

export function CustomerOrderDetailPage({ orderId }: { orderId?: string } = {}) {
  if (orderId !== undefined) return <CustomerOrderDetail orderId={orderId} />
  return <RoutedCustomerOrderDetail />
}

function RoutedCustomerOrderDetail() {
  const { encomendaId } = useParams({ strict: false }) as { encomendaId?: string }
  return <CustomerOrderDetail orderId={encomendaId} />
}

function CustomerOrderDetail({ orderId }: { orderId?: string | undefined }) {
  const client = useQueryClient()
  const detail = useQuery({
    queryKey: ['customer-orders', orderId],
    queryFn: () => api<CustomerOrderDetail>(`/customer-orders/${orderId}`),
    retry: false,
  })
  if (detail.isPending) return <Page title="Encomenda"><PageState>Carregando encomenda…</PageState></Page>
  if (detail.isError) return <Page title="Encomenda"><PageError error={detail.error} /><p><a href="/encomendas">Voltar às encomendas</a></p></Page>
  const order = detail.data
  async function refresh() {
    await client.invalidateQueries({ queryKey: ['customer-orders', orderId] })
    await client.invalidateQueries({ queryKey: ['customer-orders'] })
  }
  return <Page title={`Encomenda de ${order.customerName}`} subtitle={`${orderStatusLabels[order.status] ?? order.status} · ${order.club} ${order.model}`}
    action={<a className="primary-action" href="/encomendas">Voltar às encomendas</a>}>
    <section className="panel" aria-label="Dados da encomenda">
      <p>Cliente {order.customerName}{order.customerContact ? ` · ${order.customerContact}` : ''}</p>
      <p>Solicitado: {order.club} · {order.model} · {order.type} · {order.size}</p>
      {order.notes && <p>Observação: {order.notes}</p>}
      {order.variantId && <p>Variante associada: {order.variantClub ?? ''} {order.variantModel ?? ''} · {order.variantType} {order.variantSize} · {order.variantSku}</p>}
      {order.linkedPurchaseOrderId && <p>Compra associada: {order.linkedPurchaseOrderId.slice(0, 8)}</p>}
      <p>Responsável {order.operatorDisplayName} · criada em {formatDateTime(order.createdAt)}</p>
      {order.status === 'cancelled' && order.cancellationReason && <p>Motivo do cancelamento: {order.cancellationReason}</p>}
    </section>
    <section className="panel" aria-label="Mudança de estado">
      <h2>Estado</h2>
      <StatusActions order={order} onChanged={() => { void refresh() }} />
    </section>
    <section className="panel" aria-label="Linha do tempo">
      <h2>Linha do tempo</h2>
      {order.timeline.length === 0 ? <PageState>Nenhum evento registrado.</PageState> :
        <ul className="plain-list">{order.timeline.map((event) => <li key={event.id}>
          <span><strong>{orderStatusLabels[event.toStatus] ?? event.toStatus}</strong>
            <small>{formatDateTime(event.createdAt)} · {event.userDisplayName}{event.reason ? ` · ${event.reason}` : ''}</small>
          </span>
        </li>)}</ul>}
    </section>
  </Page>
}

function StatusActions({ order, onChanged }: { order: CustomerOrderDetail; onChanged: () => void }) {
  const [operation, setOperation] = useState<{ key: string; body: string } | null>(null)
  const [uncertain, setUncertain] = useState(false)
  const [persistError, setPersistError] = useState(false)
  const [validationError, setValidationError] = useState<string | null>(null)
  const [updated, setUpdated] = useState(false)
  const [cancelReason, setCancelReason] = useState('')
  const [showCancel, setShowCancel] = useState(false)
  const actions = nextActions[order.status] ?? []
  const mutation = useMutation({
    mutationFn: async (op: { key: string; body: string }) => {
      const response = await api<{ id: string; status: string }>(`/customer-orders/${order.id}/status`, {
        method: 'PATCH', headers: idempotencyHeaders(op.key), body: op.body,
      })
      if (!response || typeof response.status !== 'string') throw new UncertainResultError(200)
      return response
    },
    onSuccess: () => {
      setUpdated(true); setOperation(null); setUncertain(false); setPersistError(false); setValidationError(null)
      setShowCancel(false); setCancelReason('')
      clearPendingOrderStatus()
      onChanged()
    },
    onError: (error) => {
      if (error instanceof TypeError || error instanceof UncertainResultError || (error instanceof ApiError && error.status >= 500)) {
        setUncertain(true)
        return
      }
      setUpdated(false)
      setUncertain(false)
      setOperation(null)
      clearPendingOrderStatus()
    },
  })
  const locked = mutation.isPending || uncertain
  useEffect(() => {
    const pending = loadPendingOrderStatus(order.id)
    if (pending) {
      setOperation({ key: pending.key, body: pending.body })
      setUncertain(true)
    }
  }, [order.id])
  function send(status: string, reason?: string) {
    if (locked) return
    setValidationError(null)
    if (status === 'cancelled' && (reason ?? '').trim() === '') {
      setValidationError('Cancelamento exige motivo.')
      return
    }
    const body = JSON.stringify(status === 'cancelled' ? { status, reason: (reason ?? '').trim() } : { status })
    const op = { key: crypto.randomUUID(), body }
    if (!savePendingOrderStatus({ ...op, orderId: order.id, csrf: currentCsrfToken() ?? '' })) {
      setPersistError(true)
      return
    }
    setPersistError(false)
    setUpdated(false)
    setOperation(op)
    setUncertain(false)
    mutation.mutate(op)
  }
  if (actions.length === 0) {
    return <>
      {updated && <Notice tone="success">Status atualizado.</Notice>}
      <PageState>{order.status === 'delivered'
        ? 'Encomenda entregue; não há novas ações.'
        : order.status === 'cancelled'
          ? 'Encomenda cancelada; não há novas ações.'
          : 'Esta encomenda entregue não muda mais de estado.'}</PageState>
    </>
  }
  return <div>
    {updated && <Notice tone="success">Status atualizado.</Notice>}
    {mutation.isError && <PageError error={mutation.error} />}
    {validationError && <Notice tone="danger">{validationError}</Notice>}
    {persistError && !mutation.isPending && !uncertain && <Notice tone="danger">Não foi possível garantir a recuperação da mudança após recarga; nada foi enviado. Tente novamente.</Notice>}
    {uncertain && !mutation.isPending && <div className="panel"><p>Resposta da mudança incerta. Não altere os dados.</p>
      <button className="primary-button" type="button" onClick={() => { if (operation) mutation.mutate(operation) }}>Tentar novamente</button></div>}
    {actions.map((action) => <p key={action.status}>
      <button className="primary-button" type="button" disabled={locked} onClick={() => send(action.status)}>{action.label}</button>
    </p>)}
    <p><button className="secondary-action" type="button" disabled={locked} onClick={() => setShowCancel((value) => !value)}>
      {showCancel ? 'Fechar cancelamento' : 'Cancelar encomenda'}</button></p>
    {showCancel && <form className="form-grid" onSubmit={(event) => { event.preventDefault(); send('cancelled', cancelReason) }}>
      <label className="field"><span>Motivo do cancelamento</span>
        <input value={cancelReason} disabled={locked}
          onChange={(event) => setCancelReason(event.target.value)} /></label>
      <button className="primary-button" disabled={locked}>{mutation.isPending ? 'Cancelando…' : 'Confirmar cancelamento'}</button>
    </form>}
  </div>
}
