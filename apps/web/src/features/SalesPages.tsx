import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useParams } from '@tanstack/react-router'
import { Plus, Shirt } from 'lucide-react'
import { type FormEvent, useEffect, useState } from 'react'

import { ApiError, UncertainResultError, api, currentCsrfToken, formatMoney, idempotencyHeaders } from '../lib/api.js'
import { moneyToCents } from '../lib/money.js'
import { variantLabel, type VariantDescription } from '../lib/variant-label.js'
import { useSessionPermissions } from './InventoryPages.js'
import { Field, Notice, Page, PageError, PageState } from './OperationalPages.js'

import './sales.css'

type SaleItem = VariantDescription & { variantId: string; quantity: number; unitPrice: string; unitCost: string }
type SalePayment = { id: string; amount: string; method: string; status: string }
type ExchangeItem = VariantDescription & { variantId: string; direction: string; quantity: number; unitPrice: string; unitCost: string }
type SaleExchange = { id: string; reason: string; createdAt: string; items: ExchangeItem[] }
type SaleDetail = {
  id: string; customerId: string | null; status: string; subtotalAmount: string; discountAmount: string;
  finalAmount: string; amountDue: string; createdAt?: string; items: SaleItem[]; payments: SalePayment[]; exchanges: SaleExchange[];
  timeline?: Array<{ kind: string; id: string; at: string; status?: string; amount?: string; receivedAt?: string }>;
}
type SaleRow = {
  customerName?: string; productSummary?: string | null;
  productPreviews?: Array<{ productId: string; label: string; mediaId: string | null }>;
  id: string; customerId: string | null; status: string; finalAmount: string; amountDue: string; createdAt: string;
}
type PickerVariant = { id: string; type: string; size: string; sku: string; salePrice: string; stockQuantity: number }

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const moneyPattern = /^(0|[1-9]\d*)\.\d{2}$/
const paymentMethods = ['cash', 'pix', 'debit_card', 'credit_card', 'bank_transfer', 'other'] as const
const paymentMethodLabels: Record<string, string> = {
  cash: 'Dinheiro', pix: 'Pix', debit_card: 'Débito', credit_card: 'Crédito', bank_transfer: 'Transferência', other: 'Outro',
}
const saleStatusLabels: Record<string, string> = {
  paid: 'Pago', pending: 'Pendente', partially_paid: 'Parcial', reversed: 'Estornado', open: 'Em aberto',
}

function hasAnyPermission(permissions: string[], required: string[]): boolean {
  return required.some((permission) => permissions.includes('*') || permissions.includes(permission))
}

function readSaleFilters(): { status: string; page: string } {
  const params = new URLSearchParams(window.location.search)
  const status = params.get('status') ?? ''
  return {
    status: status === 'pending' || status === 'partially_paid' ? 'open' : status,
    page: params.get('page') ?? '1',
  }
}

export function SalesPage() {
  const [filters, setFilters] = useState(readSaleFilters)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    if (params.get('status') === 'pending' || params.get('status') === 'partially_paid') {
      params.set('status', 'open')
      window.history.replaceState(null, '', `/vendas?${params.toString()}`)
    }
  }, [])
  function update(patch: Partial<{ status: string; page: string }>) {
    setFilters((current) => {
      const next = { ...current, ...patch }
      if (patch.status !== undefined) next.page = '1'
      const params = new URLSearchParams()
      if (next.status !== '') params.set('status', next.status)
      if (next.page !== '' && next.page !== '1') params.set('page', next.page)
      const query = params.toString()
      window.history.replaceState(null, '', `/vendas${query === '' ? '' : `?${query}`}`)
      return next
    })
  }
  function clear() {
    window.history.replaceState(null, '', '/vendas')
    setFilters({ status: '', page: '1' })
  }
  const params = new URLSearchParams()
  if (filters.status !== '') params.set('status', filters.status)
  params.set('page', filters.page === '' ? '1' : filters.page)
  params.set('limit', '20')
  const query = useQuery({
    queryKey: ['sales', filters.status, filters.page],
    queryFn: () => api<{ items: SaleRow[]; total: number; page: number; limit: number }>(`/sales?${params.toString()}`),
  })
  const filtered = filters.status !== '' || filters.page !== '1'
  return <div className="sales-page"><Page title="Vendas"
    action={<a className="primary-action" href="/vendas/nova"><Plus size={16} aria-hidden="true" />Nova venda</a>}>
    <section className="sales-list" aria-label="Histórico de vendas">
    <div className="sales-toolbar">
      <div className="sales-status-filter" role="group" aria-label="Pagamento">
        {[['', 'Todas'], ['open', 'A receber'], ['paid', 'Pagas'], ['reversed', 'Estornadas']].map(([value, label]) =>
          <button key={value} type="button" aria-pressed={filters.status === value} onClick={() => update({ status: value! })}>{label}</button>)}
      </div>
      {query.isSuccess && <span className="sales-count">{query.data.total} {query.data.total === 1 ? 'venda' : 'vendas'}</span>}
    </div>
    {query.isPending ? <PageState>Carregando vendas…</PageState> : query.isError ? <>
      <PageError error={query.error} /><button className="secondary-action" type="button" onClick={() => void query.refetch()}>Tentar novamente</button>
    </> : query.data.items.length === 0 ? <PageState>{filtered ? 'Nenhuma venda para estes filtros.' : 'Nenhuma venda registrada.'}
      {filtered && <button className="secondary-action" type="button" onClick={clear}>Ver todas as vendas</button>}</PageState> :
      <><div className="sales-table-scroll" role="region" aria-label="Vendas: role para ver todas as colunas" tabIndex={0}><table className="sales-table" aria-label="Vendas">
        <colgroup><col /><col className="sales-date-col" /><col className="sales-amount-col" /><col className="sales-payment-col" /></colgroup>
        <thead><tr><th scope="col">Cliente / produtos</th><th scope="col">Data</th><th scope="col" className="sales-amount">Total</th><th scope="col">Pagamento</th></tr></thead>
        <tbody>{query.data.items.map((sale) => <tr key={sale.id}>
          <td><div className="sales-product-cell"><div className="sales-customer"><a href={`/vendas/${sale.id}`} aria-label={`Abrir venda ${saleStatusLabels[sale.status] ?? sale.status} de ${formatMoney(sale.finalAmount)}`}>
            <strong>{sale.customerName || 'Consumidor Final'}</strong></a>
            <small className="sale-products" title={sale.productSummary ?? ''}>{sale.productSummary || 'Ver itens da venda'}</small></div>
            <div className="sales-previews">{(sale.productPreviews ?? []).slice(0, 3).map((product) =>
              <SaleProductPreview key={`${product.productId}-${product.mediaId}`} product={product} />)}</div>
          </div></td>
          <td className="sales-date">{formatDateTime(sale.createdAt)}</td>
          <td className="sales-amount"><strong>{formatMoney(sale.finalAmount)}</strong></td>
          <td><span className={`sale-payment sale-payment-${sale.status}`}>{saleStatusLabels[sale.status] ?? sale.status}</span>
            {sale.status !== 'reversed' && moneyToCents(sale.amountDue) > 0n && <small className="sale-products">Falta {formatMoney(sale.amountDue)}</small>}</td>
        </tr>)}</tbody>
      </table></div>
      <div className="sales-pagination"><Pagination page={query.data.page} limit={query.data.limit} total={query.data.total}
        onPage={(page) => update({ page: String(page) })} /></div></>}
    </section>
  </Page></div>
}

function SaleProductPreview({ product }: { product: { label: string; mediaId: string | null } }) {
  const [failed, setFailed] = useState(false)
  return <span className="sales-preview" title={product.label}>
    {product.mediaId && !failed
      ? <img src={`/api/catalog/media/${product.mediaId}`} alt={product.label} width={42} height={44} loading="lazy" decoding="async" onError={() => setFailed(true)} />
      : <span className="sales-preview-fallback" role="img" aria-label={`${product.label}: sem imagem`}><Shirt size={21} strokeWidth={1.4} aria-hidden="true" /></span>}
  </span>
}

function Pagination({ page, limit, total, onPage }: { page: number; limit: number; total: number; onPage: (page: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / limit))
  return <nav className="panel" aria-label="Paginação"><span>Página {page} de {pages} · {total} registro(s)</span>{' '}
    <button className="secondary-action" type="button" disabled={page <= 1} onClick={() => onPage(page - 1)}>Anterior</button>{' '}
    <button className="secondary-action" type="button" disabled={page >= pages} onClick={() => onPage(page + 1)}>Próxima</button></nav>
}

function formatDateTime(value: string | null): string {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value ?? '—'
  return new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date)
}

export function SaleDetailPage({ saleId }: { saleId?: string } = {}) {
  if (saleId !== undefined) return <SaleDetail saleId={saleId} />
  return <RoutedSaleDetail />
}

function RoutedSaleDetail() {
  const { vendaId } = useParams({ strict: false }) as { vendaId?: string }
  return <SaleDetail saleId={vendaId} />
}

function SaleDetail({ saleId }: { saleId?: string | undefined }) {
  const client = useQueryClient()
  const permissions = useSessionPermissions()
  const [paymentConfirmed, setPaymentConfirmed] = useState(false)
  const detail = useQuery({
    queryKey: ['sales', saleId],
    queryFn: () => api<SaleDetail>(`/sales/${saleId}`),
    retry: false,
  })
  if (detail.isPending) return <Page title="Venda"><PageState>Carregando venda…</PageState></Page>
  if (detail.isError) return <Page title="Venda"><PageError error={detail.error} /><p><a href="/vendas">Voltar às vendas</a></p></Page>
  const sale = detail.data
  const canPay = sale.amountDue !== '0.00' && hasAnyPermission(permissions, ['sales:payment'])
  const canExchange = sale.status !== 'reversed' && hasAnyPermission(permissions, ['sales:exchange'])
  async function refresh() {
    await client.invalidateQueries({ queryKey: ['sales'] })
  }
  function handlePaymentConfirmed() {
    setPaymentConfirmed(true)
    void refresh()
  }
  return <Page title={`Venda ${sale.id.slice(0, 8)}`} subtitle={`${saleStatusLabels[sale.status] ?? sale.status} · total ${formatMoney(sale.finalAmount)}`}
    action={<a className="primary-action" href="/vendas">Voltar às vendas</a>}>
    <section className="panel" aria-label="Resumo financeiro">
      <p>Subtotal {formatMoney(sale.subtotalAmount)} · desconto {formatMoney(sale.discountAmount)} · total {formatMoney(sale.finalAmount)} · saldo devido {formatMoney(sale.amountDue)}</p>
    </section>
    <section className="panel" aria-label="Itens da venda">
      <h2>Itens</h2>
      {sale.items.length === 0 ? <PageState>Nenhum item registrado.</PageState> :
        <div className="table-wrap"><table>
          <thead><tr><th>Variante</th><th>Quantidade</th><th>Preço</th></tr></thead>
          <tbody>{sale.items.map((item, index) => <tr key={`${item.variantId}-${index}`}>
            <td>{variantLabel(item)}</td><td>{item.quantity}</td><td>{formatMoney(item.unitPrice)}</td>
          </tr>)}</tbody>
        </table></div>}
    </section>
    <section className="panel" aria-label="Pagamentos">
      <h2>Pagamentos</h2>
      {paymentConfirmed && <Notice tone="success">Pagamento registrado.</Notice>}
      {sale.payments.length === 0 ? <PageState>Nenhum pagamento registrado.</PageState> :
        <div className="table-wrap"><table>
          <thead><tr><th>Valor</th><th>Método</th><th>Situação</th></tr></thead>
          <tbody>{sale.payments.map((payment) => <tr key={payment.id}>
            <td>{formatMoney(payment.amount)}</td><td>{paymentMethodLabels[payment.method] ?? payment.method}</td><td>{payment.status}</td>
          </tr>)}</tbody>
        </table></div>}
      {canPay && <PaymentForm sale={sale} onStarted={() => setPaymentConfirmed(false)} onConfirmed={handlePaymentConfirmed} />}
    </section>
    <section className="panel" aria-label="Trocas">
      <h2>Trocas</h2>
      {sale.exchanges.length === 0 ? <PageState>Nenhuma troca registrada.</PageState> :
        sale.exchanges.map((exchange) => <article className="panel" key={exchange.id}>
          <h3>Troca {exchange.id.slice(0, 8)} · {exchange.reason}</h3>
          <ul className="plain-list">{exchange.items.map((item, index) => <li key={`${item.variantId}-${item.direction}-${index}`}>
            {item.direction === 'returned' ? 'Devolvido' : 'Entregue'} · {variantLabel(item)} · {item.quantity} un. · {formatMoney(item.unitPrice)}
          </li>)}</ul>
        </article>)}
      {canExchange && <ExchangeForm sale={sale} onConfirmed={() => { void refresh() }} />}
    </section>
    {sale.timeline !== undefined && <section className="panel" aria-label="Linha do tempo">
      <h2>Linha do tempo</h2>
      {sale.timeline.length === 0 ? <PageState>Nenhum evento registrado.</PageState> :
        <ul className="plain-list">{sale.timeline.map((entry) => <li key={`${entry.kind}-${entry.id}`}>
          <span><strong>{translateTimelineKind(entry.kind)}</strong>
            <small>{formatDateTime(entry.at)}{entry.amount ? ` · ${formatMoney(entry.amount)}` : ''}{entry.status ? ` · ${entry.status}` : ''}</small>
          </span>
        </li>)}</ul>}
    </section>}
    <section className="panel" aria-label="Estorno">
      <h2>Estorno</h2>
      {sale.status === 'reversed'
        ? <PageState>Venda estornada; estoque e pagamentos foram revertidos.</PageState>
        : !hasAnyPermission(permissions, ['sales:reverse'])
          ? <PageState>Seu perfil não tem permissão para estornar vendas.</PageState>
          : sale.exchanges.length > 0
            ? <PageState>Venda com troca não pode ser estornada; corrija pelas trocas.</PageState>
            : <ReversalForm sale={sale} onConfirmed={() => { void refresh() }} />}
    </section>
  </Page>
}

function ReversalForm({ sale, onConfirmed }: { sale: SaleDetail; onConfirmed: () => void }) {
  const [validationError, setValidationError] = useState<string | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  const reversal = useMutation({
    mutationFn: async (reason: string | null) => {
      return api<{ id: string; status: string; paymentsReversed: number }>(`/sales/${sale.id}/reversal`, {
        method: 'POST', body: JSON.stringify(reason === null ? {} : { reason }),
      })
    },
    onSuccess: () => {
      setConfirmed(true)
      onConfirmed()
    },
  })
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (reversal.isPending) return
    const data = new FormData(event.currentTarget)
    const reason = String(data.get('reason') ?? '').trim()
    if (reason.length > 500) {
      setValidationError('Motivo do estorno excede 500 caracteres.')
      return
    }
    setValidationError(null)
    reversal.mutate(reason === '' ? null : reason)
  }
  return <div>
    <h3>Estornar venda</h3>
    {confirmed && <Notice tone="success">Venda estornada.</Notice>}
    {reversal.isError && <PageError error={reversal.error} />}
    {validationError && <Notice tone="danger">{validationError}</Notice>}
    <p>O estorno devolve o estoque, marca pagamentos como estornados e fica registrado na auditoria. Motivo é opcional.</p>
    <form className="form-grid" onSubmit={submit}>
      <Field label="Motivo do estorno (opcional)" name="reason" disabled={reversal.isPending} />
      <button className="secondary-action" type="submit" disabled={reversal.isPending}>
        {reversal.isPending ? 'Estornando…' : 'Estornar venda'}
      </button>
    </form>
  </div>
}

function translateTimelineKind(kind: string): string {
  return ({ 'sale.created': 'Venda criada', 'payment.confirmed': 'Pagamento confirmado', 'exchange.created': 'Troca registrada' } as Record<string, string>)[kind] ?? kind
}

type PendingPayment = { key: string; body: string; saleId: string; csrf: string }
const pendingPaymentKey = 'erp.pendingPaymentOperation.v1'

function savePendingPayment(pending: PendingPayment): boolean {
  try {
    const raw = JSON.stringify(pending)
    sessionStorage.setItem(pendingPaymentKey, raw)
    return sessionStorage.getItem(pendingPaymentKey) === raw
  } catch {
    return false
  }
}

function loadPendingPayment(saleId: string): PendingPayment | null {
  let raw: string | null
  try {
    raw = sessionStorage.getItem(pendingPaymentKey)
  } catch {
    return null
  }
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<PendingPayment>
    if (typeof parsed.key !== 'string' || parsed.key === '' || typeof parsed.body !== 'string'
      || parsed.saleId !== saleId || typeof parsed.csrf !== 'string' || parsed.csrf !== (currentCsrfToken() ?? '')) {
      clearPendingPayment()
      return null
    }
    const body = JSON.parse(parsed.body) as { amount?: unknown; method?: unknown }
    if (typeof body.amount !== 'string' || !moneyPattern.test(body.amount)
      || typeof body.method !== 'string' || !(paymentMethods as readonly string[]).includes(body.method)) {
      clearPendingPayment()
      return null
    }
    return parsed as PendingPayment
  } catch {
    clearPendingPayment()
    return null
  }
}

function clearPendingPayment() {
  try {
    sessionStorage.removeItem(pendingPaymentKey)
  } catch {
    return
  }
}

function PaymentForm({ sale, onStarted, onConfirmed }: { sale: SaleDetail; onStarted: () => void; onConfirmed: () => void }) {
  const [operation, setOperation] = useState<{ key: string; body: string } | null>(null)
  const [uncertain, setUncertain] = useState(false)
  const [persistError, setPersistError] = useState(false)
  const [validationError, setValidationError] = useState<string | null>(null)
  const payment = useMutation({
    mutationFn: async (op: { key: string; body: string }) => {
      const response = await api<{ id: string; saleId: string; status: string; amountDue: string }>(`/sales/${sale.id}/payments`, {
        method: 'POST', headers: idempotencyHeaders(op.key), body: op.body,
      })
      if (!response || typeof response.amountDue !== 'string') throw new UncertainResultError(201)
      return response
    },
    onSuccess: () => {
      setOperation(null); setUncertain(false); setPersistError(false); setValidationError(null)
      clearPendingPayment()
      onConfirmed()
    },
    onError: (error) => {
      if (error instanceof TypeError || error instanceof UncertainResultError || (error instanceof ApiError && error.status >= 500)) {
        setUncertain(true)
        return
      }
      setUncertain(false)
      setOperation(null)
      clearPendingPayment()
    },
  })
  const locked = payment.isPending || uncertain
  useEffect(() => {
    const pending = loadPendingPayment(sale.id)
    if (pending) {
      setOperation({ key: pending.key, body: pending.body })
      setUncertain(true)
    }
  }, [sale.id])
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (locked) return
    const data = new FormData(event.currentTarget)
    const amount = String(data.get('amount') ?? '')
    const method = String(data.get('method') ?? '')
    if (!moneyPattern.test(amount)) {
      setValidationError('Valor inválido. Use o formato 0.00.')
      return
    }
    if (moneyToCents(amount) <= 0n) {
      setValidationError('Valor deve ser maior que zero.')
      return
    }
    if (!(paymentMethods as readonly string[]).includes(method)) {
      setValidationError('Método de pagamento inválido.')
      return
    }
    try {
      if (moneyToCents(amount) > moneyToCents(sale.amountDue)) {
        setValidationError(`Valor acima do saldo devido (${formatMoney(sale.amountDue)}).`)
        return
      }
    } catch {
      setValidationError('Valor inválido. Use o formato 0.00.')
      return
    }
    setValidationError(null)
    const body = JSON.stringify({ amount, method })
    const op = { key: crypto.randomUUID(), body }
    if (!savePendingPayment({ ...op, saleId: sale.id, csrf: currentCsrfToken() ?? '' })) {
      setPersistError(true)
      return
    }
    setPersistError(false)
    setOperation(op)
    setUncertain(false)
    onStarted()
    payment.mutate(op)
  }
  function retryPayment() {
    if (!operation) return
    onStarted()
    payment.mutate(operation)
  }
  return <section aria-label="Pagamento posterior">
    <h3>Registrar pagamento</h3>
    {payment.isError && <PageError error={payment.error} />}
    {validationError && <Notice tone="danger">{validationError}</Notice>}
    {persistError && !payment.isPending && !uncertain && <Notice tone="danger">Não foi possível garantir a recuperação do pagamento após recarga; nada foi enviado. Tente novamente.</Notice>}
    {uncertain && !payment.isPending && <div className="panel"><p>Resposta do pagamento incerta. Não altere os dados.</p>
      <button className="primary-button" type="button" onClick={retryPayment}>Tentar novamente</button></div>}
    <form className="form-grid" onSubmit={submit}>
      <Field label="Valor" name="amount" required disabled={locked} />
      <label className="field"><span>Método</span><select name="method" defaultValue="pix" disabled={locked}>
        {(paymentMethods as readonly string[]).map((method) => <option key={method} value={method}>{paymentMethodLabels[method]}</option>)}
      </select></label>
      <button className="primary-button" disabled={locked}>{payment.isPending ? 'Registrando…' : 'Registrar pagamento'}</button>
    </form>
  </section>
}

type PendingExchange = { key: string; body: string; saleId: string; csrf: string }
const pendingExchangeKey = 'erp.pendingExchangeOperation.v1'

function savePendingExchange(pending: PendingExchange): boolean {
  try {
    const raw = JSON.stringify(pending)
    sessionStorage.setItem(pendingExchangeKey, raw)
    return sessionStorage.getItem(pendingExchangeKey) === raw
  } catch {
    return false
  }
}

function validExchangeLine(line: unknown): line is { variantId: string; quantity: number } {
  if (typeof line !== 'object' || line === null) return false
  const entry = line as Record<string, unknown>
  return typeof entry.variantId === 'string' && uuidPattern.test(entry.variantId)
    && typeof entry.quantity === 'number' && Number.isInteger(entry.quantity) && entry.quantity >= 1 && entry.quantity <= 10_000
}

function loadPendingExchange(saleId: string): PendingExchange | null {
  let raw: string | null
  try {
    raw = sessionStorage.getItem(pendingExchangeKey)
  } catch {
    return null
  }
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<PendingExchange>
    if (typeof parsed.key !== 'string' || parsed.key === '' || typeof parsed.body !== 'string'
      || parsed.saleId !== saleId || typeof parsed.csrf !== 'string' || parsed.csrf !== (currentCsrfToken() ?? '')) {
      clearPendingExchange()
      return null
    }
    const body = JSON.parse(parsed.body) as { returned?: unknown; delivered?: unknown }
    if (!Array.isArray(body.returned) || !Array.isArray(body.delivered)
      || body.returned.length === 0 || body.delivered.length === 0
      || !body.returned.every(validExchangeLine) || !body.delivered.every(validExchangeLine)) {
      clearPendingExchange()
      return null
    }
    return parsed as PendingExchange
  } catch {
    clearPendingExchange()
    return null
  }
}

function clearPendingExchange() {
  try {
    sessionStorage.removeItem(pendingExchangeKey)
  } catch {
    return
  }
}

function ExchangeForm({ sale, onConfirmed }: { sale: SaleDetail; onConfirmed: () => void }) {
  const [search, setSearch] = useState('')
  const [returnedId, setReturnedId] = useState('')
  const [deliveredId, setDeliveredId] = useState<string | null>(null)
  const [operation, setOperation] = useState<{ key: string; body: string } | null>(null)
  const [uncertain, setUncertain] = useState(false)
  const [persistError, setPersistError] = useState(false)
  const [validationError, setValidationError] = useState<string | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  const picker = useQuery({
    queryKey: ['products', 'exchange-picker', search],
    queryFn: () => api<{ items: Array<{ id: string; club: string; model: string; variants: PickerVariant[] }> }>(
      `/products?search=${encodeURIComponent(search)}&limit=20`),
    enabled: search.trim().length >= 2,
    retry: false,
  })
  const exchange = useMutation({
    mutationFn: async (op: { key: string; body: string }) => {
      const response = await api<{ id: string; saleId: string; returnedUnits: number; deliveredUnits: number }>(`/sales/${sale.id}/exchanges`, {
        method: 'POST', headers: idempotencyHeaders(op.key), body: op.body,
      })
      if (!response || typeof response.id !== 'string') throw new UncertainResultError(201)
      return response
    },
    onSuccess: () => {
      setConfirmed(true); setOperation(null); setUncertain(false); setPersistError(false); setValidationError(null)
      clearPendingExchange()
      onConfirmed()
    },
    onError: (error) => {
      if (error instanceof TypeError || error instanceof UncertainResultError || (error instanceof ApiError && error.status >= 500)) {
        setUncertain(true)
        return
      }
      setUncertain(false)
      setOperation(null)
      clearPendingExchange()
    },
  })
  const locked = exchange.isPending || uncertain
  useEffect(() => {
    const pending = loadPendingExchange(sale.id)
    if (pending) {
      setOperation({ key: pending.key, body: pending.body })
      setUncertain(true)
    }
  }, [sale.id])
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (locked) return
    const data = new FormData(event.currentTarget)
    const reason = String(data.get('reason') ?? '').trim()
    const returnedQuantity = Number(data.get('returnedQuantity'))
    const deliveredQuantity = Number(data.get('deliveredQuantity'))
    if (reason === '') {
      setValidationError('Motivo da troca é obrigatório.')
      return
    }
    // O select é controlado: o valor enviado vem do estado React, nunca do DOM
    // (FormData pode divergir da seleção visível após re-renders do formulário).
    if (!uuidPattern.test(returnedId)) {
      setValidationError('Selecione o item vendido a devolver.')
      return
    }
    if (!deliveredId) {
      setValidationError('Selecione a variante a entregar.')
      return
    }
    if (!Number.isInteger(returnedQuantity) || returnedQuantity < 1
      || !Number.isInteger(deliveredQuantity) || deliveredQuantity < 1) {
      setValidationError('Quantidades devem ser inteiras e positivas.')
      return
    }
    setValidationError(null)
    const body = JSON.stringify({
      reason,
      returned: [{ variantId: returnedId, quantity: returnedQuantity }],
      delivered: [{ variantId: deliveredId, quantity: deliveredQuantity }],
    })
    const op = { key: crypto.randomUUID(), body }
    if (!savePendingExchange({ ...op, saleId: sale.id, csrf: currentCsrfToken() ?? '' })) {
      setPersistError(true)
      return
    }
    setPersistError(false)
    setConfirmed(false)
    setOperation(op)
    setUncertain(false)
    exchange.mutate(op)
  }
  return <section aria-label="Troca de itens">
    <h3>Registrar troca</h3>
    {confirmed && <Notice tone="success">Troca registrada.</Notice>}
    {exchange.isError && <PageError error={exchange.error} />}
    {validationError && <Notice tone="danger">{validationError}</Notice>}
    {persistError && !exchange.isPending && !uncertain && <Notice tone="danger">Não foi possível garantir a recuperação da troca após recarga; nada foi enviado. Tente novamente.</Notice>}
    {uncertain && !exchange.isPending && <div className="panel"><p>Resposta da troca incerta. Não altere os dados.</p>
      <button className="primary-button" type="button" onClick={() => { if (operation) exchange.mutate(operation) }}>Tentar novamente</button></div>}
    <form className="form-grid" onSubmit={submit}>
      <label className="field"><span>Motivo da troca</span><input name="reason" required disabled={locked} /></label>
      <label className="field"><span>Item vendido (devolver)</span><select name="returnedId" disabled={locked} value={returnedId}
        onChange={(event) => setReturnedId(event.target.value)}>
        <option value="">Selecione</option>
        {sale.items.map((item, index) => <option key={`${item.variantId}-${index}`} value={item.variantId}>
          {variantLabel(item)} · {item.quantity} un. · {formatMoney(item.unitPrice)}
        </option>)}
      </select></label>
      <Field label="Devolver (qtd)" name="returnedQuantity" type="number" required disabled={locked} />
      <label className="field"><span>Buscar variante (entregar)</span>
        <input value={search} disabled={locked} placeholder="Digite ao menos 2 letras"
          onChange={(event) => setSearch(event.target.value)} /></label>
      {search.trim().length >= 2 && (picker.isPending ? <PageState>Buscando variantes…</PageState>
        : picker.isError ? <><PageError error={picker.error} /><button className="secondary-action" type="button" onClick={() => void picker.refetch()}>Buscar novamente</button></>
        : picker.data && (picker.data.items.length === 0 ? <p>Nenhuma variante para esta busca.</p> :
          <fieldset className="panel"><legend>Variantes para entrega</legend>
            {picker.data.items.flatMap((product) => product.variants.map((variant) => {
              const outOfStock = variant.stockQuantity === 0
              return <label className="field" key={variant.id}>
                <input type="radio" name="delivered" disabled={locked || outOfStock} checked={deliveredId === variant.id}
                  onChange={() => setDeliveredId(variant.id)} />
                <span>{product.club} {product.model} · {variant.type} {variant.size} · {variant.sku} · saldo {variant.stockQuantity}{outOfStock ? ' · sem saldo' : ''}</span>
              </label>
            }))}
          </fieldset>))}
      <Field label="Entregar (qtd)" name="deliveredQuantity" type="number" required disabled={locked} />
      <button className="primary-button" disabled={locked}>{exchange.isPending ? 'Registrando…' : 'Registrar troca'}</button>
    </form>
  </section>
}
