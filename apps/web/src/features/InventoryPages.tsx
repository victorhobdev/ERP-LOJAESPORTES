import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useParams } from '@tanstack/react-router'
import { ArrowUpRight, Check, Package, PackagePlus, Plus, Search, SlidersHorizontal, X } from 'lucide-react'
import { type FormEvent, useEffect, useState } from 'react'

import { ApiError, UncertainResultError, api, currentCsrfToken, formatMoney, idempotencyHeaders } from '../lib/api.js'
import { Field, Notice, Page, PageError, PageState, type Product } from './OperationalPages.js'

import './inventory.css'

type StockVariant = {
  id: string; type: string; size: string; sku: string; salePrice: string; stockQuantity: number;
  currentCost?: string; lowStockThreshold: number;
}
type StockProduct = Omit<Product, 'variants'> & {
  description: string | null
  totalStock: number
  lastMovementAt: string | null
  hasImage: boolean
  variants: StockVariant[]
}
type Movement = {
  id: string; variantId: string; productId: string; club: string; model: string; type: string; size: string; sku: string;
  movementType: string; quantityDelta: number; balanceAfter: number; reason: string | null;
  sourceEntityType: string | null; sourceEntityId: string | null;
  userId: string; userDisplayName: string; createdAt: string;
}
type Session = { user: { displayName: string; role: string }; permissions: string[] }

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const imageOptions = [['all', 'Todas'], ['with', 'Com imagem'], ['without', 'Sem imagem']] as const
const sortOptions = [
  ['club:asc', 'Clube · A a Z'], ['club:desc', 'Clube · Z a A'],
  ['model:asc', 'Modelo · A a Z'], ['model:desc', 'Modelo · Z a A'],
  ['stock:desc', 'Maior estoque'], ['stock:asc', 'Menor estoque'],
  ['movement:desc', 'Movimento mais recente'], ['movement:asc', 'Movimento mais antigo'],
] as const
const adultSizes = ['P', 'M', 'G', 'GG', '2GG', '3GG', '4GG']
const childSizes = ['16', '18', '20', '22', '24', '26', '28']

const inventoryFilters = ['search', 'club', 'type', 'size', 'image', 'sort', 'order', 'page'] as const
type InventoryFilter = Record<(typeof inventoryFilters)[number], string>
const inventoryDefaults: InventoryFilter = {
  search: '', club: '', type: '', size: '', image: 'all', sort: 'club', order: 'asc', page: '1',
}

function readUrlFilters(): InventoryFilter {
  const params = new URLSearchParams(window.location.search)
  const next = { ...inventoryDefaults }
  for (const key of inventoryFilters) {
    const value = params.get(key)
    if (value !== null && value !== '') next[key] = value
  }
  return next
}

function useUrlFilters(): [InventoryFilter, (patch: Partial<InventoryFilter>) => void, () => void] {
  const [filters, setFilters] = useState<InventoryFilter>(readUrlFilters)
  function update(patch: Partial<InventoryFilter>) {
    setFilters((current) => {
      const next = { ...current, ...patch }
      if (patch.page === undefined && (patch.search !== undefined || patch.club !== undefined || patch.type !== undefined
        || patch.size !== undefined || patch.image !== undefined || patch.sort !== undefined || patch.order !== undefined)) {
        next.page = '1'
      }
      const params = new URLSearchParams()
      for (const key of inventoryFilters) {
        if (next[key] !== '' && next[key] !== inventoryDefaults[key]) params.set(key, next[key])
      }
      const query = params.toString()
      window.history.replaceState(null, '', `${window.location.pathname}${query === '' ? '' : `?${query}`}`)
      return next
    })
  }
  function clear() {
    window.history.replaceState(null, '', window.location.pathname)
    setFilters({ ...inventoryDefaults })
  }
  return [filters, update, clear]
}

function productsUrl(filters: InventoryFilter): string {
  const params = new URLSearchParams()
  if (filters.search !== '') params.set('search', filters.search)
  if (filters.club !== '') params.set('club', filters.club)
  if (filters.type !== '') params.set('type', filters.type)
  if (filters.size !== '') params.set('size', filters.size)
  params.set('availability', 'in_stock')
  params.set('image', filters.image === '' ? 'all' : filters.image)
  params.set('sort', filters.sort === '' ? 'club' : filters.sort)
  params.set('order', filters.order === '' ? 'asc' : filters.order)
  params.set('page', filters.page === '' ? '1' : filters.page)
  params.set('limit', '20')
  return `/products?${params.toString()}`
}

export function useSessionPermissions(): string[] {
  const session = useQuery({ queryKey: ['session'], queryFn: () => api<Session>('/auth/session'), retry: false, staleTime: 60_000 })
  return session.data?.permissions ?? []
}

function useCanSeeCost(): boolean {
  const permissions = useSessionPermissions()
  return permissions.includes('*') || permissions.includes('products:write')
}

function useCanWriteProducts(): boolean {
  const permissions = useSessionPermissions()
  return permissions.includes('*') || permissions.includes('products:write')
}

function formatDateTime(value: string | null): string {
  if (!value) return '—'
  return new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value))
}

function QueryError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  return <><PageError error={error} /><button className="secondary-action" type="button" onClick={onRetry}>Tentar novamente</button></>
}

export function InventoryPage() {
  const [filters, updateFilters, clearFilters] = useUrlFilters()
  const [showFilters, setShowFilters] = useState(() => filters.club !== '' || filters.image !== 'all')
  const [showCreate, setShowCreate] = useState(false)
  const canWriteProducts = useCanWriteProducts()
  const query = useQuery({
    queryKey: ['products', 'inventory', filters],
    queryFn: () => api<{ items: StockProduct[]; total: number; page: number; limit: number }>(productsUrl(filters)),
    placeholderData: keepPreviousData,
  })
  const hasActiveFilter = inventoryFilters.some((key) => key !== 'page' && filters[key] !== inventoryDefaults[key])
  const extraFilters = Number(filters.club !== '') + Number(filters.image !== 'all')
  const rows = stockRows(query.data?.items ?? [])
  const adultRows = rows.filter((row) => row.type !== 'Infantil')
  const childRows = rows.filter((row) => row.type === 'Infantil')
  const units = rows.reduce((sum, row) => sum + row.total, 0)
  return <div className="inventory-page"><Page title="Estoque" subtitle="Consulte suas peças disponíveis, tamanho por tamanho."
    action={<div className="inventory-actions">
      {canWriteProducts && <button className="secondary-action" type="button" aria-expanded={showCreate} onClick={() => setShowCreate((value) => !value)}>
        {showCreate ? <X size={16} aria-hidden="true" /> : <Plus size={16} aria-hidden="true" />}{showCreate ? 'Fechar formulário' : 'Novo produto'}</button>}
      <a className="primary-action" href="/estoque/entrada"><PackagePlus size={17} aria-hidden="true" />Nova entrada</a>
    </div>}>
    {showCreate && canWriteProducts && <NewProductForm onCreated={() => { void query.refetch() }} />}
    <form className="inventory-filters" role="search" aria-label="Filtros do estoque" onSubmit={(event) => event.preventDefault()}>
      <div className="inventory-filter-row">
        <label className="field inventory-search"><span>Busca</span><span className="inventory-search-control"><Search size={18} aria-hidden="true" />
          <input name="search" value={filters.search} placeholder="Buscar clube, modelo ou SKU…"
            onChange={(event) => updateFilters({ search: event.target.value })} /></span></label>
        <label className="field"><span>Tipo</span><select name="type" value={filters.type} onChange={(event) => updateFilters({ type: event.target.value })}>
          <option value="">Todos os tipos</option><option value="Masculina">Masculina</option><option value="Feminina">Feminina</option><option value="Infantil">Infantil</option>
        </select></label>
        <label className="field"><span>Tamanho</span><input name="size" list="inventory-sizes" placeholder="Todos" value={filters.size}
          onChange={(event) => updateFilters({ size: event.target.value })} /></label>
        <datalist id="inventory-sizes">{[...adultSizes, ...childSizes].map((size) => <option key={size} value={size} />)}</datalist>
        <button className="secondary-action inventory-more" type="button" aria-expanded={showFilters} aria-controls="inventory-extra-filters"
          onClick={() => setShowFilters((value) => !value)}><SlidersHorizontal size={16} aria-hidden="true" />Mais filtros
          {extraFilters > 0 && <span className="inventory-filter-count">{extraFilters}</span>}</button>
      </div>
      {showFilters && <div className="inventory-extra-filters" id="inventory-extra-filters">
        <label className="field"><span>Clube</span><input name="club" value={filters.club} placeholder="Filtrar por clube"
          onChange={(event) => updateFilters({ club: event.target.value })} /></label>
        <label className="field"><span>Imagem</span><select name="image" value={filters.image} onChange={(event) => updateFilters({ image: event.target.value })}>
          {imageOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select></label>
      </div>}
      <div className="inventory-filter-footer"><span className="inventory-available"><Check size={14} aria-hidden="true" />Somente produtos com estoque</span>
        {hasActiveFilter && <button className="inventory-clear" type="button" onClick={clearFilters}><X size={14} aria-hidden="true" />Limpar filtros</button>}
      </div>
    </form>
    <section className="inventory-results" aria-label="Produtos em estoque" aria-busy={query.isFetching}>
      <div className="inventory-results-heading">
        <div><h2>Produtos disponíveis{query.isSuccess && <span className="inventory-product-count">{query.data.total}</span>}</h2>
          <p>{query.isSuccess ? <><strong aria-label="Unidades nesta página">{units}</strong> unidades nesta página<span aria-hidden="true"> · </span></> : null}
            <span role="status">{query.isFetching && !query.isPending ? 'Atualizando estoque…' : 'Quantidades por tamanho'}</span></p></div>
        <label className="inventory-sort"><span>Ordenar por</span><select value={`${filters.sort}:${filters.order}`} onChange={(event) => {
          const [sort, order] = event.target.value.split(':')
          updateFilters({ sort: sort!, order: order! })
        }}>{sortOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      </div>
      {query.isPending ? <PageState>Carregando estoque…</PageState> : query.isError ? <QueryError error={query.error} onRetry={() => void query.refetch()} /> :
        rows.length === 0 ? <div className="inventory-empty"><Package size={32} strokeWidth={1.5} aria-hidden="true" />
          <h3>{hasActiveFilter ? 'Nenhum produto para estes filtros.' : 'Seu estoque está vazio.'}</h3>
          <p>{hasActiveFilter ? 'Tente outro clube, modelo ou tamanho.' : 'Produtos aparecem aqui assim que recebem a primeira unidade.'}</p>
          {hasActiveFilter && <button className="secondary-action" type="button" onClick={clearFilters}>Ver todos os produtos</button>}
          {query.data.page > 1 && <button className="secondary-action" type="button" onClick={() => updateFilters({ page: '1' })}>Voltar à primeira página</button>}
        </div> : <>
          {adultRows.length > 0 && <StockGrid title="Grade adulta" rows={adultRows} baseSizes={adultSizes} />}
          {childRows.length > 0 && <StockGrid title="Grade infantil" rows={childRows} baseSizes={childSizes} />}
          <div className="inventory-pagination"><Pagination page={query.data.page} limit={query.data.limit} total={query.data.total}
            disabled={query.isPlaceholderData} onPage={(page) => updateFilters({ page: String(page) })} /></div>
        </>}
    </section>
  </Page></div>
}

type StockGridRow = { product: StockProduct; type: string; sizes: Map<string, { quantity: number; low: boolean }>; total: number }

function stockRows(products: StockProduct[]): StockGridRow[] {
  return products.flatMap((product) => {
    const types = new Map<string, StockGridRow>()
    for (const variant of product.variants) {
      if (variant.stockQuantity < 1) continue
      const row = types.get(variant.type) ?? { product, type: variant.type, sizes: new Map(), total: 0 }
      const size = variant.size.trim().toUpperCase()
      const cell = row.sizes.get(size)
      row.sizes.set(size, {
        quantity: (cell?.quantity ?? 0) + variant.stockQuantity,
        low: (cell?.low ?? false) || variant.stockQuantity <= variant.lowStockThreshold,
      })
      row.total += variant.stockQuantity
      types.set(variant.type, row)
    }
    return [...types.values()]
  })
}

function StockGrid({ title, rows, baseSizes }: { title: string; rows: StockGridRow[]; baseSizes: string[] }) {
  const extraSizes = [...new Set(rows.flatMap((row) => [...row.sizes.keys()]))].filter((size) => !baseSizes.includes(size))
    .sort((first, second) => first.localeCompare(second, 'pt-BR', { numeric: true }))
  const sizes = [...baseSizes, ...extraSizes]
  if (title === 'Grade infantil') sizes.sort((first, second) => first.localeCompare(second, 'pt-BR', { numeric: true }))
  const hasLowStock = rows.some((row) => [...row.sizes.values()].some((cell) => cell.low))
  return <section className="inventory-grade" aria-label={title}>
    <div className="inventory-grade-heading"><h3>{title}</h3><div className="inventory-legend">
      {hasLowStock && <span><i aria-hidden="true" />Estoque baixo</span>}<span>— Sem estoque</span>
    </div></div>
    <div className="inventory-table-scroll" tabIndex={0} role="region" aria-label={`${title}: role para ver todos os tamanhos`}>
      <table className="inventory-table" aria-label={title} style={{ minWidth: 584 + sizes.length * 48 }}>
        <colgroup><col style={{ width: 140 }} /><col style={{ width: 220 }} /><col style={{ width: 110 }} />
          {sizes.map((size) => <col key={size} />)}<col style={{ width: 66 }} /><col style={{ width: 48 }} /></colgroup>
        <thead><tr><th scope="col" className="inventory-club">Clube</th><th scope="col" className="inventory-model">Modelo</th><th scope="col">Tipo</th>
          {sizes.map((size) => <th scope="col" className="inventory-size" key={size}>{size}</th>)}<th scope="col" className="inventory-total">Total</th><th scope="col"><span className="sr-only">Detalhes</span></th>
        </tr></thead>
        <tbody>{rows.map((row) => <tr key={`${row.product.id}-${row.type}`}>
          <td className="inventory-club">{row.product.club}</td><td className="inventory-model">{row.product.model}</td>
          <td><span className={`inventory-type${row.type === 'Feminina' ? ' inventory-type-female' : row.type === 'Infantil' ? ' inventory-type-child' : ''}`}>{row.type}</span></td>
          {sizes.map((size) => {
            const cell = row.sizes.get(size)
            return <td key={size} className="inventory-size" aria-label={`${size}: ${cell ? `${cell.quantity} unidades${cell.low ? ', estoque baixo' : ''}` : 'sem estoque'}`}>
              {cell ? <span className={`inventory-quantity${cell.low ? ' inventory-quantity-low' : ''}`} title={cell.low ? 'Uma variante está no mínimo definido ou abaixo dele' : undefined}>{cell.quantity}</span> : <span className="inventory-zero">—</span>}
            </td>
          })}
          <td className="inventory-total" aria-label={`Total: ${row.total} unidades`}><strong>{row.total}</strong></td>
          <td className="inventory-detail"><a href={`/estoque/produtos/${row.product.id}`} aria-label={`Ver detalhes de ${row.product.club} ${row.product.model}, ${row.type}`} title="Ver produto e movimentos"><ArrowUpRight size={17} aria-hidden="true" /></a></td>
        </tr>)}</tbody>
        <tfoot><tr><th scope="row" colSpan={3}>Total nesta página</th>{sizes.map((size) => <td className="inventory-size" key={size} aria-label={`Total ${size} nesta página`}>{rows.reduce((sum, row) => sum + (row.sizes.get(size)?.quantity ?? 0), 0) || '—'}</td>)}
          <td className="inventory-total">{rows.reduce((sum, row) => sum + row.total, 0)}</td><td /></tr></tfoot>
      </table>
    </div>
  </section>
}

function Pagination({ page, limit, total, onPage, disabled = false }: { page: number; limit: number; total: number; onPage: (page: number) => void; disabled?: boolean }) {
  const pages = Math.max(1, Math.ceil(total / limit))
  return <nav className="panel" aria-label="Paginação"><span>Página {page} de {pages} · {total} registro(s)</span>{' '}
    <button className="secondary-action" type="button" disabled={disabled || page <= 1} onClick={() => onPage(page - 1)}>Anterior</button>{' '}
    <button className="secondary-action" type="button" disabled={disabled || page >= pages} onClick={() => onPage(page + 1)}>Próxima</button></nav>
}

export function ProductDetailPage({ productId }: { productId?: string } = {}) {
  if (productId !== undefined) return <ProductDetail produtoId={productId} />
  return <RoutedProductDetail />
}

function RoutedProductDetail() {
  const { produtoId } = useParams({ strict: false }) as { produtoId?: string }
  return <ProductDetail produtoId={produtoId} />
}

function ProductDetail({ produtoId }: { produtoId?: string | undefined }) {
  const client = useQueryClient()
  const [movementPage, setMovementPage] = useState(1)
  const product = useQuery({
    queryKey: ['products', produtoId],
    queryFn: () => api<StockProduct>(`/products/${produtoId}`),
    retry: false,
  })
  const movements = useQuery({
    queryKey: ['movements', produtoId, movementPage],
    queryFn: () => api<{ items: Movement[]; total: number; page: number; limit: number }>(
      `/inventory/movements?productId=${produtoId}&page=${movementPage}&limit=10`),
    enabled: product.isSuccess,
    retry: false,
  })
  const canSeeCost = useCanSeeCost()
  const canWriteProducts = useCanWriteProducts()
  if (product.isPending) return <Page title="Produto"><PageState>Carregando produto…</PageState></Page>
  if (product.isError) return <Page title="Produto"><PageError error={product.error} /><p><a href="/estoque">Voltar ao estoque</a></p></Page>
  const data = product.data
  return <Page title={`${data.club} · ${data.model}`} subtitle={data.description ?? ''}
    action={<a className="primary-action" href="/estoque">Voltar ao estoque</a>}>
    <section className="panel" aria-label="Resumo do produto">
      <p>{data.variants.length} variante(s) · saldo {data.totalStock} · último movimento {formatDateTime(data.lastMovementAt)}</p>
      <p>{data.hasImage ? 'Com imagem cadastrada' : 'Sem imagem cadastrada'}</p>
    </section>
    <section className="panel" aria-label="Variantes">
      <h2>Variantes</h2>
      <div className="table-wrap"><table>
        <thead><tr><th>Tipo</th><th>Tamanho</th><th>SKU</th><th>Preço</th>{canSeeCost && <th>Custo</th>}<th>Saldo</th><th>Mínimo</th></tr></thead>
        <tbody>{data.variants.map((variant) => <tr key={variant.id}>
          <td>{variant.type}</td><td>{variant.size}</td><td>{variant.sku}</td><td>{formatMoney(variant.salePrice)}</td>
          {canSeeCost && <td>{variant.currentCost ? formatMoney(variant.currentCost) : '—'}</td>}
          <td>{variant.stockQuantity}</td><td>{variant.lowStockThreshold}</td>
        </tr>)}</tbody>
      </table></div>
    </section>
    <EditProductForm product={data} canWrite={canWriteProducts} onSaved={() => { void client.invalidateQueries({ queryKey: ['products', produtoId] }) }} />
    <section className="panel" aria-label="Histórico de movimentos">
      <h2>Movimentos</h2>
      {movements.isPending ? <PageState>Carregando movimentos…</PageState> : movements.isError ? <QueryError error={movements.error} onRetry={() => void movements.refetch()} /> :
        movements.data.items.length === 0 ? <PageState>Nenhum movimento registrado.</PageState> :
          <><div className="table-wrap"><table>
            <thead><tr><th>Data</th><th>Tipo</th><th>Variante</th><th>Quantidade</th><th>Saldo após</th><th>Motivo</th><th>Origem</th><th>Responsável</th></tr></thead>
            <tbody>{movements.data.items.map((movement) => <tr key={movement.id}>
              <td>{formatDateTime(movement.createdAt)}</td><td>{translateMovement(movement.movementType)}</td>
              <td>{movement.type} · {movement.size} · {movement.sku}</td>
              <td>{movement.quantityDelta > 0 ? `+${movement.quantityDelta}` : movement.quantityDelta}</td>
              <td>{movement.balanceAfter}</td><td>{movement.reason ?? '—'}</td>
              <td>{movement.sourceEntityType ?? '—'}</td><td>{movement.userDisplayName}</td>
            </tr>)}</tbody>
          </table></div>
          <Pagination page={movements.data.page} limit={movements.data.limit} total={movements.data.total}
            onPage={setMovementPage} /></>}
    </section>
  </Page>
}

function translateMovement(value: string): string {
  return ({
    opening_balance: 'Saldo inicial', purchase_receipt: 'Recebimento', sale: 'Venda',
    exchange_in: 'Troca (entrada)', exchange_out: 'Troca (saída)', manual_adjustment: 'Ajuste manual', reversal: 'Estorno',
  } as Record<string, string>)[value] ?? value
}

export function NewProductForm({ onCreated }: { onCreated?: () => void }) {
  const client = useQueryClient()
  const [rows, setRows] = useState([{ type: 'Masculina', size: '', sku: '', salePrice: '', currentCost: '', lowStockThreshold: '0' }])
  const mutation = useMutation({
    mutationFn: (body: object) => api('/products', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['products'] })
      setRows([{ type: 'Masculina', size: '', sku: '', salePrice: '', currentCost: '', lowStockThreshold: '0' }])
      onCreated?.()
    },
  })
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    mutation.mutate({
      club: data.get('club'), model: data.get('model'), description: data.get('description') || undefined,
      variants: rows.map((row) => ({ ...row, lowStockThreshold: Number(row.lowStockThreshold) })),
    })
  }
  return <section className="panel" aria-label="Novo produto">
    <h2>Novo produto</h2>
    {mutation.isSuccess && <Notice tone="success">Produto cadastrado com saldo zero; registre a entrada.</Notice>}
    {mutation.isError && <PageError error={mutation.error} />}
    <form className="form-grid" onSubmit={submit}>
      <Field label="Clube" name="club" required /><Field label="Modelo" name="model" required /><Field label="Descrição" name="description" />
      {rows.map((row, index) => <fieldset key={index} className="panel">
        <legend>Variante {index + 1}</legend>
        <label className="field"><span>Tipo</span><select value={row.type}
          onChange={(event) => setRows((current) => current.map((entry, position) => position === index ? { ...entry, type: event.target.value } : entry))}>
          <option value="Masculina">Masculina</option><option value="Feminina">Feminina</option><option value="Infantil">Infantil</option>
        </select></label>
        {(['size', 'sku', 'salePrice', 'currentCost', 'lowStockThreshold'] as const).map((field) => <label className="field" key={field}>
          <span>{({ size: 'Tamanho', sku: 'SKU', salePrice: 'Preço', currentCost: 'Custo', lowStockThreshold: 'Mínimo' })[field]}</span>
          <input value={row[field]} required={field !== 'lowStockThreshold'}
            onChange={(event) => setRows((current) => current.map((entry, position) => position === index ? { ...entry, [field]: event.target.value } : entry))} />
        </label>)}
        {rows.length > 1 && <button className="secondary-action" type="button"
          onClick={() => setRows((current) => current.filter((_, position) => position !== index))}>Remover variante</button>}
      </fieldset>)}
      <span><button className="secondary-action" type="button" onClick={() => setRows((current) => [...current, { type: 'Masculina', size: '', sku: '', salePrice: '', currentCost: '', lowStockThreshold: '0' }])}>
        Adicionar variante</button>{' '}
        <button className="primary-button" disabled={mutation.isPending}>{mutation.isPending ? 'Salvando…' : 'Cadastrar produto'}</button></span>
    </form>
  </section>
}

export function EditProductForm({ product, canWrite, onSaved }: { product: StockProduct; canWrite: boolean; onSaved?: () => void }) {
  const [saved, setSaved] = useState(false)
  const mutation = useMutation({
    mutationFn: (body: object) => api(`/products/${product.id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    onSuccess: () => { setSaved(true); onSaved?.() },
  })
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setSaved(false)
    const data = new FormData(event.currentTarget)
    mutation.mutate({
      description: String(data.get('description') ?? ''),
      variants: product.variants.map((variant) => ({
        id: variant.id,
        salePrice: String(data.get(`price-${variant.id}`) ?? variant.salePrice),
        lowStockThreshold: Number(data.get(`threshold-${variant.id}`) ?? variant.lowStockThreshold),
      })),
    })
  }
  return <section className="panel" aria-label="Editar produto">
    <h2>Editar metadados e preços</h2>
    {!canWrite ? <PageState>Seu perfil não tem permissão para editar produtos.</PageState> : <>
    {saved && <Notice tone="success">Produto atualizado.</Notice>}
    {mutation.isError && <PageError error={mutation.error} />}
    <form className="form-grid" onSubmit={submit}>
      <label className="field"><span>Descrição</span><input name="description" defaultValue={product.description ?? ''} /></label>
      {product.variants.map((variant) => <fieldset key={variant.id} className="panel">
        <legend>{variant.type} · {variant.size} · {variant.sku}</legend>
        <label className="field"><span>Preço</span><input name={`price-${variant.id}`} defaultValue={variant.salePrice} required /></label>
        <label className="field"><span>Mínimo</span><input name={`threshold-${variant.id}`} type="number" min={0} step={1} defaultValue={variant.lowStockThreshold} required /></label>
      </fieldset>)}
      <button className="primary-button" disabled={mutation.isPending}>{mutation.isPending ? 'Salvando…' : 'Salvar alterações'}</button>
    </form>
    </>}
  </section>
}

type PendingAdjustment = { key: string; body: string; variantId: string; quantityDelta: number; reason: string; csrf: string }
const pendingAdjustmentKey = 'erp.pendingAdjustmentOperation.v1'

function savePendingAdjustment(pending: PendingAdjustment): boolean {
  try {
    const raw = JSON.stringify(pending)
    sessionStorage.setItem(pendingAdjustmentKey, raw)
    return sessionStorage.getItem(pendingAdjustmentKey) === raw
  } catch {
    return false
  }
}

function loadPendingAdjustment(): PendingAdjustment | null {
  let raw: string | null
  try {
    raw = sessionStorage.getItem(pendingAdjustmentKey)
  } catch {
    return null
  }
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<PendingAdjustment>
    if (typeof parsed.key !== 'string' || parsed.key === '' || typeof parsed.body !== 'string'
      || typeof parsed.variantId !== 'string' || !uuidPattern.test(parsed.variantId)
      || typeof parsed.quantityDelta !== 'number' || !Number.isInteger(parsed.quantityDelta)
      || parsed.quantityDelta === 0 || Math.abs(parsed.quantityDelta) > 100_000
      || typeof parsed.reason !== 'string' || parsed.reason.trim() === ''
      || typeof parsed.csrf !== 'string' || parsed.csrf !== (currentCsrfToken() ?? '')) {
      clearPendingAdjustment()
      return null
    }
    const body = JSON.parse(parsed.body) as { variantId?: unknown; quantityDelta?: unknown; reason?: unknown }
    if (body.variantId !== parsed.variantId || body.quantityDelta !== parsed.quantityDelta || body.reason !== parsed.reason) {
      clearPendingAdjustment()
      return null
    }
    return parsed as PendingAdjustment
  } catch {
    clearPendingAdjustment()
    return null
  }
}

function clearPendingAdjustment() {
  try {
    sessionStorage.removeItem(pendingAdjustmentKey)
  } catch {
    return
  }
}

type PickerSelection = { variantId: string; label: string; sku: string; stockQuantity: number; salePrice: string }

export function StockEntryPage() {
  const client = useQueryClient()
  const [search, setSearch] = useState('')
  const [selection, setSelection] = useState<PickerSelection | null>(null)
  const [operation, setOperation] = useState<{ key: string; body: string } | null>(null)
  const [uncertain, setUncertain] = useState(false)
  const [persistError, setPersistError] = useState(false)
  const [result, setResult] = useState<{ balanceAfter: number } | null>(null)
  const picker = useQuery({
    queryKey: ['products', 'picker', search],
    queryFn: () => api<{ items: Array<Product & { variants: StockVariant[] }> }>(`/products?search=${encodeURIComponent(search)}&limit=20`),
    enabled: search.trim().length >= 2,
    retry: false,
  })
  const adjustment = useMutation({
    mutationFn: async (op: { key: string; body: string }) => {
      const response = await api<{ id: string; variantId: string; quantityDelta: number; balanceAfter: number }>('/inventory/movements', {
        method: 'POST', headers: idempotencyHeaders(op.key), body: op.body,
      })
      if (!response || typeof response.balanceAfter !== 'number') throw new UncertainResultError(201)
      return response
    },
    onSuccess: async (response) => {
      setResult({ balanceAfter: response.balanceAfter })
      setOperation(null); setUncertain(false); setPersistError(false)
      clearPendingAdjustment()
      await client.invalidateQueries({ queryKey: ['products'] })
      await client.invalidateQueries({ queryKey: ['inventory'] })
      await client.invalidateQueries({ queryKey: ['dashboard'] })
    },
    onError: (error) => {
      if (error instanceof TypeError || error instanceof UncertainResultError || (error instanceof ApiError && error.status >= 500)) {
        setUncertain(true)
        return
      }
      setUncertain(false)
      setOperation(null)
      clearPendingAdjustment()
    },
  })
  const locked = adjustment.isPending || uncertain
  useEffect(() => {
    const pending = loadPendingAdjustment()
    if (pending) {
      setOperation({ key: pending.key, body: pending.body })
      setUncertain(true)
    }
  }, [])
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (locked && operation) {
      adjustment.mutate(operation)
      return
    }
    if (!selection) return
    const data = new FormData(event.currentTarget)
    const quantityDelta = Number(data.get('quantityDelta'))
    const reason = String(data.get('reason') ?? '').trim()
    if (!Number.isInteger(quantityDelta) || quantityDelta === 0 || reason === '') return
    const body = JSON.stringify({ variantId: selection.variantId, quantityDelta, reason })
    const op = { key: crypto.randomUUID(), body }
    if (!savePendingAdjustment({ ...op, variantId: selection.variantId, quantityDelta, reason, csrf: currentCsrfToken() ?? '' })) {
      setPersistError(true)
      return
    }
    setPersistError(false)
    setResult(null)
    setOperation(op)
    setUncertain(false)
    adjustment.mutate(op)
  }
  return <Page title="Entrada de estoque" subtitle="Ajuste manual auditável; vendas, compras e trocas usam o fluxo de origem."
    action={<a className="primary-action" href="/estoque">Voltar ao estoque</a>}>
    {result && <Notice tone="success">Ajuste registrado. Saldo atual: {result.balanceAfter}.</Notice>}
    {adjustment.isError && <PageError error={adjustment.error} />}
    {persistError && !adjustment.isPending && !uncertain && <Notice tone="danger">Não foi possível garantir a recuperação do ajuste após recarga; nada foi enviado. Tente novamente.</Notice>}
    {uncertain && !adjustment.isPending && <div className="panel"><p>Resposta do ajuste incerta. Não altere os dados.</p>
      <button className="primary-button" type="button" onClick={() => { if (operation) adjustment.mutate(operation) }}>Tentar novamente</button></div>}
    <form className="panel form-grid" onSubmit={submit}>
      <label className="field"><span>Buscar variante (clube, modelo ou SKU)</span>
        <input value={search} disabled={locked} placeholder="Digite ao menos 2 letras"
          onChange={(event) => { setSearch(event.target.value); setSelection(null) }} /></label>
      {picker.isPending && search.trim().length >= 2 ? <PageState>Buscando variantes…</PageState> : picker.isError ? <PageError error={picker.error} /> :
        picker.data && (picker.data.items.length === 0 ? <PageState>Nenhuma variante para esta busca.</PageState> :
          <fieldset className="panel"><legend>Variantes encontradas</legend>
            {picker.data.items.flatMap((product) => product.variants.map((variant) => <label className="field" key={variant.id}>
              <input type="radio" name="variant" disabled={locked} checked={selection?.variantId === variant.id}
                onChange={() => setSelection({
                  variantId: variant.id, label: `${product.club} ${product.model} · ${variant.type} ${variant.size}`,
                  sku: variant.sku, stockQuantity: variant.stockQuantity, salePrice: variant.salePrice,
                })} />
              <span>{product.club} {product.model} · {variant.type} {variant.size} · {variant.sku} · saldo {variant.stockQuantity}</span>
            </label>))}
          </fieldset>)}
      {selection && <p aria-live="polite">Selecionada: {selection.label} · {selection.sku} · saldo {selection.stockQuantity} · {formatMoney(selection.salePrice)}</p>}
      <Field label="Quantidade (+ entrada / − saída)" name="quantityDelta" type="number" required />
      <Field label="Motivo (obrigatório)" name="reason" required />
      <button className="primary-button" disabled={!selection || adjustment.isPending}>
        {adjustment.isPending ? 'Registrando…' : 'Registrar ajuste'}
      </button>
    </form>
  </Page>
}
