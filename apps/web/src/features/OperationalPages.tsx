import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { type FormEvent, useMemo, useState } from 'react'

import { ApiError, api, formatMoney, idempotencyHeaders } from '../lib/api.js'

type Variant = { id: string; type: string; size: string; sku: string; salePrice: string; stockQuantity: number }
type Product = { id: string; club: string; model: string; variants: Variant[] }
type Dashboard = {
  date: string; timezone: string; salesCreatedToday: string; confirmedPaymentsToday: string;
  pendingSalesCount: number; overdueSalesCount: number; lowStockVariants: number; outOfStockVariants: number;
  openPurchaseOrders: number; pendingPurchaseUnits: number; openCustomerOrders: number;
}

export function LoginPage() {
  const mutation = useMutation({
    mutationFn: (credentials: { username: string; password: string }) => api('/auth/login', { method: 'POST', body: JSON.stringify(credentials) }),
    onSuccess: () => { window.location.assign('/inicio') },
  })
  return <Page title="Entrar no ERP" subtitle="Use sua conta operacional.">
    <form className="panel form-grid login-form" onSubmit={(event) => {
      event.preventDefault(); const data = new FormData(event.currentTarget)
      mutation.mutate({ username: String(data.get('username')), password: String(data.get('password')) })
    }}>
      <Field label="Usuário" name="username" required /><Field label="Senha" name="password" type="password" required />
      <button className="primary-button" disabled={mutation.isPending}>{mutation.isPending ? 'Entrando…' : 'Entrar'}</button>
    </form>
    {mutation.isError && <PageError error={mutation.error} />}
  </Page>
}

export function DashboardPage({ date = localDate() }: { date?: string }) {
  const query = useQuery({ queryKey: ['dashboard', date], queryFn: () => api<Dashboard>(`/dashboard?date=${date}`) })
  if (query.isPending) return <PageState>Carregando visão da operação…</PageState>
  if (query.isError) return <PageError error={query.error} />
  const data = query.data
  return <Page title="Visão da operação" subtitle={`Atualizado para ${formatDate(date)} · ${data.timezone}`}>
    <section className="metrics" aria-label="Indicadores operacionais">
      <Metric label="Recebido hoje" value={formatMoney(data.confirmedPaymentsToday)} detail="Caixa por data de recebimento" tone="brand" />
      <Metric label="Vendas criadas hoje" value={formatMoney(data.salesCreatedToday)} detail="Base: data da venda" tone="neutral" />
      <Metric label="Pagamentos pendentes" value={String(data.pendingSalesCount)} detail={`${data.overdueSalesCount} vencida${data.overdueSalesCount === 1 ? '' : 's'}`} tone="warning" />
      <Metric label="Estoque crítico" value={String(data.lowStockVariants + data.outOfStockVariants)} detail={`${data.outOfStockVariants} sem saldo`} tone="danger" />
    </section>
    <section className="panel compact-grid" aria-label="Trabalho em aberto">
      <Stat label="Pedidos de compra" value={data.openPurchaseOrders} detail={`${data.pendingPurchaseUnits} unidades a receber`} />
      <Stat label="Encomendas" value={data.openCustomerOrders} detail="a acompanhar" />
      <Stat label="Estoque baixo" value={data.lowStockVariants} detail="variantes com reposição necessária" />
    </section>
  </Page>
}

export function NewSalePage() {
  const products = useQuery({ queryKey: ['products'], queryFn: () => api<{ items: Product[] }>('/products') })
  const [cart, setCart] = useState<Array<Variant & { label: string; quantity: number }>>([])
  const [success, setSuccess] = useState(false)
  const total = useMemo(() => cart.reduce((sum, item) => sum + Number(item.salePrice) * item.quantity, 0).toFixed(2), [cart])
  const sale = useMutation({
    mutationFn: () => api<{ id: string }>('/sales', {
      method: 'POST', headers: idempotencyHeaders(),
      body: JSON.stringify({
        items: cart.map(({ id, quantity }) => ({ variantId: id, quantity })),
        discountAmount: '0.00', payment: { amount: total, method: 'pix' },
      }),
    }),
    onSuccess: () => { setCart([]); setSuccess(true) },
  })
  function add(product: Product, variant: Variant) {
    setSuccess(false)
    setCart((current) => {
      const item = current.find(({ id }) => id === variant.id)
      if (item) return current.map((entry) => entry.id === variant.id && entry.quantity < variant.stockQuantity ? { ...entry, quantity: entry.quantity + 1 } : entry)
      return [...current, { ...variant, label: `${product.club} ${product.model}`, quantity: 1 }]
    })
  }
  return <Page title="Nova venda" subtitle="O preço e o estoque serão recalculados pela API antes da confirmação.">
    {success && <Notice tone="success">Venda concluída</Notice>}
    {sale.isError && <PageError error={sale.error} />}
    <div className="split-layout">
      <section className="panel">
        <h2>Produtos disponíveis</h2>
        {products.isPending ? <PageState>Buscando produtos…</PageState> : products.isError ? <PageError error={products.error} /> :
          <div className="item-grid">{products.data.items.flatMap((product) => product.variants.map((variant) =>
            <button className="select-card" type="button" disabled={variant.stockQuantity === 0} key={variant.id}
              aria-label={`Adicionar ${product.club} ${product.model}, tamanho ${variant.size}`} onClick={() => add(product, variant)}>
              <strong>{product.club} · {product.model}</strong><span>{variant.type} · {variant.size} · {variant.sku}</span>
              <span>{formatMoney(variant.salePrice)} · saldo {variant.stockQuantity}</span>
            </button>))}</div>}
      </section>
      <aside className="panel cart" aria-label="Carrinho da venda">
        <h2>Carrinho</h2>
        {cart.length === 0 ? <p className="muted">Adicione um produto para começar.</p> : <ul className="plain-list">{cart.map((item) =>
          <li key={item.id}><span><strong>{item.label}</strong><small>{item.sku} · {item.quantity} un.</small></span><b>{formatMoney((Number(item.salePrice) * item.quantity).toFixed(2))}</b></li>)}</ul>}
        <div className="total"><span>Total</span><strong>{formatMoney(total)}</strong></div>
        <button className="primary-button" type="button" disabled={!cart.length || sale.isPending} onClick={() => sale.mutate()}>
          {sale.isPending ? 'Finalizando…' : 'Finalizar venda'}
        </button>
      </aside>
    </div>
  </Page>
}

export function SalesPage() {
  const query = useQuery({ queryKey: ['sales'], queryFn: () => api<{ items: Array<{ id: string; status: string; finalAmount: string; createdAt: string; customerName?: string }> }>('/sales') })
  return <ListPage title="Vendas" action="/vendas/nova" actionLabel="Nova venda" query={query} columns={[
    ['Venda', (row) => String(row.id).slice(0, 8)], ['Cliente', (row) => String(row.customerName ?? 'Consumidor Final')],
    ['Status', (row) => translateStatus(String(row.status))], ['Total', (row) => formatMoney(String(row.finalAmount))],
  ]} />
}

export function InventoryPage() {
  const client = useQueryClient()
  const query = useQuery({ queryKey: ['inventory'], queryFn: () => api<{ items: Array<Record<string, unknown>> }>('/inventory') })
  const [message, setMessage] = useState<string>()
  const mutation = useMutation({ mutationFn: (body: object) => api('/inventory/movements', { method: 'POST', headers: idempotencyHeaders(), body: JSON.stringify(body) }),
    onSuccess: async () => { setMessage('Ajuste registrado.'); await client.invalidateQueries({ queryKey: ['inventory'] }) } })
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const data = new FormData(event.currentTarget)
    mutation.mutate({ variantId: data.get('variantId'), quantityDelta: Number(data.get('quantityDelta')), reason: data.get('reason') })
  }
  return <Page title="Estoque" subtitle="Saldo atual e ajuste manual auditável.">
    <form className="panel inline-form" onSubmit={submit}>
      <Field label="Variante (UUID)" name="variantId" required /><Field label="Quantidade (+/-)" name="quantityDelta" type="number" required />
      <Field label="Motivo" name="reason" required /><button className="primary-button" disabled={mutation.isPending}>Registrar ajuste</button>
    </form>
    {message && <Notice tone="success">{message}</Notice>}{mutation.isError && <PageError error={mutation.error} />}
    <DataTable query={query} columns={[
      ['Produto', (r) => `${r.club} · ${r.model}`], ['Variante', (r) => `${r.type} · ${r.size}`], ['SKU', (r) => String(r.sku)],
      ['Saldo', (r) => String(r.stockQuantity)], ['Mínimo', (r) => String(r.lowStockThreshold)],
    ]} />
  </Page>
}

export function PurchasesPage() {
  const query = useQuery({ queryKey: ['purchases'], queryFn: () => api<{ items: Array<Record<string, unknown>> }>('/purchase-orders') })
  return <ListPage title="Compras de fornecedores" action="/compras/nova" actionLabel="Novo pedido" query={query} columns={[
    ['Fornecedor', (r) => String(r.supplierName)], ['Data', (r) => formatDate(String(r.orderedOn))], ['Status', (r) => translateStatus(String(r.status))],
    ['Pendente', (r) => `${r.pendingQuantity} un.`], ['Total', (r) => formatMoney(String(r.finalAmount))],
  ]} />
}

export function NewPurchasePage() {
  return <MutationForm title="Novo pedido de compra" path="/purchase-orders" build={(data) => ({
    supplierId: data.get('supplierId'), orderedOn: data.get('orderedOn'), importFeeAmount: String(data.get('importFeeAmount')),
    items: [{ variantId: data.get('variantId'), orderedQuantity: Number(data.get('quantity')), supplierUnitCost: data.get('unitCost') }],
  })} fields={[['supplierId', 'Fornecedor (UUID)', 'text'], ['orderedOn', 'Data do pedido', 'date'], ['variantId', 'Variante (UUID)', 'text'],
    ['quantity', 'Quantidade', 'number'], ['unitCost', 'Custo unitário', 'text'], ['importFeeAmount', 'Taxa de importação', 'text']]} />
}

export function CustomerOrdersPage() {
  const query = useQuery({ queryKey: ['customer-orders'], queryFn: () => api<{ items: Array<Record<string, unknown>> }>('/customer-orders') })
  return <Page title="Encomendas de clientes" subtitle="Solicitações livres; nenhuma compra ou reserva é criada automaticamente.">
    <DataTable query={query} columns={[
      ['Cliente', (r) => String(r.customerName)], ['Produto solicitado', (r) => `${r.club} · ${r.model}`],
      ['Variante', (r) => `${r.type} · ${r.size}`], ['Status', (r) => translateStatus(String(r.status))],
    ]} />
  </Page>
}

export function FinancialReportPage() {
  const { from, to } = currentMonth()
  const query = useQuery({ queryKey: ['financial-report', from, to], queryFn: () => api<Record<string, string>>(`/reports/financial?from=${from}&to=${to}`) })
  if (query.isPending) return <PageState>Carregando relatório…</PageState>
  if (query.isError) return <PageError error={query.error} />
  return <Page title="Relatório financeiro" subtitle={`${formatDate(from)} a ${formatDate(to)} · bases separadas e explícitas`}>
    <section className="metrics"><Metric label="Vendas pela data da venda" value={formatMoney(query.data.salesBySaleDate!)} detail="Competência operacional" tone="brand" />
      <Metric label="Recebimentos confirmados" value={formatMoney(query.data.confirmedPaymentsByReceiptDate!)} detail="Data do recebimento" tone="neutral" />
      <Metric label="Saldo pendente" value={formatMoney(query.data.outstandingForPeriodSales!)} detail="das vendas do período" tone="warning" />
      <Metric label="Lucro bruto" value={formatMoney(query.data.grossProfitOnSalesBasis!)} detail={`Margem ${query.data.grossMarginPercentOnSalesBasis}%`} tone="brand" /></section>
  </Page>
}

export function ProductReportPage() {
  const { from, to } = currentMonth()
  const query = useQuery({ queryKey: ['product-report', from, to], queryFn: () => api<{ items: Array<Record<string, unknown>> }>(`/reports/products?from=${from}&to=${to}`) })
  return <Page title="Relatório de produtos" subtitle={`${formatDate(from)} a ${formatDate(to)}`}><DataTable query={query} columns={[
    ['Produto', (r) => `${r.club} · ${r.model}`], ['Variante', (r) => `${r.type} · ${r.size}`], ['Vendidas', (r) => String(r.unitsSold)],
    ['Vendas', (r) => formatMoney(String(r.salesAmount))], ['Lucro bruto', (r) => formatMoney(String(r.grossProfit))], ['Saldo atual', (r) => String(r.currentStockQuantity)],
  ]} /></Page>
}

export function CatalogPage() {
  const query = useQuery({ queryKey: ['products'], queryFn: () => api<{ items: Product[] }>('/products') })
  return <Page title="Catálogo" subtitle="Visão publicável dos produtos; imagens externas aguardam configuração de armazenamento.">
    {query.isPending ? <PageState>Carregando catálogo…</PageState> : query.isError ? <PageError error={query.error} /> :
      <div className="catalog-grid">{query.data.items.map((product) => <article className="panel" key={product.id}><div className="image-placeholder" aria-hidden="true">{product.club.slice(0, 2).toUpperCase()}</div><h2>{product.club}</h2><p>{product.model}</p><small>{product.variants.length} variantes</small></article>)}</div>}
  </Page>
}

export function SettingsPage() {
  const session = useQuery({ queryKey: ['session'], queryFn: () => api<{ user: { displayName: string; role: string }; permissions: string[] }>('/auth/session') })
  return <Page title="Configurações" subtitle="Sessão e ambiente atual."><section className="panel">
    {session.isPending ? 'Carregando sessão…' : session.isError ? <PageError error={session.error} /> : <><h2>{session.data.user.displayName}</h2><p>Perfil: {session.data.user.role}</p><p>{session.data.permissions.length} permissões efetivas</p></>}
  </section></Page>
}

type AnyRow = Record<string, unknown>
type Column = [string, (row: AnyRow) => string]
function ListPage({ title, action, actionLabel, query, columns }: { title: string; action: string; actionLabel: string; query: ReturnType<typeof useQuery<{ items: AnyRow[] }>>; columns: Column[] }) {
  return <Page title={title} action={<a className="primary-action" href={action}>{actionLabel}</a>}><DataTable query={query} columns={columns} /></Page>
}
function DataTable({ query, columns }: { query: ReturnType<typeof useQuery<{ items: AnyRow[] }>>; columns: Column[] }) {
  if (query.isPending) return <PageState>Carregando dados…</PageState>
  if (query.isError) return <PageError error={query.error} />
  if (!query.data.items.length) return <PageState>Nenhum registro encontrado.</PageState>
  return <div className="table-wrap"><table><thead><tr>{columns.map(([label]) => <th key={label}>{label}</th>)}</tr></thead><tbody>{query.data.items.map((row, index) =>
    <tr key={String(row.id ?? index)}>{columns.map(([label, render]) => <td key={label}>{render(row)}</td>)}</tr>)}</tbody></table></div>
}
function MutationForm({ title, path, fields, build }: { title: string; path: string; fields: Array<[string, string, string]>; build: (data: FormData) => object }) {
  const mutation = useMutation({ mutationFn: (body: object) => api(path, { method: 'POST', headers: idempotencyHeaders(), body: JSON.stringify(body) }) })
  return <Page title={title}><form className="panel form-grid" onSubmit={(event) => { event.preventDefault(); mutation.mutate(build(new FormData(event.currentTarget))) }}>
    {fields.map(([name, label, type]) => <Field key={name} name={name} label={label} type={type} required />)}
    <button className="primary-button" disabled={mutation.isPending}>{mutation.isPending ? 'Salvando…' : 'Salvar pedido'}</button>
  </form>{mutation.isSuccess && <Notice tone="success">Pedido registrado.</Notice>}{mutation.isError && <PageError error={mutation.error} />}</Page>
}
function Field({ label, name, type = 'text', required }: { label: string; name: string; type?: string; required?: boolean }) { return <label className="field"><span>{label}</span><input name={name} type={type} required={required} /></label> }
function Page({ title, subtitle, action, children }: { title: string; subtitle?: string; action?: React.ReactNode; children: React.ReactNode }) { return <div className="page-stack"><header className="page-header"><div><p className="eyebrow">ERP 2.0</p><h1>{title}</h1>{subtitle && <p>{subtitle}</p>}</div>{action}</header>{children}</div> }
function PageState({ children }: { children: React.ReactNode }) { return <section className="panel page-state" role="status">{children}</section> }
function PageError({ error }: { error: unknown }) { const message = error instanceof ApiError ? error.message : 'Falha ao carregar os dados.'; return <Notice tone="danger">{message}</Notice> }
function Notice({ children, tone }: { children: React.ReactNode; tone: string }) { return <div className={`notice notice-${tone}`} role={tone === 'danger' ? 'alert' : 'status'}>{children}</div> }
function Metric({ label, value, detail, tone }: { label: string; value: string; detail: string; tone: string }) { return <article className={`metric metric-${tone}`}><p>{label}</p><strong>{value}</strong><small>{detail}</small></article> }
function Stat({ label, value, detail }: { label: string; value: number; detail: string }) { return <div className="stat"><span>{label}</span><strong>{value}</strong><small>{detail}</small></div> }
function localDate() { return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date()) }
function currentMonth() { const today = localDate(); return { from: `${today.slice(0, 7)}-01`, to: today } }
function formatDate(value: string) { return new Intl.DateTimeFormat('pt-BR', { timeZone: 'UTC' }).format(new Date(`${value}T00:00:00Z`)) }
function translateStatus(value: string) { return ({ paid: 'Pago', pending: 'Pendente', partially_paid: 'Parcial', placed: 'Realizado', partially_received: 'Recebido parcialmente', fully_received: 'Recebido', supplier_ordered: 'Pedido ao fornecedor', product_arrived: 'Produto chegou', delivered: 'Entregue', cancelled: 'Cancelado' } as Record<string, string>)[value] ?? value }
