import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { type FormEvent, type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import { ApiError, UncertainResultError, api, apiUpload, currentCsrfToken, formatMoney, idempotencyHeaders, isUnauthorized } from '../lib/api.js'
import { formatCentsToMoney, moneyToCents, saleTotalCents } from '../lib/money.js'
import { localTodayIso } from '../lib/date.js'

export type Variant = { id: string; type: string; size: string; sku: string; salePrice: string; stockQuantity: number }
export type Product = {
  id: string; club: string; model: string; description?: string | null
  totalStock?: number; hasImage?: boolean; mediaId?: string | null; variants: Variant[]
}
type Dashboard = {
  date: string; timezone: string; salesCreatedToday: string; confirmedPaymentsToday: string;
  pendingSalesCount: number; overdueSalesCount: number; lowStockVariants: number; outOfStockVariants: number;
  openPurchaseOrders: number; pendingPurchaseUnits: number; openCustomerOrders: number;
}
type CartItem = Variant & { label: string; quantity: number }
type SaleMode = 'paid' | 'pending' | 'partial'
type SaleContext = {
  mode: SaleMode; customerId: string | null; customerName: string;
  dueDate: string; amount: string; method: string;
}
type PendingSale = { key: string; body: string; cart: CartItem[]; csrf: string; context?: SaleContext }

const defaultSaleContext: SaleContext = { mode: 'paid', customerId: null, customerName: '', dueDate: '', amount: '', method: 'pix' }
type RestoredSale = { key: string; body: string; cart: CartItem[]; csrf: string; context: SaleContext }

const pendingSaleStorageKey = 'erp.pendingSaleOperation.v1'
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const moneyPattern = /^(0|[1-9]\d*)\.\d{2}$/

function savePendingSale(pending: PendingSale): boolean {
  try {
    const raw = JSON.stringify(pending)
    sessionStorage.setItem(pendingSaleStorageKey, raw)
    return sessionStorage.getItem(pendingSaleStorageKey) === raw
  } catch {
    return false
  }
}

function loadPendingSale(): RestoredSale | null {
  let raw: string | null
  try {
    raw = sessionStorage.getItem(pendingSaleStorageKey)
  } catch {
    return null
  }
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<PendingSale>
    if (typeof parsed.key !== 'string' || typeof parsed.body !== 'string' || !Array.isArray(parsed.cart) || typeof parsed.csrf !== 'string') {
      clearPendingSale()
      return null
    }
    if (parsed.csrf !== (currentCsrfToken() ?? '')) {
      clearPendingSale()
      return null
    }
    if (!parsed.cart.every(isValidCartItem)) {
      clearPendingSale()
      return null
    }
    const bodyItems = saleBodyItems(parsed.body)
    if (!bodyItems || !cartMatchesBody(parsed.cart as CartItem[], bodyItems)) {
      clearPendingSale()
      return null
    }
    const context = saleContext(parsed.context, parsed.body)
    if (!context) {
      clearPendingSale()
      return null
    }
    return { key: parsed.key, body: parsed.body, cart: parsed.cart as CartItem[], csrf: parsed.csrf, context }
  } catch {
    clearPendingSale()
    return null
  }
}

function saleContext(context: unknown, body: string): SaleContext | null {
  if (context === undefined) return { ...defaultSaleContext }
  if (typeof context !== 'object' || context === null) return null
  const entry = context as Record<string, unknown>
  if (entry.mode !== 'paid' && entry.mode !== 'pending' && entry.mode !== 'partial') return null
  if (entry.customerId !== null && (typeof entry.customerId !== 'string' || !uuidPattern.test(entry.customerId))) return null
  if (typeof entry.customerName !== 'string' || typeof entry.dueDate !== 'string'
    || typeof entry.amount !== 'string' || typeof entry.method !== 'string') return null
  if (entry.amount !== '' && !moneyPattern.test(entry.amount)) return null
  if (entry.method !== '' && !['cash', 'pix', 'debit_card', 'credit_card', 'bank_transfer', 'other'].includes(entry.method)) return null
  let parsedBody: { customerId?: unknown; paymentDueDate?: unknown; payment?: unknown }
  try {
    parsedBody = JSON.parse(body) as { customerId?: unknown; paymentDueDate?: unknown; payment?: unknown }
  } catch {
    return null
  }
  const bodyCustomerId = typeof parsedBody.customerId === 'string' ? parsedBody.customerId : null
  if (bodyCustomerId !== entry.customerId) return null
  const bodyDueDate = typeof parsedBody.paymentDueDate === 'string' ? parsedBody.paymentDueDate : ''
  if (bodyDueDate !== entry.dueDate) return null
  const bodyPayment = typeof parsedBody.payment === 'object' && parsedBody.payment !== null
    ? parsedBody.payment as Record<string, unknown> : null
  const bodyAmount = typeof bodyPayment?.amount === 'string' ? bodyPayment.amount : ''
  const bodyMethod = typeof bodyPayment?.method === 'string' ? bodyPayment.method : ''
  if (bodyAmount !== entry.amount || bodyMethod !== (entry.mode === 'pending' ? '' : entry.method)) return null
  return entry as SaleContext
}

function isValidCartItem(item: unknown): item is CartItem {
  if (typeof item !== 'object' || item === null) return false
  const entry = item as Record<string, unknown>
  return typeof entry.id === 'string' && uuidPattern.test(entry.id)
    && typeof entry.type === 'string' && entry.type.length > 0
    && typeof entry.size === 'string' && entry.size.length > 0
    && typeof entry.sku === 'string' && entry.sku.length > 0
    && typeof entry.salePrice === 'string' && moneyPattern.test(entry.salePrice)
    && typeof entry.quantity === 'number' && Number.isInteger(entry.quantity) && entry.quantity >= 1 && entry.quantity <= 10_000
    && typeof entry.label === 'string'
}

function saleBodyItems(body: string): Array<{ variantId: string; quantity: number }> | null {
  try {
    const parsed = JSON.parse(body) as { items?: unknown }
    if (!parsed || !Array.isArray(parsed.items) || parsed.items.length === 0) return null
    const items: Array<{ variantId: string; quantity: number }> = []
    for (const entry of parsed.items) {
      if (typeof entry !== 'object' || entry === null) return null
      const { variantId, quantity } = entry as Record<string, unknown>
      if (typeof variantId !== 'string' || !uuidPattern.test(variantId)) return null
      if (typeof quantity !== 'number' || !Number.isInteger(quantity) || quantity < 1 || quantity > 10_000) return null
      items.push({ variantId, quantity })
    }
    return items
  } catch {
    return null
  }
}

function cartMatchesBody(cart: CartItem[], bodyItems: Array<{ variantId: string; quantity: number }>): boolean {
  if (cart.length !== bodyItems.length) return false
  const key = (id: string, quantity: number) => `${id}:${quantity}`
  const cartKeys = cart.map(({ id, quantity }) => key(id, quantity)).sort()
  const bodyKeys = bodyItems.map(({ variantId, quantity }) => key(variantId, quantity)).sort()
  return cartKeys.every((value, index) => value === bodyKeys[index])
}

function clearPendingSale() {
  try {
    sessionStorage.removeItem(pendingSaleStorageKey)
  } catch {
    return
  }
}

type PendingCustomer = { key: string; body: string; csrf: string }
const pendingCustomerKey = 'erp.pendingCustomerOperation.v1'

function savePendingCustomer(pending: PendingCustomer): boolean {
  try {
    const raw = JSON.stringify(pending)
    sessionStorage.setItem(pendingCustomerKey, raw)
    return sessionStorage.getItem(pendingCustomerKey) === raw
  } catch {
    return false
  }
}

function loadPendingCustomer(): PendingCustomer | null {
  let raw: string | null
  try {
    raw = sessionStorage.getItem(pendingCustomerKey)
  } catch {
    return null
  }
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<PendingCustomer>
    if (typeof parsed.key !== 'string' || parsed.key === '' || typeof parsed.body !== 'string'
      || typeof parsed.csrf !== 'string' || parsed.csrf !== (currentCsrfToken() ?? '')) {
      clearPendingCustomer()
      return null
    }
    const body = JSON.parse(parsed.body) as { name?: unknown; contact?: unknown }
    if (typeof body.name !== 'string' || body.name.trim() === '' || body.name.trim().length > 120
      || (body.contact !== undefined && (typeof body.contact !== 'string' || body.contact.trim().length > 255))) {
      clearPendingCustomer()
      return null
    }
    return parsed as PendingCustomer
  } catch {
    clearPendingCustomer()
    return null
  }
}

function clearPendingCustomer() {
  try {
    sessionStorage.removeItem(pendingCustomerKey)
  } catch {
    return
  }
}

export function LoginPage() {
  return <DashboardPage />
}

export function isValidCivilDate(value: string): boolean {
  return parseCivilDateExact(value) !== null
}

function readDashboardDate(): string {
  return new URLSearchParams(window.location.search).get('date') ?? localDate()
}

export function DashboardPage({ date: dateProp }: { date?: string }) {
  const [applied, setApplied] = useState(() => dateProp ?? readDashboardDate())
  const [draft, setDraft] = useState(applied)
  const [validationError, setValidationError] = useState<string | null>(null)
  const dateInput = useRef<HTMLInputElement | null>(null)
  useEffect(() => {
    if (dateProp === undefined) setDraft(applied)
  }, [applied, dateProp])
  const urlError = isValidCivilDate(applied) ? null : 'Data inválida. Use uma data civil no formato AAAA-MM-DD.'
  const query = useQuery({
    queryKey: ['dashboard', applied],
    queryFn: () => api<Dashboard & { bases: { sales: string; cash: string; pending: string } }>(`/dashboard?date=${applied}`),
    retry: false,
    enabled: urlError === null,
  })
  function apply(event: FormEvent) {
    event.preventDefault()
    if (!isValidCivilDate(draft)) {
      setValidationError('Data inválida. Use uma data civil no formato AAAA-MM-DD.')
      return
    }
    setValidationError(null)
    if (dateProp === undefined) {
      window.history.replaceState(null, '', `/inicio?date=${draft}`)
    }
    setApplied(draft)
    dateInput.current?.focus()
  }
  const subtitleDate = isValidCivilDate(applied) ? formatDate(applied) : applied
  return <Page title="Visão da operação" subtitle={`Referência ${subtitleDate}`}>
    {dateProp === undefined && <form className="panel inline-form" aria-label="Data de referência" onSubmit={apply}>
      <label className="field"><span>Data de referência</span><input ref={dateInput} type="date" value={draft} onChange={(event) => setDraft(event.target.value)} /></label>
      <button className="primary-button" type="submit">Aplicar data</button>
    </form>}
    {validationError && <Notice tone="danger">{validationError}</Notice>}
    {urlError !== null ? <Notice tone="danger">{urlError}</Notice>
      : query.isPending ? <PageState>Carregando visão da operação…</PageState> : query.isError ? <>
      <PageError error={query.error} />
      <button className="secondary-action" type="button" onClick={() => void query.refetch()}>Tentar novamente</button>
    </> : <DashboardBody data={query.data} />}
  </Page>
}

function DashboardBody({ data }: { data: Dashboard & { bases: { sales: string; cash: string; pending: string } } }) {
  return <>
    <section className="metrics" aria-label="Indicadores operacionais">
      <Metric label="Recebido hoje" value={formatMoney(data.confirmedPaymentsToday)} detail="Caixa por data de recebimento" tone="brand" />
      <Metric label="Vendas criadas hoje" value={formatMoney(data.salesCreatedToday)} detail="Base: data da venda" tone="neutral" />
      <Metric label="Pagamentos pendentes" value={String(data.pendingSalesCount)} detail={`${data.overdueSalesCount} vencida${data.overdueSalesCount === 1 ? '' : 's'}`} tone="warning" />
      <Metric label="Estoque crítico" value={String(data.lowStockVariants + data.outOfStockVariants)} detail={`${data.outOfStockVariants} sem saldo`} tone="danger" />
    </section>
    <details className="panel"><summary>Definições e bases</summary><dl>
      <dt>Data de referência</dt><dd>{data.date} ({data.timezone})</dd>
      <dt>Vendas</dt><dd>eventos pela base {data.bases.sales}; contagens de pendência refletem o estado atual (base {data.bases.pending}).</dd>
      <dt>Caixa</dt><dd>eventos pela base {data.bases.cash}.</dd>
    </dl></details>
    <nav className="panel compact-grid" aria-label="Trabalho em aberto">
      <a href="/vendas?status=open">Vendas em aberto: {data.pendingSalesCount} ({data.overdueSalesCount} vencidas)</a>
      <a href="/estoque?availability=low">Estoque baixo ou zerado: {data.lowStockVariants + data.outOfStockVariants} variantes</a>
      <a href="/compras">Compras abertas: {data.openPurchaseOrders} pedidos ({data.pendingPurchaseUnits} unidades a receber)</a>
      <a href="/encomendas">Encomendas em aberto: {data.openCustomerOrders}</a>
    </nav>
  </>
}

export function NewSalePage() {
  const client = useQueryClient()
  const [productSearch, setProductSearch] = useState('')
  const products = useQuery({
    queryKey: ['products', 'sale', productSearch],
    queryFn: () => api<{ items: Product[] }>(
      `/products?search=${encodeURIComponent(productSearch)}&limit=50`),
  })
  const [cart, setCart] = useState<CartItem[]>([])
  const [success, setSuccess] = useState(false)
  const [operation, setOperation] = useState<{ key: string; body: string } | null>(null)
  const [uncertain, setUncertain] = useState(false)
  const [persistError, setPersistError] = useState(false)
  const [validationError, setValidationError] = useState<string | null>(null)
  const [mode, setMode] = useState<SaleMode>('paid')
  const [customerId, setCustomerId] = useState<string | null>(null)
  const [customerName, setCustomerName] = useState('')
  const [customerSearch, setCustomerSearch] = useState('')
  const [showNewCustomer, setShowNewCustomer] = useState(false)
  const [dueDate, setDueDate] = useState('')
  const [payAmount, setPayAmount] = useState('')
  const [method, setMethod] = useState('pix')
  const [customerOp, setCustomerOp] = useState<{ key: string; body: string } | null>(null)
  const [customerUncertain, setCustomerUncertain] = useState(false)
  const [customerPersistError, setCustomerPersistError] = useState(false)
  const customers = useQuery({
    queryKey: ['customers', 'sale', customerSearch],
    queryFn: () => api<{ items: Array<{ id: string; name: string; contact: string | null }> }>(
      `/customers?search=${encodeURIComponent(customerSearch)}&limit=20`),
    enabled: customerSearch.trim().length >= 2,
    retry: false,
  })
  const total = useMemo(() => {
    try {
      return formatCentsToMoney(saleTotalCents(cart.map(({ salePrice, quantity }) => ({ salePrice, quantity }))))
    } catch {
      return '0.00'
    }
  }, [cart])
  const sale = useMutation({
    mutationFn: async (op: { key: string; body: string }) => {
      const result = await api<{ id: string }>('/sales', {
        method: 'POST', headers: idempotencyHeaders(op.key), body: op.body,
      })
      if (!result || typeof result.id !== 'string' || result.id.length === 0) {
        throw new UncertainResultError(201)
      }
      return result
    },
    onSuccess: async () => {
      setCart([]); setSuccess(true); setOperation(null); setUncertain(false); setPersistError(false); setValidationError(null)
      clearPendingSale()
      await client.invalidateQueries({ queryKey: ['sales'] })
      await client.invalidateQueries({ queryKey: ['products'] })
      await client.invalidateQueries({ queryKey: ['inventory'] })
      await client.invalidateQueries({ queryKey: ['dashboard'] })
      await client.invalidateQueries({ queryKey: ['financial-report'] })
      await client.invalidateQueries({ queryKey: ['product-report'] })
    },
    onError: (error) => {
      if (error instanceof TypeError || error instanceof UncertainResultError || (error instanceof ApiError && error.status >= 500)) {
        setUncertain(true)
        return
      }
      setUncertain(false)
      setOperation(null)
      clearPendingSale()
    },
  })
  const createCustomer = useMutation({
    mutationFn: (op: { key: string; body: string }) => api<{ id: string; name: string }>(
      '/customers', { method: 'POST', headers: idempotencyHeaders(op.key), body: op.body }),
    onSuccess: (customer) => {
      setCustomerId(customer.id)
      setCustomerName(customer.name)
      setCustomerSearch('')
      setShowNewCustomer(false)
      setValidationError(null)
      setCustomerOp(null)
      setCustomerUncertain(false)
      setCustomerPersistError(false)
      clearPendingCustomer()
    },
    onError: (error) => {
      if (error instanceof TypeError || error instanceof UncertainResultError || (error instanceof ApiError && error.status >= 500)) {
        setCustomerUncertain(true)
        return
      }
      setCustomerOp(null)
      setCustomerUncertain(false)
      clearPendingCustomer()
    },
  })
  const customerLocked = createCustomer.isPending || customerUncertain
  useEffect(() => {
    const pending = loadPendingCustomer()
    if (pending) {
      setCustomerOp({ key: pending.key, body: pending.body })
      setCustomerUncertain(true)
    }
  }, [])
  useEffect(() => {
    const pending = loadPendingSale()
    if (pending) {
      setCart(pending.cart)
      setOperation({ key: pending.key, body: pending.body })
      setUncertain(true)
      setMode(pending.context.mode)
      setCustomerId(pending.context.customerId)
      setCustomerName(pending.context.customerName)
      setDueDate(pending.context.dueDate)
      setPayAmount(pending.context.amount)
      if (pending.context.method !== '') setMethod(pending.context.method)
    }
  }, [])
  const locked = sale.isPending || uncertain
  function startSale() {
    if (locked) return
    setValidationError(null)
    if (cart.length === 0) return
    if ((mode === 'pending' || mode === 'partial') && !customerId) {
      setValidationError('Selecione ou cadastre um cliente para venda pendente ou parcial.')
      return
    }
    if ((mode === 'pending' || mode === 'partial') && dueDate === '') {
      setValidationError('Informe o vencimento para venda pendente ou parcial.')
      return
    }
    if ((mode === 'pending' || mode === 'partial') && dueDate <= localTodayIso()) {
      setValidationError('O vencimento deve ser uma data futura.')
      return
    }
    let payment: { amount: string; method: string } | undefined
    if (mode === 'paid') {
      payment = { amount: total, method }
    } else if (mode === 'partial') {
      if (!moneyPattern.test(payAmount)) {
        setValidationError('Valor inicial inválido. Use o formato 0.00.')
        return
      }
      try {
        if (moneyToCents(payAmount) <= 0n) {
          setValidationError('Valor inicial deve ser maior que zero.')
          return
        }
        if (moneyToCents(payAmount) >= moneyToCents(total)) {
          setValidationError('Valor inicial deve ser menor que o total; use Pago agora para quitar.')
          return
        }
      } catch {
        setValidationError('Valor inicial inválido. Use o formato 0.00.')
        return
      }
      payment = { amount: payAmount, method }
    }
    const body = JSON.stringify({
      items: cart.map(({ id, quantity }) => ({ variantId: id, quantity })),
      discountAmount: '0.00',
      ...(customerId ? { customerId } : {}),
      ...(mode === 'pending' || mode === 'partial' ? { paymentDueDate: dueDate } : {}),
      ...(payment ? { payment } : {}),
    })
    const op = { key: crypto.randomUUID(), body }
    const context: SaleContext = {
      mode, customerId, customerName,
      dueDate: mode === 'pending' || mode === 'partial' ? dueDate : '',
      amount: payment?.amount ?? '', method: payment ? method : '',
    }
    if (!savePendingSale({ ...op, cart, csrf: currentCsrfToken() ?? '', context })) {
      setPersistError(true)
      return
    }
    setPersistError(false)
    setOperation(op)
    setUncertain(false)
    sale.mutate(op)
  }
  function retry() {
    if (operation) sale.mutate(operation)
  }
  function add(product: Product, variant: Variant) {
    if (locked) return
    setPersistError(false)
    setValidationError(null)
    setSuccess(false)
    setCart((current) => {
      const item = current.find(({ id }) => id === variant.id)
      if (item) return current.map((entry) => entry.id === variant.id && entry.quantity < variant.stockQuantity ? { ...entry, quantity: entry.quantity + 1 } : entry)
      return [...current, { ...variant, label: `${product.club} ${product.model}`, quantity: 1 }]
    })
  }
  function submitCustomer(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (customerLocked) return
    const data = new FormData(event.currentTarget)
    const name = String(data.get('customerName') ?? '').trim()
    const contact = String(data.get('customerContact') ?? '').trim()
    if (name === '') {
      setValidationError('Informe o nome do cliente.')
      return
    }
    const body = JSON.stringify(contact === '' ? { name } : { name, contact })
    const op = { key: crypto.randomUUID(), body }
    if (!savePendingCustomer({ ...op, csrf: currentCsrfToken() ?? '' })) {
      setCustomerPersistError(true)
      return
    }
    setCustomerPersistError(false)
    setCustomerOp(op)
    setCustomerUncertain(false)
    createCustomer.mutate(op)
  }
  function retryCustomer() {
    if (customerOp) createCustomer.mutate(customerOp)
  }
  return <Page title="Nova venda" subtitle="O preço e o estoque serão recalculados pela API antes da confirmação.">
    {success && <Notice tone="success">Venda concluída</Notice>}
    {sale.isError && <PageError error={sale.error} />}
    {validationError && <Notice tone="danger">{validationError}</Notice>}
    {createCustomer.isError && <PageError error={createCustomer.error} />}
    {persistError && !sale.isPending && !uncertain && <Notice tone="danger">Não foi possível garantir a recuperação da venda após recarga; a venda não foi enviada. Tente novamente.</Notice>}
    {uncertain && !sale.isPending && <div className="panel"><p>Resposta da venda incerta. Não altere o carrinho.</p>
      <button className="primary-button" type="button" onClick={retry}>Tentar novamente</button></div>}
    <div className="split-layout">
      <section className="panel">
        <h2>Produtos disponíveis</h2>
        <label className="field"><span>Buscar produto</span>
          <input value={productSearch} autoFocus placeholder="Clube, modelo ou SKU" disabled={locked}
            onChange={(event) => setProductSearch(event.target.value)} /></label>
        {products.isPending ? <PageState>Buscando produtos…</PageState> : products.isError ? <>
          <PageError error={products.error} /><button className="secondary-action" type="button" onClick={() => void products.refetch()}>Buscar novamente</button>
        </> : products.data.items.length === 0 ? <PageState>Nenhum produto para esta busca.</PageState> :
          <div className="item-grid">{products.data.items.flatMap((product) => product.variants.map((variant) =>
            <button className="select-card" type="button" disabled={variant.stockQuantity === 0 || locked} key={variant.id}
              aria-label={`Adicionar ${product.club} ${product.model}, tamanho ${variant.size}`} onClick={() => add(product, variant)}>
              <strong>{product.club} · {product.model}</strong><span>{variant.type} · {variant.size} · {variant.sku}</span>
              <span>{formatMoney(variant.salePrice)} · saldo {variant.stockQuantity}</span>
            </button>))}</div>}
      </section>
      <aside className="panel cart" aria-label="Carrinho da venda">
        <h2>Carrinho</h2>
        {cart.length === 0 ? <p className="muted">Adicione um produto para começar.</p> : <ul className="plain-list">{cart.map((item) =>
          <li key={item.id}><span><strong>{item.label}</strong><small>{item.sku} · {item.quantity} un.</small></span><b>{formatMoney(formatCentsToMoney(saleTotalCents([{ salePrice: item.salePrice, quantity: item.quantity }])) )}</b></li>)}</ul>}
        <div className="total"><span>Total</span><strong>{formatMoney(total)}</strong></div>
        <fieldset className="panel" disabled={locked}>
          <legend>Modo da venda</legend>
          {(['paid', 'pending', 'partial'] as const).map((value) => <label className="field" key={value}>
            <input type="radio" name="saleMode" checked={mode === value} onChange={() => { setMode(value); setValidationError(null) }} />
            <span>{({ paid: 'Pago agora', pending: 'Pendente', partial: 'Parcialmente pago' })[value]}</span>
          </label>)}
        </fieldset>
        <fieldset className="panel" disabled={locked}>
          <legend>Cliente</legend>
          {customerId ? <p>Selecionado: {customerName || 'Consumidor Final'}{' '}
            <button className="secondary-action" type="button" onClick={() => { setCustomerId(null); setCustomerName('') }}>Trocar</button></p>
            : <p>Consumidor Final</p>}
          <label className="field"><span>Buscar cliente</span>
            <input value={customerSearch} autoFocus placeholder="Digite ao menos 2 letras"
              onChange={(event) => setCustomerSearch(event.target.value)} /></label>
          {customers.isPending ? <PageState>Buscando clientes…</PageState>
            : customers.isError ? <><PageError error={customers.error} /><button className="secondary-action" type="button" onClick={() => void customers.refetch()}>Buscar novamente</button></>
            : customers.data && (customers.data.items.length === 0 ? <p>Nenhum cliente para esta busca.</p> :
              <div>{customers.data.items.map((customer) => <label className="field" key={customer.id}>
                <input type="radio" name="customer" checked={customerId === customer.id}
                  onChange={() => { setCustomerId(customer.id); setCustomerName(customer.name); setValidationError(null) }} />
                <span>{customer.name}{customer.contact ? ` · ${customer.contact}` : ''}</span>
              </label>)}</div>)}
          <button className="secondary-action" type="button" onClick={() => setShowNewCustomer((value) => !value)}>
            {showNewCustomer ? 'Fechar cadastro' : 'Novo cliente'}</button>
          {showNewCustomer && <form className="form-grid" onSubmit={submitCustomer}>
            <Field label="Nome do cliente" name="customerName" required disabled={customerLocked} />
            <Field label="Contato" name="customerContact" disabled={customerLocked} />
            <button className="primary-button" disabled={customerLocked}>
              {createCustomer.isPending ? 'Cadastrando…' : 'Cadastrar cliente'}</button>
          </form>}
          {customerPersistError && !createCustomer.isPending && !customerUncertain
            && <Notice tone="danger">Não foi possível garantir a recuperação do cadastro após recarga; nada foi enviado. Tente novamente.</Notice>}
          {customerUncertain && !createCustomer.isPending && <div className="panel"><p>Resposta do cadastro incerta. Não altere os dados.</p>
            <button className="primary-button" type="button" onClick={retryCustomer}>Tentar novamente o cadastro</button></div>}
        </fieldset>
        {(mode === 'pending' || mode === 'partial') && <label className="field"><span>Vencimento</span>
          <input name="dueDate" type="date" value={dueDate} disabled={locked} required
            onChange={(event) => setDueDate(event.target.value)} /></label>}
        {(mode === 'paid' || mode === 'partial') && <>
          {mode === 'partial' && <label className="field"><span>Valor inicial</span>
            <input name="payAmount" value={payAmount} disabled={locked} placeholder="0.00" required
              onChange={(event) => setPayAmount(event.target.value)} /></label>}
          <label className="field"><span>Método</span><select name="method" value={method} disabled={locked}
            onChange={(event) => setMethod(event.target.value)}>
            <option value="pix">Pix</option><option value="cash">Dinheiro</option><option value="debit_card">Débito</option>
            <option value="credit_card">Crédito</option><option value="bank_transfer">Transferência</option><option value="other">Outro</option>
          </select></label>
        </>}
        <button className="primary-button" type="button" disabled={!cart.length || locked} onClick={startSale}>
          {sale.isPending ? 'Finalizando…' : 'Finalizar venda'}
        </button>
      </aside>
    </div>
  </Page>
}

type FinancialComparison = {
  period: { from: string; to: string; timezone: string }
  salesBySaleDate: string; confirmedPaymentsByReceiptDate: string; outstandingForPeriodSales: string
  historicalCostOfPeriodSales: string; grossProfitOnSalesBasis: string
  grossMarginPercentOnSalesBasis: string; averageTicketOnSalesBasis: string
  paymentsByMethod: Array<{ method: string; amount: string }>
}
type FinancialReport = {
  period: { from: string; to: string; timezone: string }
  bases: { sales: string; cash: string }
  salesBySaleDate: string; confirmedPaymentsByReceiptDate: string; outstandingForPeriodSales: string
  historicalCostOfPeriodSales?: string; grossProfitOnSalesBasis?: string; grossMarginPercentOnSalesBasis?: string
  averageTicketOnSalesBasis?: string; inventoryCostValue?: string; inventoryPotentialValue?: string
  openPurchaseCapital?: string; paymentsByMethod?: Array<{ method: string; amount: string }>
  comparison?: FinancialComparison
  dailySeries?: Array<{ date: string; salesBySaleDate: string; confirmedPaymentsByReceiptDate: string }>
  receivables?: Array<{ saleId: string; customerDisplay: string; dueDate: string | null; amountDue: string; overdue: boolean }>
  receivablesBasis?: string; overdueAsOf?: string; updatedAt?: string
}

const civilDatePattern = /^\d{4}-\d{2}-\d{2}$/
const maxReportDays = 366
const minCivilDate = '0001-01-01'
const maxCivilDate = '9999-12-31'

function parseCivilDateExact(value: string): number | null {
  if (!civilDatePattern.test(value)) return null
  const year = Number(value.slice(0, 4))
  const month = Number(value.slice(5, 7))
  const day = Number(value.slice(8, 10))
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  const check = new Date(0)
  check.setUTCFullYear(year, month - 1, day)
  check.setUTCHours(0, 0, 0, 0)
  const roundTrip = `${String(check.getUTCFullYear()).padStart(4, '0')}-${String(check.getUTCMonth() + 1).padStart(2, '0')}-${String(check.getUTCDate()).padStart(2, '0')}`
  return roundTrip === value ? check.getTime() : null
}

function formatCivilTime(time: number): string {
  const check = new Date(time)
  return `${String(check.getUTCFullYear()).padStart(4, '0')}-${String(check.getUTCMonth() + 1).padStart(2, '0')}-${String(check.getUTCDate()).padStart(2, '0')}`
}

function inclusiveReportDays(fromTime: number, toTime: number): number {
  return Math.round((toTime - fromTime) / 86_400_000) + 1
}

function previousReportFrom(fromTime: number, days: number): string {
  return formatCivilTime(fromTime - days * 86_400_000)
}

export function validateReportPeriod(from: string, to: string): string | null {
  const fromTime = parseCivilDateExact(from)
  const toTime = parseCivilDateExact(to)
  if (fromTime === null || toTime === null) return 'Período inválido. Use datas no formato AAAA-MM-DD.'
  if (from > to) return 'O início deve ser anterior ou igual ao fim.'
  if (from < minCivilDate || to > maxCivilDate) return 'Período fora da faixa suportada (de 0001-01-01 a 9999-12-31).'
  const days = inclusiveReportDays(fromTime, toTime)
  if (days > maxReportDays) return 'O período deve ter no máximo 366 dias.'
  if (previousReportFrom(fromTime, days) < minCivilDate) return 'Período fora da faixa suportada (o período anterior ficaria antes de 0001-01-01).'
  return null
}

function readReportFilters(): { from: string; to: string; compare: boolean } {
  const defaults = currentMonth()
  const params = new URLSearchParams(window.location.search)
  return {
    from: params.get('from') ?? defaults.from,
    to: params.get('to') ?? defaults.to,
    compare: params.get('compare') === 'true',
  }
}

export function FinancialReportPage() {
  const [applied, setApplied] = useState(readReportFilters)
  const [draftFrom, setDraftFrom] = useState(applied.from)
  const [draftTo, setDraftTo] = useState(applied.to)
  const [draftCompare, setDraftCompare] = useState(applied.compare)
  const [validationError, setValidationError] = useState<string | null>(null)
  useEffect(() => {
    setDraftFrom(applied.from)
    setDraftTo(applied.to)
    setDraftCompare(applied.compare)
  }, [applied])
  const path = `/reports/financial?from=${applied.from}&to=${applied.to}${applied.compare ? '&compare=true' : ''}`
  const urlError = validateReportPeriod(applied.from, applied.to)
  const query = useQuery({
    queryKey: ['financial-report', applied.from, applied.to, applied.compare ? 'compare' : 'current'],
    queryFn: () => api<FinancialReport>(path),
    retry: false,
    enabled: urlError === null,
  })
  function apply(event: FormEvent) {
    event.preventDefault()
    const error = validateReportPeriod(draftFrom, draftTo)
    if (error) {
      setValidationError(error)
      return
    }
    setValidationError(null)
    const params = new URLSearchParams()
    params.set('from', draftFrom)
    params.set('to', draftTo)
    if (draftCompare) params.set('compare', 'true')
    window.history.replaceState(null, '', `/relatorios/financeiro?${params.toString()}`)
    setApplied({ from: draftFrom, to: draftTo, compare: draftCompare })
  }
  const subtitleRange = parseCivilDateExact(applied.from) !== null && parseCivilDateExact(applied.to) !== null
    ? `${formatDate(applied.from)} a ${formatDate(applied.to)}`
    : `${applied.from} a ${applied.to}`
  return <Page title="Relatório financeiro" subtitle={`${subtitleRange} · bases separadas e explícitas`}>
    <form className="panel inline-form" aria-label="Período do relatório" onSubmit={apply}>
      <label className="field"><span>Início</span><input type="date" value={draftFrom} onChange={(event) => setDraftFrom(event.target.value)} /></label>
      <label className="field"><span>Fim</span><input type="date" value={draftTo} onChange={(event) => setDraftTo(event.target.value)} /></label>
      <label className="field"><span>Comparar com período anterior</span><input type="checkbox" checked={draftCompare} onChange={(event) => setDraftCompare(event.target.checked)} /></label>
      <button className="primary-button" type="submit">Aplicar período</button>
    </form>
    {validationError && <Notice tone="danger">{validationError}</Notice>}
    {urlError !== null ? <Notice tone="danger">{urlError}</Notice>
      : query.isPending ? <PageState>Carregando relatório…</PageState> : query.isError ? <>
      <PageError error={query.error} />
      <button className="secondary-action" type="button" onClick={() => void query.refetch()}>Tentar novamente</button>
    </> : <FinancialReportBody report={query.data} compare={applied.compare} />}
  </Page>
}

function FinancialReportBody({ report, compare }: { report: FinancialReport; compare: boolean }) {
  const methods = report.paymentsByMethod ?? []
  const series = report.dailySeries ?? []
  const receivables = report.receivables ?? []
  const isEmpty = report.salesBySaleDate === '0.00' && report.confirmedPaymentsByReceiptDate === '0.00'
    && methods.length === 0 && receivables.length === 0
  const seriesIsEmpty = series.length === 0 || series.every((d) => d.salesBySaleDate === '0.00' && d.confirmedPaymentsByReceiptDate === '0.00')
  return <>
    <p className="muted">Vendas pela data da venda · Recebimentos pela data do recebimento · {report.period.timezone} · relatório gerencial, não contábil/fiscal.</p>
    <section className="metrics">
      <Metric label="Vendas pela data da venda" value={formatMoney(report.salesBySaleDate)} detail="Soma do valor final das vendas criadas no período" tone="brand" />
      <Metric label="Recebimentos pela data do recebimento" value={formatMoney(report.confirmedPaymentsByReceiptDate)} detail="Soma dos pagamentos confirmados recebidos no período" tone="neutral" />
      <Metric label="Saldo pendente" value={formatMoney(report.outstandingForPeriodSales)} detail="Total das vendas do período menos pagamentos confirmados" tone="warning" />
      <Metric label="Custo histórico" value={formatMoney(report.historicalCostOfPeriodSales ?? '0.00')} detail="Custo dos itens vendidos no período" tone="neutral" />
      <Metric label="Lucro bruto" value={formatMoney(report.grossProfitOnSalesBasis ?? '0.00')} detail={`Vendas menos custo · margem ${report.grossMarginPercentOnSalesBasis ?? '0.00'}%`} tone="brand" />
      <Metric label="Ticket médio" value={formatMoney(report.averageTicketOnSalesBasis ?? '0.00')} detail="Vendas divididas pelo número de vendas do período" tone="neutral" />
      <Metric label="Estoque a custo" value={formatMoney(report.inventoryCostValue ?? '0.00')} detail="Saldo × custo atual" tone="neutral" />
      <Metric label="Estoque potencial" value={formatMoney(report.inventoryPotentialValue ?? '0.00')} detail="Saldo × preço atual" tone="neutral" />
      <Metric label="Capital em compras" value={formatMoney(report.openPurchaseCapital ?? '0.00')} detail="Custo pendente de recebimento" tone="warning" />
    </section>
    <details className="panel"><summary>Definições e bases</summary><dl>
      <dt>Vendas pela data da venda</dt><dd>soma do valor final das vendas criadas no período.</dd>
      <dt>Recebimentos pela data do recebimento</dt><dd>soma dos pagamentos confirmados recebidos no período.</dd>
      <dt>Base de vendas</dt><dd>{report.bases.sales}</dd>
      <dt>Base de caixa</dt><dd>{report.bases.cash}</dd>
      <dt>Fuso</dt><dd>{report.period.timezone}</dd>
      {report.updatedAt && <><dt>Atualizado em</dt><dd>{report.updatedAt}</dd></>}
    </dl></details>
    {compare && report.comparison && <section className="panel"><h2>Período anterior ({formatDate(report.comparison.period.from)} a {formatDate(report.comparison.period.to)})</h2>
      <p>Vendas {formatMoney(report.comparison.salesBySaleDate)} · Recebimentos {formatMoney(report.comparison.confirmedPaymentsByReceiptDate)} · Pendente {formatMoney(report.comparison.outstandingForPeriodSales)}</p>
    </section>}
    <section className="panel"><h2>Recebimentos por método de pagamento</h2>
      {methods.length === 0 ? <p>Nenhum recebimento por método no período.</p> :
        <div className="table-wrap"><table><thead><tr><th>Método</th><th>Valor</th></tr></thead><tbody>
          {methods.map((row) => <tr key={row.method}><td>{row.method}</td><td>{formatMoney(row.amount)}</td></tr>)}
        </tbody></table></div>}
    </section>
    <section className="panel"><h2>Série diária</h2>
      {isEmpty || seriesIsEmpty ? <p>Nenhum movimento no período selecionado ({formatDate(report.period.from)} a {formatDate(report.period.to)}). A tabela abaixo mostra zeros para não sugerir dias ausentes.</p> : null}
      {series.length === 0 ? <p>Nenhum movimento no período.</p> :
        <div className="table-wrap"><table><thead><tr><th>Data</th><th>Vendas</th><th>Recebimentos</th></tr></thead><tbody>
          {series.map((row) => <tr key={row.date}><td>{row.date}</td><td>{formatMoney(row.salesBySaleDate)}</td><td>{formatMoney(row.confirmedPaymentsByReceiptDate)}</td></tr>)}
        </tbody></table></div>}
    </section>
    <section className="panel"><h2>Contas a receber do período</h2>
      <p className="muted">Base: {report.receivablesBasis ?? 'vendas criadas no período com saldo em aberto'} · situação de vencimento apurada em {report.overdueAsOf ?? report.period.to}.</p>
      {receivables.length === 0 ? <p>Nenhuma conta a receber no período.</p> :
        <div className="table-wrap"><table><thead><tr><th>Cliente</th><th>Vencimento</th><th>Valor devido</th><th>Situação</th></tr></thead><tbody>
          {receivables.map((row) => <tr key={row.saleId}><td><a href={`/vendas/${row.saleId}`}>{row.customerDisplay}</a></td>
            <td>{row.dueDate ?? '—'}</td><td>{formatMoney(row.amountDue)}</td><td>{row.overdue ? 'Vencida' : 'A vencer'}</td></tr>)}
        </tbody></table></div>}
    </section>
  </>
}

type ProductReportItem = {
  variantId: string; club: string; model: string; type: string; size: string; sku: string
  currentStockQuantity: number; lowStockThreshold: number; unitsSold: string
  salesAmount: string; historicalCost: string; grossProfit: string
  noTurnover: boolean; lowStock: boolean
}
type ProductReportShare = { name: string; unitsSold: string; salesAmount: string; sharePercent: string }
type ProductReport = {
  period: { from: string; to: string; timezone: string }
  filters: { club: string | null; type: string | null; size: string | null }
  timezone: string
  bases: { sales: string; stock: string }
  items: ProductReportItem[]
  summary: {
    variantCount: number; totalUnitsSold: string; totalSalesAmount: string; totalGrossProfit: string
    noTurnoverCount: number; lowStockCount: number
    salesByClub: ProductReportShare[]; salesByType: ProductReportShare[]; salesBySize: ProductReportShare[]
  }
  updatedAt: string
  stockAsOf: string
}
type ProductReportFilters = { from: string; to: string; club: string; type: string; size: string }

function readProductReportFilters(): ProductReportFilters {
  const defaults = currentMonth()
  const params = new URLSearchParams(window.location.search)
  return {
    from: params.get('from') ?? defaults.from,
    to: params.get('to') ?? defaults.to,
    club: params.get('club') ?? '',
    type: params.get('type') ?? '',
    size: params.get('size') ?? '',
  }
}

function productReportPath(filters: ProductReportFilters): string {
  const params = new URLSearchParams()
  params.set('from', filters.from)
  params.set('to', filters.to)
  if (filters.club !== '') params.set('club', filters.club)
  if (filters.type !== '') params.set('type', filters.type)
  if (filters.size !== '') params.set('size', filters.size)
  return `/reports/products?${params.toString()}`
}

export function ProductReportPage() {
  const [applied, setApplied] = useState(readProductReportFilters)
  const [draft, setDraft] = useState(applied)
  const [validationError, setValidationError] = useState<string | null>(null)
  useEffect(() => {
    setDraft(applied)
  }, [applied])
  const urlError = validateReportPeriod(applied.from, applied.to)
  const query = useQuery({
    queryKey: ['product-report', applied.from, applied.to, applied.club, applied.type, applied.size],
    queryFn: () => api<ProductReport>(productReportPath(applied)),
    retry: false,
    enabled: urlError === null,
  })
  function setPatch(patch: Partial<ProductReportFilters>) {
    setDraft((current) => ({ ...current, ...patch }))
  }
  function apply(event: FormEvent) {
    event.preventDefault()
    const error = validateReportPeriod(draft.from, draft.to)
    if (error) {
      setValidationError(error)
      return
    }
    setValidationError(null)
    const next = { ...draft }
    const params = new URLSearchParams()
    params.set('from', next.from)
    params.set('to', next.to)
    if (next.club !== '') params.set('club', next.club)
    if (next.type !== '') params.set('type', next.type)
    if (next.size !== '') params.set('size', next.size)
    window.history.replaceState(null, '', `/relatorios/produtos?${params.toString()}`)
    setApplied(next)
  }
  function clear() {
    const defaults = currentMonth()
    const next = { from: defaults.from, to: defaults.to, club: '', type: '', size: '' }
    window.history.replaceState(null, '', '/relatorios/produtos')
    setValidationError(null)
    setApplied(next)
  }
  const subtitleRange = parseCivilDateExact(applied.from) !== null && parseCivilDateExact(applied.to) !== null
    ? `${formatDate(applied.from)} a ${formatDate(applied.to)}`
    : `${applied.from} a ${applied.to}`
  return <Page title="Relatório de produtos" subtitle={subtitleRange}>
    <form className="panel inline-form" aria-label="Filtros do relatório de produtos" onSubmit={apply}>
      <label className="field"><span>Início</span><input type="date" value={draft.from} onChange={(event) => setPatch({ from: event.target.value })} /></label>
      <label className="field"><span>Fim</span><input type="date" value={draft.to} onChange={(event) => setPatch({ to: event.target.value })} /></label>
      <label className="field"><span>Clube</span><input value={draft.club} placeholder="Todos os clubes" onChange={(event) => setPatch({ club: event.target.value })} /></label>
      <label className="field"><span>Tipo</span><input value={draft.type} placeholder="Todos os tipos" onChange={(event) => setPatch({ type: event.target.value })} /></label>
      <label className="field"><span>Tamanho</span><input value={draft.size} placeholder="Todos os tamanhos" onChange={(event) => setPatch({ size: event.target.value })} /></label>
      <button className="primary-button" type="submit">Aplicar filtros</button>
      {(applied.club !== '' || applied.type !== '' || applied.size !== '') && <button className="secondary-action" type="button" onClick={clear}>Limpar filtros</button>}
    </form>
    {validationError && <Notice tone="danger">{validationError}</Notice>}
    {urlError !== null ? <Notice tone="danger">{urlError}</Notice>
      : query.isPending ? <PageState>Carregando relatório…</PageState> : query.isError ? <>
      <PageError error={query.error} />
      <button className="secondary-action" type="button" onClick={() => void query.refetch()}>Tentar novamente</button>
    </> : <ProductReportBody report={query.data} />}
  </Page>
}

function ProductReportBody({ report }: { report: ProductReport }) {
  const summary = report.summary
  const filtered = report.filters.club !== null || report.filters.type !== null || report.filters.size !== null
  return <>
    <p className="muted">Receita e lucro usam snapshots históricos dos itens vendidos no período ({report.period.timezone}); saldo é a posição atual.</p>
    <section className="metrics">
      <Metric label="Unidades vendidas" value={String(summary.totalUnitsSold)} detail="Soma das quantidades no período" tone="brand" />
      <Metric label="Receita" value={formatMoney(summary.totalSalesAmount)} detail="Snapshots históricos" tone="brand" />
      <Metric label="Lucro bruto" value={formatMoney(summary.totalGrossProfit)} detail="Receita menos custo histórico" tone="neutral" />
      <Metric label="Variantes sem giro" value={String(summary.noTurnoverCount)} detail="Ativas sem venda no período" tone="warning" />
      <Metric label="Estoque baixo" value={String(summary.lowStockCount)} detail="Saldo positivo até o limite" tone="warning" />
    </section>
    <details className="panel"><summary>Definições e bases</summary><dl>
      <dt>Receita e lucro</dt><dd>usam snapshots históricos dos itens vendidos no período (base {report.bases.sales}).</dd>
      <dt>Saldo</dt><dd>é a posição atual de cada variante (base {report.bases.stock}), apurada em {report.stockAsOf}.</dd>
      <dt>Fuso</dt><dd>{report.period.timezone}</dd>
      <dt>Atualizado em</dt><dd>{report.updatedAt}</dd>
    </dl></details>
    <section className="panel"><h2>Mais vendidos por clube</h2>
      {summary.salesByClub.length === 0 ? <p>Nenhuma venda por clube no período.</p> :
        <div className="table-wrap"><table><thead><tr><th>Clube</th><th>Unidades</th><th>Receita</th><th>Participação</th></tr></thead><tbody>
          {summary.salesByClub.map((row) => <tr key={row.name}><td>{row.name}</td><td>{row.unitsSold}</td><td>{formatMoney(row.salesAmount)}</td><td>{row.sharePercent}%</td></tr>)}
        </tbody></table></div>}
    </section>
    <section className="panel"><h2>Mais vendidos por tipo</h2>
      {summary.salesByType.length === 0 ? <p>Nenhuma venda por tipo no período.</p> :
        <div className="table-wrap"><table><thead><tr><th>Tipo</th><th>Unidades</th><th>Receita</th><th>Participação</th></tr></thead><tbody>
          {summary.salesByType.map((row) => <tr key={row.name}><td>{row.name}</td><td>{row.unitsSold}</td><td>{formatMoney(row.salesAmount)}</td><td>{row.sharePercent}%</td></tr>)}
        </tbody></table></div>}
    </section>
    <section className="panel"><h2>Mais vendidos por tamanho</h2>
      {summary.salesBySize.length === 0 ? <p>Nenhuma venda por tamanho no período.</p> :
        <div className="table-wrap"><table><thead><tr><th>Tamanho</th><th>Unidades</th><th>Receita</th><th>Participação</th></tr></thead><tbody>
          {summary.salesBySize.map((row) => <tr key={row.name}><td>{row.name}</td><td>{row.unitsSold}</td><td>{formatMoney(row.salesAmount)}</td><td>{row.sharePercent}%</td></tr>)}
        </tbody></table></div>}
    </section>
    <section className="panel"><h2>Detalhamento por variante</h2>
      {report.items.length === 0
        ? (filtered
          ? <p>Nenhuma variante para estes filtros.<button className="secondary-action" type="button" onClick={() => window.location.assign('/relatorios/produtos')}>Limpar filtros</button></p>
          : <p>Nenhuma variante ativa cadastrada.</p>)
        : <div className="table-wrap"><table><thead><tr><th>Produto</th><th>Variante</th><th>Saldo</th><th>Vendidas</th><th>Receita</th><th>Lucro bruto</th><th>Situação</th></tr></thead><tbody>
          {report.items.map((row) => <tr key={row.variantId}>
            <td>{row.club} · {row.model}</td><td>{row.type} · {row.size} · {row.sku}</td>
            <td>{row.currentStockQuantity}</td><td>{row.unitsSold}</td>
            <td>{formatMoney(row.salesAmount)}</td><td>{formatMoney(row.grossProfit)}</td>
            <td>{[row.noTurnover ? 'Sem giro' : null, row.lowStock ? 'Estoque baixo' : null].filter(Boolean).join(' · ') || '—'}</td>
          </tr>)}
        </tbody></table></div>}
    </section>
  </>
}

type CatalogFilters = { search: string; club: string; type: string; size: string; image: string; page: number }

const catalogPageSize = 50

function readCatalogPage(): number {
  const raw = new URLSearchParams(window.location.search).get('page') ?? ''
  if (!/^\d+$/.test(raw)) return 1
  const page = Number(raw)
  return Number.isSafeInteger(page) && page >= 1 ? page : 1
}

function readCatalogFilters(): CatalogFilters {
  const params = new URLSearchParams(window.location.search)
  return {
    search: params.get('search') ?? '',
    club: params.get('club') ?? '',
    type: params.get('type') ?? '',
    size: params.get('size') ?? '',
    image: params.get('image') ?? '',
    page: readCatalogPage(),
  }
}

function catalogSearchParams(filters: CatalogFilters): string {
  const params = new URLSearchParams()
  if (filters.search !== '') params.set('search', filters.search)
  if (filters.club !== '') params.set('club', filters.club)
  if (filters.type !== '') params.set('type', filters.type)
  if (filters.size !== '') params.set('size', filters.size)
  if (filters.image !== '') params.set('image', filters.image)
  params.set('availability', 'in_stock')
  params.set('page', String(filters.page))
  params.set('limit', String(catalogPageSize))
  return params.toString()
}

export function CatalogPage() {
  const [applied, setApplied] = useState(readCatalogFilters)
  const [draft, setDraft] = useState(applied)
  const searchInput = useRef<HTMLInputElement | null>(null)
  const session = useQuery({ queryKey: ['session'], queryFn: () => api<SessionInfo>('/auth/session'), retry: false, staleTime: 30_000 })
  const canWriteCatalog = session.data?.permissions.includes('*') === true || session.data?.permissions.includes('catalog:write') === true
  useEffect(() => {
    setDraft(applied)
  }, [applied])
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    if ((params.get('page') !== null && readCatalogPage() === 1) || params.has('availability')) {
      if (readCatalogPage() === 1) params.delete('page')
      params.delete('availability')
      const suffix = params.toString()
      window.history.replaceState(null, '', `/catalogo${suffix === '' ? '' : `?${suffix}`}`)
    }
  }, [])
  const query = useQuery({
    queryKey: ['catalog', applied.search, applied.club, applied.type, applied.size, applied.image, applied.page],
    queryFn: () => api<{ items: Product[]; total: number; page: number; limit: number }>(`/catalog?${catalogSearchParams(applied)}`),
    retry: false,
  })
  function setPatch(patch: Partial<CatalogFilters>) {
    setDraft((current) => ({ ...current, ...patch }))
  }
  function writeUrl(filters: CatalogFilters) {
    const params = new URLSearchParams()
    if (filters.search !== '') params.set('search', filters.search)
    if (filters.club !== '') params.set('club', filters.club)
    if (filters.type !== '') params.set('type', filters.type)
    if (filters.size !== '') params.set('size', filters.size)
    if (filters.image !== '') params.set('image', filters.image)
    if (filters.page !== 1) params.set('page', String(filters.page))
    const suffix = params.toString()
    window.history.replaceState(null, '', `/catalogo${suffix === '' ? '' : `?${suffix}`}`)
  }
  function apply(event: FormEvent) {
    event.preventDefault()
    const next = { ...draft, page: 1 }
    writeUrl(next)
    setApplied(next)
    searchInput.current?.focus()
  }
  function clear() {
    window.history.replaceState(null, '', '/catalogo')
    setApplied({ search: '', club: '', type: '', size: '', image: '', page: 1 })
  }
  function goToPage(page: number) {
    const next = { ...applied, page }
    writeUrl(next)
    setApplied(next)
  }
  const filtered = applied.search !== '' || applied.club !== '' || applied.type !== '' || applied.size !== '' || applied.image !== ''
  const total = query.data?.total ?? 0
  const envelopeLimit = query.data?.limit
  const pageSize = typeof envelopeLimit === 'number' && Number.isInteger(envelopeLimit) && envelopeLimit > 0
    ? envelopeLimit
    : catalogPageSize
  const envelopePage = query.data?.page
  const currentPage = typeof envelopePage === 'number' && Number.isInteger(envelopePage) && envelopePage >= 1
    ? envelopePage
    : applied.page
  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const clampPage = (page: number): number => Math.min(Math.max(1, page), totalPages)
  const prevPage = clampPage(currentPage - 1)
  const nextPage = clampPage(currentPage + 1)
  return <Page title="Catálogo" subtitle="Produtos disponíveis para venda.">
    {canWriteCatalog && <CatalogSyncPanel />}
    <form className="panel inline-form" role="search" aria-label="Filtros do catálogo" onSubmit={apply}>
      <label className="field"><span>Busca</span><input ref={searchInput} value={draft.search} placeholder="Clube, modelo ou SKU" onChange={(event) => setPatch({ search: event.target.value })} /></label>
      <label className="field"><span>Clube</span><input value={draft.club} placeholder="Todos os clubes" onChange={(event) => setPatch({ club: event.target.value })} /></label>
      <label className="field"><span>Tipo</span><select value={draft.type} onChange={(event) => setPatch({ type: event.target.value })}>
        <option value="">Todos</option><option value="Masculina">Masculina</option><option value="Feminina">Feminina</option><option value="Infantil">Infantil</option>
      </select></label>
      <label className="field"><span>Tamanho</span><input value={draft.size} placeholder="Todos os tamanhos" onChange={(event) => setPatch({ size: event.target.value })} /></label>
      <label className="field"><span>Imagem</span><select value={draft.image} onChange={(event) => setPatch({ image: event.target.value })}>
        <option value="">Todas</option><option value="with">Com imagem</option><option value="without">Sem imagem</option>
      </select></label>
      <button className="primary-button" type="submit">Aplicar filtros</button>
      {filtered && <button className="secondary-action" type="button" onClick={clear}>Limpar filtros</button>}
    </form>
    {query.isPending ? <PageState>Carregando catálogo…</PageState> : query.isError ? <>
      <PageError error={query.error} />
      <button className="secondary-action" type="button" onClick={() => void query.refetch()}>Tentar novamente</button>
    </> : <>
      {query.data.items.length === 0 && <section className="panel page-state" role="status">
        {filtered
          ? <p>Nenhum produto para estes filtros. Use Limpar filtros acima para ver todos.</p>
          : currentPage > 1
            ? <><p>Nenhum produto nesta página.</p><button className="secondary-action" type="button" onClick={() => goToPage(totalPages)}>Voltar para página válida</button></>
            : <p>Nenhum produto com estoque disponível.</p>}
      </section>}
      {query.data.items.length > 0 && <div className="catalog-grid">{query.data.items.map((product) => <CatalogCard key={product.id} product={product} canWrite={canWriteCatalog} />)}</div>}
      {(totalPages > 1 || applied.page > 1) && <nav className="panel" aria-label="Paginação">
        <span>Página {currentPage} de {totalPages} · {total} registro(s)</span>{' '}
        <button className="secondary-action" type="button" disabled={currentPage <= 1} onClick={() => goToPage(prevPage)}>Anterior</button>{' '}
        <button className="secondary-action" type="button" disabled={currentPage >= totalPages} onClick={() => goToPage(nextPage)}>Próxima</button>
      </nav>}
    </>}
  </Page>
}

type CatalogImageResponse = {
  id: string; productId: string; url: string; originalName: string
  mimeType: string; byteSize: number; deduplicated: boolean
}

function CatalogProductVisual({ product }: { product: Product }) {
  const [failed, setFailed] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  if (product.hasImage && product.mediaId && !failed) {
    return <div className="catalog-card-media">
      <img
        key={reloadKey}
        className="catalog-image"
        src={`/api/catalog/media/${product.mediaId}`}
        alt={`Imagem: ${product.club} ${product.model}`}
        onError={() => setFailed(true)}
      />
      <small>Imagem</small>
    </div>
  }
  if (failed) {
    return <div className="catalog-card-media catalog-card-media-placeholder">
      <div className="image-placeholder" role="img" aria-label={`Imagem indisponível: ${product.club} ${product.model}`}>{product.club.slice(0, 2).toUpperCase()}</div>
      <p role="status">Falha ao carregar a imagem.</p>
      <button className="secondary-action" type="button" onClick={() => { setReloadKey((key) => key + 1); setFailed(false) }}>Recarregar imagem</button>
    </div>
  }
  const label = product.hasImage ? `Com imagem: ${product.club} ${product.model}` : `Sem imagem: ${product.club} ${product.model}`
  return <div className="catalog-card-media catalog-card-media-placeholder">
    <div className="image-placeholder" role="img" aria-label={label}>{product.club.slice(0, 2).toUpperCase()}</div>
    <small>{product.hasImage ? 'Imagem' : 'Sem imagem'}</small>
  </div>
}

function CatalogCard({ product, canWrite }: { product: Product; canWrite: boolean }) {
  const client = useQueryClient()
  const [pickedFile, setPickedFile] = useState<File | null>(null)
  const upload = useMutation({
    mutationFn: (file: File) => apiUpload<CatalogImageResponse>(`/catalog/images?productId=${product.id}`, file),
    onSuccess: async () => {
      setPickedFile(null)
      await client.invalidateQueries({ queryKey: ['catalog'] })
    },
  })
  function pick(files: FileList | null) {
    const file = files?.[0]
    if (!file) return
    setPickedFile(file)
    upload.mutate(file)
  }
  return <article className="panel catalog-card">
    <CatalogProductVisual product={product} />
    <div className="catalog-card-content">
      <header><p className="catalog-card-club">{product.club}</p><h2>{product.model}</h2></header>
      <p className="catalog-card-stock">{product.totalStock ?? 0} unid. em estoque · {product.variants.length} {product.variants.length === 1 ? 'tam.' : 'tamanhos'}</p>
      {canWrite && <div className="catalog-card-management">
      <label className="catalog-upload">
        <input
          type="file"
          accept="image/jpeg,image/png,image/webp"
          aria-label={`Enviar imagem de ${product.club} ${product.model}`}
          disabled={upload.isPending}
          onChange={(event) => { pick(event.target.files); event.target.value = '' }}
        />
        <span>{product.hasImage ? 'Trocar imagem' : 'Adicionar imagem'}</span>
      </label>
      {upload.isPending && <p role="status">Enviando imagem…</p>}
      {upload.isError && <div><PageError error={upload.error} />
        <button className="secondary-action" type="button" disabled={pickedFile === null} onClick={() => { if (pickedFile) upload.mutate(pickedFile) }}>Tentar novamente</button>
      </div>}
      </div>}
      <a className="catalog-card-link" href={`/estoque/produtos/${product.id}`}>Abrir estoque</a>
    </div>
  </article>
}

type CatalogPublishResponse = {
  status: 'completed' | 'partial'
  created: number
  updated: number
  removed: number
  pendingWithoutImage: number
  errors: string[]
}

type CatalogPublishPreviewItem = {
  productName: string
  club: string
  model: string
  type: string
  sizes: string
  status: 'OK' | 'DESATUALIZADO' | 'SEM_IMAGEM' | 'ORFAO'
  hasLocalImage: boolean
}

type CatalogPublishJob = {
  jobId: string
  status: 'running' | 'completed' | 'failed'
  current: number
  total: number
  message: string
  result?: CatalogPublishResponse
  error?: string
}

const catalogPublishStatusLabels: Record<CatalogPublishPreviewItem['status'], string> = {
  OK: 'Sincronizado',
  DESATUALIZADO: 'Desatualizado',
  SEM_IMAGEM: 'Pendente no Drive',
  ORFAO: 'Será removido',
}

function CatalogSyncPanel() {
  const [jobId, setJobId] = useState<string | null>(null)
  const preview = useQuery({
    queryKey: ['catalog-publish-preview'],
    queryFn: () => api<{ items: CatalogPublishPreviewItem[] }>('/catalog/publish/preview'),
    retry: false,
  })
  const start = useMutation({
    mutationFn: () => api<CatalogPublishJob>('/catalog/publish/jobs', { method: 'POST' }),
    onSuccess: (job) => setJobId(job.jobId),
  })
  const job = useQuery({
    queryKey: ['catalog-publish-job', jobId],
    queryFn: () => api<CatalogPublishJob>(`/catalog/publish/jobs/${jobId}`),
    enabled: jobId !== null,
    retry: false,
    refetchInterval: (query) => query.state.data?.status === 'running' ? 250 : false,
  })
  const jobData = job.data
  const running = start.isPending || jobData?.status === 'running'
  const result = jobData?.status === 'completed' ? jobData.result ?? null : null
  const items = [...(preview.data?.items ?? [])]
    .filter((item) => item.status in catalogPublishStatusLabels)
    .sort((left, right) => Number(left.status === 'OK') - Number(right.status === 'OK'))
  const synchronized = items.filter((item) => item.status === 'OK').length
  const pending = items.length - synchronized
  const withoutImage = items.filter((item) => !item.hasLocalImage && item.status !== 'ORFAO').length

  useEffect(() => {
    if (jobData?.status === 'completed') void preview.refetch()
  }, [jobData?.status, jobData?.jobId])

  return <section className="panel catalog-sync-panel" aria-label="Sincronização do catálogo">
    <div className="catalog-sync-heading">
      <div><h2>Sincronização do catálogo</h2>
        <p className="muted">Compare o ERP com o Google Drive antes de publicar.</p></div>
      <button className="secondary-action" type="button" disabled={preview.isFetching || running} onClick={() => void preview.refetch()}>
        {preview.isFetching ? 'Comparando…' : 'Atualizar prévia'}
      </button>
    </div>

    {preview.isPending ? <p role="status">Comparando ERP e Google Drive…</p> : preview.isError ? <div><PageError error={preview.error} />
      <button className="secondary-action" type="button" onClick={() => void preview.refetch()}>Tentar novamente</button>
    </div> : <>
      <div className="catalog-sync-summary" aria-label="Resumo da prévia">
        <span>{synchronized} sincronizado{synchronized === 1 ? '' : 's'}</span>
        <span className={pending > 0 ? 'catalog-sync-pending' : ''}>{pending} pendente{pending === 1 ? '' : 's'}</span>
        <span className={withoutImage > 0 ? 'catalog-sync-warning' : ''}>{withoutImage} sem imagem</span>
      </div>
      <div className="catalog-sync-table-wrap">
        <table aria-label="Prévia da sincronização"><thead><tr><th>Produto</th><th>Tamanhos</th><th>Imagem</th><th>Drive</th></tr></thead><tbody>
          {items.map((item) => <tr key={`${item.club}-${item.model}-${item.type}`}>
            <td><strong>{item.productName}</strong></td>
            <td>{item.sizes}</td>
            <td>{item.status === 'ORFAO' ? '—' : item.hasLocalImage ? 'Pronta' : 'Ausente'}</td>
            <td><span className={`catalog-sync-status catalog-sync-status-${item.status.toLowerCase()}`}>{catalogPublishStatusLabels[item.status]}</span></td>
          </tr>)}
        </tbody></table>
        {items.length === 0 && <p className="catalog-sync-empty">Nenhum produto encontrado para publicar.</p>}
      </div>
    </>}

    <div className="catalog-sync-actions">
      <button className="primary-button" type="button" disabled={running || preview.isPending || preview.isError} onClick={() => start.mutate()}>
        {running ? 'Sincronizando…' : 'Sincronizar catálogo'}
      </button>
      {!running && pending === 0 && items.length > 0 && <span className="muted">O catálogo já está em dia.</span>}
    </div>

    {jobData?.status === 'running' && <div className="catalog-sync-progress" role="status">
      <div><span>{jobData.message}</span><strong>{Math.round((jobData.current / Math.max(jobData.total, 1)) * 100)}%</strong></div>
      <progress aria-label="Progresso da sincronização" aria-valuemin={0} aria-valuemax={Math.max(jobData.total, 1)} aria-valuenow={jobData.current}
        max={Math.max(jobData.total, 1)} value={jobData.current} />
    </div>}
    {start.isError && <div><PageError error={start.error} />
      <button className="secondary-action" type="button" onClick={() => start.mutate()}>Tentar novamente</button>
    </div>}
    {job.isError && <div><PageError error={job.error} />
      <button className="secondary-action" type="button" onClick={() => void job.refetch()}>Tentar novamente</button>
    </div>}
    {jobData?.status === 'failed' && <Notice tone="danger">{jobData.error ?? jobData.message}</Notice>}
    {result && result.status === 'completed' && <>
      <p role="status">Sincronização concluída · {result.created} criado · {result.updated} atualizados · {result.removed} removidos.</p>
      <p>{result.pendingWithoutImage} produtos sem imagem.</p>
    </>}
    {result && result.status === 'partial' && <>
      <p role="status">Sincronização parcial · {result.errors.length} erro(s).</p>
      {result.errors.length > 0 && <ul className="plain-list">{result.errors.map((error) => <li key={error}>{error}</li>)}</ul>}
    </>}
  </section>
}

type SessionInfo = {
  user: { displayName: string; username?: string; role: string }
  permissions: string[]
}
type DirectoryUser = {
  id: string; username: string; displayName: string; role: string; active: boolean; createdAt: string
}
type UserDirectory = { items: DirectoryUser[]; total: number; page: number; limit: number }

const roleLabels: Record<string, string> = {
  operator: 'Operador', inventory: 'Estoque', manager: 'Gestor', administrator: 'Administrador',
}

function canManageUsers(permissions: string[]): boolean {
  return permissions.includes('*') || permissions.includes('users:manage')
}

export function SettingsPage() {
  const client = useQueryClient()
  const session = useQuery({ queryKey: ['session'], queryFn: () => api<SessionInfo>('/auth/session'), retry: false })
  const logout = useMutation({
    mutationFn: () => api<undefined>('/auth/logout', { method: 'POST' }),
    onSuccess: async () => { await client.clear(); window.location.assign('/login') },
  })
  return <Page title="Configurações" subtitle="Sessão e ambiente atual."><section className="panel">
    {session.isPending ? 'Carregando sessão…' : session.isError ? (isUnauthorized(session.error) ? <PageError error={session.error} /> : <>
      <PageError error={session.error} />
      <button className="secondary-action" type="button" onClick={() => void session.refetch()}>Tentar novamente</button>
    </>) : <>
      <h2>{session.data.user.displayName}</h2>
      {session.data.user.username !== undefined && session.data.user.username !== '' && <p>Usuário: {session.data.user.username}</p>}
      <p>Perfil: {roleLabels[session.data.user.role] ?? session.data.user.role}</p>
      <p>{session.data.permissions.length} permissões efetivas</p>
      <details className="panel"><summary>Permissões efetivas</summary>
        {session.data.permissions.length === 0 ? <p>Nenhuma permissão concedida.</p> :
          <ul className="plain-list">{[...session.data.permissions].sort().map((permission) => <li key={permission}>{permission}</li>)}</ul>}
      </details>
      <OperationalStatusPanel />
      {canManageUsers(session.data.permissions)
        ? <UserDirectoryPanel />
        : <p>A administração de usuários é restrita a administradores.</p>}
      {!logout.isSuccess && <button className="primary-button" type="button" disabled={logout.isPending} onClick={() => logout.mutate()}>{logout.isError ? 'Tentar novamente' : 'Sair'}</button>}
      {logout.isError && <PageError error={logout.error} />}</>}
  </section></Page>
}

type Readiness = {
  status: string
  service: string
  version: string
  checks: { database: string }
  integrations: { catalog: string }
}

function readinessLabel(value: string, known: Record<string, string>): string {
  return known[value] ?? 'desconhecido'
}

function isReadinessEnvelope(value: unknown): value is Readiness {
  if (typeof value !== 'object' || value === null) return false
  const entry = value as Record<string, unknown>
  const checks = entry.checks as Record<string, unknown> | undefined
  const integrations = entry.integrations as Record<string, unknown> | undefined
  return typeof entry.status === 'string' && typeof entry.service === 'string' && typeof entry.version === 'string'
    && typeof checks?.database === 'string' && typeof integrations?.catalog === 'string'
}

export async function fetchReadiness(): Promise<Readiness> {
  const response = await fetch('/api/health/ready', { headers: { Accept: 'application/json' }, credentials: 'include' })
  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new ApiError(response.status, {})
  }
  if ((response.status === 200 || response.status === 503) && isReadinessEnvelope(body)) return body
  if (response.status === 401) throw new ApiError(response.status, {})
  throw new ApiError(response.status === 200 || response.status === 503 ? 502 : response.status, {})
}

function OperationalStatusPanel() {
  const query = useQuery({
    queryKey: ['operational-status'],
    queryFn: fetchReadiness,
    retry: false,
    refetchOnWindowFocus: false,
  })
  return <section className="panel" aria-label="Status operacional">
    <h2>Status operacional</h2>
    {query.isPending ? <PageState>Verificando status…</PageState> : query.isError ? <>
      <PageError error={query.error} />
      <button className="secondary-action" type="button" onClick={() => void query.refetch()}>Atualizar status</button>
    </> : <>
      {query.data.status !== 'ready' && <Notice tone="warning">Serviço degradado.</Notice>}
      <p>{`Versão: ${query.data.version}`}</p>
      <p>{`API: ${readinessLabel(query.data.status, { ready: 'pronta', not_ready: 'indisponível' })}`}</p>
      <p>{`Banco de dados: ${readinessLabel(query.data.checks.database, { up: 'em operação', down: 'indisponível', unconfigured: 'não configurado' })}`}</p>
      <p>{`Catálogo externo: ${readinessLabel(query.data.integrations.catalog, { configured: 'configurado', not_configured: 'não configurado' })}`}</p>
      <button className="secondary-action" type="button" onClick={() => void query.refetch()}>Atualizar status</button>
    </>}
  </section>
}

const fixedUserRoles = ['operator', 'inventory', 'manager', 'administrator'] as const

type UserCreateBody = { username: string; displayName: string; role: string; password: string }
type UserUpdateBody = { displayName?: string; role?: string; active?: boolean }

function userMutationMessage(error: unknown): string | null {
  if (error instanceof ApiError) {
    switch (error.body.code) {
      case 'USERNAME_TAKEN': return 'Nome de usuário já cadastrado.'
      case 'SELF_PROTECTION': return 'A sessão atual não pode rebaixar ou desativar o próprio usuário.'
      case 'LAST_ADMIN': return 'A operação removeria o último administrador ativo.'
      case 'USER_NOT_FOUND': return 'Usuário não encontrado.'
      case 'INVALID_CSRF': return 'Sessão inválida. Recarregue a página e tente novamente.'
      case 'VALIDATION_ERROR': return 'Revise os dados informados.'
      default: return null
    }
  }
  return null
}

function UserMutationError({ error }: { error: unknown }) {
  const message = userMutationMessage(error)
  if (message) return <Notice tone="danger">{message}</Notice>
  return <PageError error={error} />
}

function CreateUserForm({ onCreated }: { onCreated: () => void }) {
  const [username, setUsername] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [role, setRole] = useState('')
  const [password, setPassword] = useState('')
  const [validationError, setValidationError] = useState<string | null>(null)
  const [savedPayload, setSavedPayload] = useState<UserCreateBody | null>(null)
  const mutation = useMutation({
    mutationFn: (body: UserCreateBody) => api<DirectoryUser>('/users', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => {
      setUsername('')
      setDisplayName('')
      setRole('')
      setPassword('')
      setValidationError(null)
      setSavedPayload(null)
      onCreated()
    },
  })
  function submit(event: FormEvent) {
    event.preventDefault()
    const body = { username: username.trim().toLowerCase(), displayName: displayName.trim(), role, password }
    if (body.username === '' || body.displayName === '' || body.role === '') {
      setValidationError('Preencha usuário, nome e perfil.')
      return
    }
    if (password.length < 12 || password.length > 256) {
      setValidationError('A senha deve ter entre 12 e 256 caracteres.')
      return
    }
    setValidationError(null)
    setSavedPayload(body)
    mutation.mutate(body)
  }
  return <section className="panel" aria-label="Novo usuário">
    <h3>Novo usuário</h3>
    <form className="form-grid" onSubmit={submit}>
      <label className="field"><span>Nome de usuário</span><input value={username} disabled={mutation.isPending} onChange={(event) => setUsername(event.target.value)} /></label>
      <label className="field"><span>Nome de exibição</span><input value={displayName} disabled={mutation.isPending} onChange={(event) => setDisplayName(event.target.value)} /></label>
      <label className="field"><span>Perfil</span><select value={role} disabled={mutation.isPending} onChange={(event) => setRole(event.target.value)}>
        <option value="">Selecione o perfil</option>
        {fixedUserRoles.map((value) => <option key={value} value={value}>{roleLabels[value] ?? value}</option>)}
      </select></label>
      <label className="field"><span>Senha</span><input type="password" value={password} disabled={mutation.isPending} onChange={(event) => setPassword(event.target.value)} /></label>
      <button className="primary-button" disabled={mutation.isPending} type="submit">{mutation.isPending ? 'Cadastrando…' : 'Cadastrar usuário'}</button>
    </form>
    {validationError && <Notice tone="danger">{validationError}</Notice>}
    {mutation.isError && <><UserMutationError error={mutation.error} />
      {savedPayload && <button className="secondary-action" type="button" onClick={() => mutation.mutate(savedPayload)}>Tentar novamente</button>}</>}
    {mutation.isSuccess && <Notice tone="success">Usuário criado.</Notice>}
  </section>
}

function ConfirmDeactivateDialog({ payload, onConfirm, onCancel }: {
  payload: UserUpdateBody
  onConfirm: (payload: UserUpdateBody) => void
  onCancel: () => void
}) {
  const [host] = useState(() => document.createElement('div'))
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const confirmRef = useRef<HTMLButtonElement | null>(null)
  useEffect(() => {
    document.body.appendChild(host)
    const siblings = Array.from(document.body.children).filter((node) => node !== host)
    const previous = siblings.map((node) => ({
      node,
      inert: node.getAttribute('inert'),
      hidden: node.getAttribute('aria-hidden'),
    }))
    for (const node of siblings) {
      node.setAttribute('inert', '')
      node.setAttribute('aria-hidden', 'true')
    }
    confirmRef.current?.focus()
    const guard = (event: FocusEvent) => {
      if (dialogRef.current && event.target instanceof Node && !dialogRef.current.contains(event.target)) {
        confirmRef.current?.focus()
      }
    }
    document.addEventListener('focusin', guard)
    return () => {
      document.removeEventListener('focusin', guard)
      for (const { node, inert, hidden } of previous) {
        if (!node.isConnected) continue
        if (inert === null) node.removeAttribute('inert')
        else node.setAttribute('inert', inert)
        if (hidden === null) node.removeAttribute('aria-hidden')
        else node.setAttribute('aria-hidden', hidden)
      }
      host.remove()
    }
  }, [host])
  function cycleFocus(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      onCancel()
      return
    }
    if (event.key !== 'Tab' || !dialogRef.current) return
    const items = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ))
    if (items.length === 0) return
    const first = items[0]!
    const last = items[items.length - 1]!
    const active = document.activeElement
    if (event.shiftKey && (active === first || !dialogRef.current.contains(active))) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && active === last) {
      event.preventDefault()
      first.focus()
    }
  }
  return createPortal(
    <>
      <div className="modal-backdrop" aria-hidden="true" />
      <div ref={dialogRef} className="panel modal-dialog" role="alertdialog" aria-modal="true"
        aria-labelledby="deactivate-title" aria-describedby="deactivate-desc" onKeyDown={cycleFocus}>
        <h4 id="deactivate-title">Confirmar desativação</h4>
        <p id="deactivate-desc">Desativar este usuário invalida as sessões dele. Confirmar?</p>
        <button ref={confirmRef} className="primary-button" type="button" onClick={() => onConfirm(payload)}>Confirmar desativação</button>
        <button className="secondary-action" type="button" onClick={onCancel}>Voltar</button>
      </div>
    </>,
    host,
  )
}

function EditUserForm({ user, onClose, onSaved, onSuccessFocus }: {
  user: DirectoryUser
  onClose: () => void
  onSaved: () => void
  onSuccessFocus: () => void
}) {
  const initial = useRef({ displayName: user.displayName, role: user.role, active: user.active })
  const [displayName, setDisplayName] = useState(user.displayName)
  const [role, setRole] = useState(user.role)
  const [active, setActive] = useState(user.active)
  const [validationError, setValidationError] = useState<string | null>(null)
  const [noChanges, setNoChanges] = useState(false)
  const [confirming, setConfirming] = useState<UserUpdateBody | null>(null)
  const [savedPayload, setSavedPayload] = useState<UserUpdateBody | null>(null)
  const saveButton = useRef<HTMLButtonElement | null>(null)
  const retryButton = useRef<HTMLButtonElement | null>(null)
  const returnFocus = useRef(false)
  const mutation = useMutation({
    mutationFn: (body: UserUpdateBody) => api<DirectoryUser>(`/users/${user.id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    onSuccess: () => {
      onSaved()
      onClose()
      onSuccessFocus()
    },
  })
  function send(body: UserUpdateBody) {
    setValidationError(null)
    setNoChanges(false)
    setSavedPayload(body)
    setConfirming(null)
    mutation.mutate(body)
  }
  function submit(event: FormEvent) {
    event.preventDefault()
    const trimmed = displayName.trim()
    if (trimmed === '' || role === '') {
      setValidationError('Preencha nome e perfil.')
      return
    }
    const delta: UserUpdateBody = {}
    if (trimmed !== initial.current.displayName) delta.displayName = trimmed
    if (role !== initial.current.role) delta.role = role
    if (active !== initial.current.active) delta.active = active
    if (Object.keys(delta).length === 0) {
      setNoChanges(true)
      return
    }
    setNoChanges(false)
    if (delta.active === false && initial.current.active) {
      setConfirming(delta)
      return
    }
    send(delta)
  }
  function cancelConfirm() {
    setConfirming(null)
    returnFocus.current = true
  }
  useEffect(() => {
    if (returnFocus.current && confirming === null) {
      returnFocus.current = false
      saveButton.current?.focus()
    }
  }, [confirming])
  useEffect(() => {
    if (mutation.isError && savedPayload) retryButton.current?.focus()
  }, [mutation.isError, savedPayload])
  const locked = confirming !== null || mutation.isPending
  return <section className="panel" aria-label="Editar usuário" aria-labelledby="edit-user-heading">
    <h3 id="edit-user-heading">Editar usuário</h3>
    <p>Usuário: {user.username}</p>
    <div inert={confirming !== null}>
      <form className="form-grid" onSubmit={submit}>
        <fieldset disabled={locked}>
          <label className="field"><span>Nome de exibição</span><input value={displayName} onChange={(event) => setDisplayName(event.target.value)} /></label>
          <label className="field"><span>Perfil</span><select value={role} onChange={(event) => setRole(event.target.value)}>
            {fixedUserRoles.map((value) => <option key={value} value={value}>{roleLabels[value] ?? value}</option>)}
          </select></label>
          <label className="field"><span><input type="checkbox" checked={active} onChange={(event) => setActive(event.target.checked)} /> Ativo</span></label>
          <button ref={saveButton} className="primary-button" type="submit">{mutation.isPending ? 'Salvando…' : 'Salvar alterações'}</button>
          <button className="secondary-action" type="button" onClick={onClose}>Fechar</button>
        </fieldset>
      </form>
    </div>
    {confirming !== null && <ConfirmDeactivateDialog payload={confirming} onConfirm={send} onCancel={cancelConfirm} />}
    {noChanges && <Notice tone="warning">Nenhuma alteração para salvar.</Notice>}
    {validationError && <Notice tone="danger">{validationError}</Notice>}
    {mutation.isError && <><UserMutationError error={mutation.error} />
      {savedPayload && <button ref={retryButton} className="secondary-action" type="button" onClick={() => mutation.mutate(savedPayload)}>Tentar novamente</button>}</>}
  </section>
}

function UserDirectoryPanel() {
  const client = useQueryClient()
  const [search, setSearch] = useState('')
  const [draft, setDraft] = useState('')
  const [page, setPage] = useState(1)
  const [editingId, setEditingId] = useState<string | null>(null)
  const directorySearch = useRef<HTMLInputElement | null>(null)
  const params = new URLSearchParams({ page: String(page), limit: '20' })
  if (search !== '') params.set('search', search)
  const query = useQuery({
    queryKey: ['users', search, page],
    queryFn: () => api<UserDirectory>(`/users?${params.toString()}`),
    retry: false,
  })
  function apply(event: FormEvent) {
    event.preventDefault()
    setPage(1)
    setSearch(draft)
  }
  const totalPages = Math.max(1, Math.ceil((query.data?.total ?? 0) / 20))
  function refresh() {
    void client.invalidateQueries({ queryKey: ['users'] })
  }
  const editing = editingId === null ? null : query.data?.items.find((user) => user.id === editingId) ?? null
  return <section className="panel" aria-label="Usuários">
    <h2>Usuários ({query.data?.total ?? '…'})</h2>
    <CreateUserForm onCreated={refresh} />
    <form className="panel inline-form" role="search" aria-label="Buscar usuários" onSubmit={apply}>
      <label className="field"><span>Busca</span><input ref={directorySearch} value={draft} placeholder="Usuário ou nome" onChange={(event) => setDraft(event.target.value)} /></label>
      <button className="primary-button" type="submit">Buscar</button>
    </form>
    {query.isPending ? <PageState>Carregando usuários…</PageState> : query.isError ? <>
      <PageError error={query.error} />
      <button className="secondary-action" type="button" onClick={() => void query.refetch()}>Tentar novamente</button>
    </> : query.data.items.length === 0 ? <PageState>Nenhum usuário encontrado.</PageState> : <>
      <div className="table-wrap"><table><thead><tr><th>Nome</th><th>Usuário</th><th>Perfil</th><th>Situação</th><th>Ações</th></tr></thead><tbody>
        {query.data.items.map((user) => <tr key={user.id}>
          <td>{user.displayName}</td><td>{user.username}</td>
          <td>{roleLabels[user.role] ?? user.role}</td><td>{user.active ? 'Ativo' : 'Inativo'}</td>
          <td><button className="secondary-action" type="button" aria-label={`Editar ${user.displayName}`} onClick={() => setEditingId(user.id)}>Editar</button></td>
        </tr>)}
      </tbody></table></div>
      {totalPages > 1 && <nav className="panel" aria-label="Paginação">
        <span>Página {page} de {totalPages} · {query.data.total} registro(s)</span>{' '}
        <button className="secondary-action" type="button" disabled={page <= 1} onClick={() => setPage(page - 1)}>Anterior</button>{' '}
        <button className="secondary-action" type="button" disabled={page >= totalPages} onClick={() => setPage(page + 1)}>Próxima</button>
      </nav>}
    </>}
    {editing && <EditUserForm key={editing.id} user={editing} onClose={() => setEditingId(null)} onSaved={refresh}
      onSuccessFocus={() => directorySearch.current?.focus()} />}
  </section>
}

export function Field({ label, name, type = 'text', required, disabled }: { label: string; name: string; type?: string; required?: boolean; disabled?: boolean }) { return <label className="field"><span>{label}</span><input name={name} type={type} required={required} disabled={disabled} /></label> }
export function Page({ title, subtitle, action, children }: { title: string; subtitle?: string; action?: React.ReactNode; children: React.ReactNode }) { return <div className="page-stack"><header className="page-header"><div><p className="eyebrow">ERP 2.0</p><h1>{title}</h1>{subtitle && <p>{subtitle}</p>}</div>{action}</header>{children}</div> }
export function PageState({ children }: { children: React.ReactNode }) { return <section className="panel page-state" role="status">{children}</section> }
export function PageError({ error }: { error: unknown }) {
  if (isUnauthorized(error)) {
    return <Notice tone="danger"><span>Sessão expirada. </span><a href="/login">Entrar</a></Notice>
  }
  const message = error instanceof ApiError ? error.message : 'Falha ao carregar os dados.'; return <Notice tone="danger">{message}</Notice>
}
export function Notice({ children, tone }: { children: React.ReactNode; tone: string }) { return <div className={`notice notice-${tone}`} role={tone === 'danger' ? 'alert' : 'status'}>{children}</div> }
function Metric({ label, value, detail, tone }: { label: string; value: string; detail: string; tone: string }) { return <article className={`metric metric-${tone}`}><p>{label}</p><strong>{value}</strong><small>{detail}</small></article> }
function localDate() { return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date()) }
function currentMonth() { const today = localDate(); return { from: `${today.slice(0, 7)}-01`, to: today } }
function formatDate(value: string) { return new Intl.DateTimeFormat('pt-BR', { timeZone: 'UTC' }).format(new Date(`${value}T00:00:00Z`)) }
