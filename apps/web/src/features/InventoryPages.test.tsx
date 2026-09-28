import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { InventoryPage, ProductDetailPage, StockEntryPage } from './InventoryPages.js'

afterEach(() => {
  vi.unstubAllGlobals()
  sessionStorage.clear()
  document.cookie = 'erp_csrf=; Max-Age=0'
  window.history.replaceState(null, '', '/estoque')
})

function renderWithQuery(ui: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
}

const variantId = '11111111-1111-4111-8111-111111111111'
function stockProduct() {
  return {
    id: 'product-1', club: 'Flamengo', model: 'Home', description: null,
    totalStock: 2, lastMovementAt: '2026-09-03T10:00:00.000Z', hasImage: false,
    variants: [{
      id: variantId, type: 'Masculina', size: 'M', sku: 'FLA-M',
      salePrice: '150.00', currentCost: '80.00', stockQuantity: 2, lowStockThreshold: 1,
    }],
  }
}
function productsListResponse() {
  return { items: [stockProduct()], total: 1, page: 1, limit: 20 }
}
function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } })
}

describe('paginas de estoque', () => {
  it('review: typing a search character preserves input focus', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => Promise.resolve(jsonResponse(productsListResponse()))))
    renderWithQuery(<InventoryPage />)
    await screen.findByRole('table', { name: 'Grade adulta' })
    const input = screen.getByRole('textbox', { name: 'Busca' })
    input.focus()
    fireEvent.change(input, { target: { value: 'F' } })
    expect(screen.getByRole('textbox', { name: 'Busca' })).toHaveFocus()
  })

function managerSession() {
  return { user: { displayName: 'Gestor', role: 'manager' }, permissions: ['*'] }
}

function stubFetch(handler: (url: string, init?: RequestInit) => { payload: unknown; status?: number }) {
  const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    const { payload, status } = handler(String(url), init)
    return Promise.resolve(jsonResponse(payload, status))
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function productsHandler(payload: unknown = productsListResponse()) {
  return (url: string) => url.endsWith('/api/auth/session')
    ? { payload: managerSession() }
    : { payload }
}

  it('consulta somente saldo positivo mesmo em URLs antigas e ao limpar filtros', async () => {
    window.history.replaceState(null, '', '/estoque?availability=all&search=Fla&page=3')
    const fetchMock = stubFetch(productsHandler())
    renderWithQuery(<InventoryPage />)
    await screen.findByRole('table', { name: 'Grade adulta' })
    fireEvent.click(screen.getByRole('button', { name: 'Limpar filtros' }))
    await waitFor(() => expect(window.location.search).toBe(''))
    const urls = fetchMock.mock.calls.map(([url]) => String(url)).filter((url) => url.includes('/api/products'))
    expect(urls.length).toBeGreaterThan(0)
    expect(urls.every((url) => url.includes('availability=in_stock'))).toBe(true)
    expect(screen.queryByLabelText('Disponibilidade')).not.toBeInTheDocument()
  })

  it('separa tipos e grades, soma cada tamanho e nao exibe produtos ou tipos zerados', async () => {
    const base = stockProduct()
    const variant = base.variants[0]!
    stubFetch(productsHandler({ items: [
      { ...base, totalStock: 999, variants: [
        variant,
        { ...variant, id: 'v2', stockQuantity: 3 },
        { ...variant, id: 'v3', size: 'P', stockQuantity: 0 },
        { ...variant, id: 'v4', type: 'Feminina', size: 'G', stockQuantity: 1 },
        { ...variant, id: 'v5', type: 'Infantil', size: '10', stockQuantity: 4 },
        { ...variant, id: 'v6', size: 'XG', stockQuantity: 2 },
      ] },
      { ...base, id: 'zero', club: 'Zerado', totalStock: 0, variants: [{ ...variant, stockQuantity: 0 }] },
      { ...base, id: 'only-adult', club: 'Vasco', variants: [variant, { ...variant, id: 'v7', type: 'Infantil', size: '16', stockQuantity: 0 }] },
    ], total: 3, page: 1, limit: 20 }))
    renderWithQuery(<InventoryPage />)
    const adult = await screen.findByRole('table', { name: 'Grade adulta' })
    const child = screen.getByRole('table', { name: 'Grade infantil' })
    const male = within(adult).getByRole('row', { name: /Flamengo Home Masculina/ })
    expect(within(male).getByRole('cell', { name: 'M: 5 unidades' })).toBeVisible()
    expect(within(male).getByRole('cell', { name: 'Total: 7 unidades' })).toBeVisible()
    expect(within(male).getByRole('cell', { name: 'P: sem estoque' })).toHaveTextContent('—')
    expect(within(adult).getByRole('columnheader', { name: 'XG' })).toBeVisible()
    expect(within(child).getByRole('cell', { name: '10: 4 unidades' })).toBeVisible()
    expect(within(child).queryByText('Vasco')).not.toBeInTheDocument()
    expect(screen.queryByText('Zerado')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Unidades nesta página')).toHaveTextContent('14')
    expect(screen.queryByText('999')).not.toBeInTheDocument()
  })

  it('mostra estado vazio de estoque e mantem acesso a nova entrada', async () => {
    stubFetch(productsHandler({ items: [], total: 0, page: 1, limit: 20 }))
    renderWithQuery(<InventoryPage />)
    expect(await screen.findByText('Seu estoque está vazio.')).toBeVisible()
    expect(screen.getByRole('link', { name: 'Nova entrada' })).toHaveAttribute('href', '/estoque/entrada')
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
  })

  it('organiza filtros extras e reseta a pagina ao mudar a ordenacao', async () => {
    window.history.replaceState(null, '', '/estoque?page=2')
    stubFetch(productsHandler({ ...productsListResponse(), total: 45, page: 2 }))
    renderWithQuery(<InventoryPage />)
    await screen.findByRole('table', { name: 'Grade adulta' })
    expect(screen.getByRole('button', { name: 'Anterior' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Próxima' })).toBeEnabled()
    const more = screen.getByRole('button', { name: /Mais filtros/ })
    expect(more).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(more)
    expect(screen.getByRole('textbox', { name: 'Clube' })).toBeVisible()
    fireEvent.change(screen.getByRole('combobox', { name: 'Ordenar por' }), { target: { value: 'stock:desc' } })
    await waitFor(() => expect(window.location.search).toContain('sort=stock'))
    expect(window.location.search).toContain('order=desc')
    expect(window.location.search).not.toContain('page=2')
  })

  it('le filtros da URL e reflete mudancas na URL', async () => {
    window.history.replaceState(null, '', '/estoque?search=Fla&image=with')
    const fetchMock = stubFetch(productsHandler())
    renderWithQuery(<InventoryPage />)

    await screen.findByRole('table', { name: 'Grade adulta' })
    const productsUrls = fetchMock.mock.calls.map(([url]) => String(url)).filter((url) => url.includes('/api/products'))
    expect(productsUrls[0]).toContain('search=Fla')
    expect(productsUrls[0]).toContain('availability=in_stock')
    expect(productsUrls[0]).toContain('image=with')

    fireEvent.change(screen.getByLabelText('Tipo'), { target: { value: 'Masculina' } })
    await waitFor(() => expect(window.location.search).toContain('type=Masculina'))
    await waitFor(() => {
      const urls = fetchMock.mock.calls.map(([url]) => String(url))
      expect(urls.some((url) => url.includes('type=Masculina'))).toBe(true)
    })
  })

  it('digitar nos filtros preserva o foco sem remontar o campo', async () => {
    stubFetch(productsHandler())
    renderWithQuery(<InventoryPage />)
    await screen.findByRole('table', { name: 'Grade adulta' })

    const search = screen.getByRole('textbox', { name: 'Busca' })
    search.focus()
    fireEvent.change(search, { target: { value: 'F' } })
    expect(document.activeElement).toBe(search)
    fireEvent.change(search, { target: { value: 'Fl' } })
    expect(document.activeElement).toBe(search)
    expect(window.location.search).toContain('search=Fl')
  })

  it('limpa os filtros e mostra as quantidades sem precisar expandir', async () => {
    window.history.replaceState(null, '', '/estoque?search=zzz')
    stubFetch((url) => url.endsWith('/api/auth/session')
      ? { payload: managerSession() }
      : url.includes('search=zzz')
        ? { payload: { items: [], total: 0, page: 1, limit: 20 } }
        : { payload: productsListResponse() })
    renderWithQuery(<InventoryPage />)

    expect(await screen.findByText('Nenhum produto para estes filtros.')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Ver todos os produtos' }))
    expect(window.location.search).toBe('')
    const table = await screen.findByRole('table', { name: 'Grade adulta' })
    expect(within(table).getByRole('columnheader', { name: 'M' })).toBeVisible()
    expect(screen.getByRole('cell', { name: 'M: 2 unidades' })).toBeVisible()
    expect(screen.queryByRole('button', { name: /Expandir/ })).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Ver detalhes de Flamengo Home, Masculina' })).toHaveAttribute('href', '/estoque/produtos/product-1')
  })

  it('mostra erro recuperavel com nova tentativa', async () => {
    let productsCalls = 0
    stubFetch((url) => {
      if (url.endsWith('/api/auth/session')) return { payload: managerSession() }
      productsCalls += 1
      return productsCalls === 1
        ? { payload: { code: 'INTERNAL_ERROR', message: 'Falha.' }, status: 500 }
        : { payload: productsListResponse() }
    })
    renderWithQuery(<InventoryPage />)

    expect(await screen.findByText('Falha.')).toBeVisible()
    fireEvent.click(await screen.findByRole('button', { name: 'Tentar novamente' }))
    await screen.findByRole('table', { name: 'Grade adulta' })
  })

  it('detalhe invalido e inexistente sao controlados com retorno', async () => {
    stubFetch((url) => url.endsWith('/api/auth/session')
      ? { payload: managerSession() }
      : { payload: { code: 'VALIDATION_ERROR', message: 'Produto inválido.' }, status: 400 })
    const { unmount } = renderWithQuery(<ProductDetailPage productId="nao-uuid" />)
    expect(await screen.findByText('Produto inválido.')).toBeVisible()
    expect(screen.getByRole('link', { name: 'Voltar ao estoque' })).toHaveAttribute('href', '/estoque')
    unmount()
  })

  it('detalhe exibe movimentos reais e edicao auditada preserva o formulario em erro', async () => {
    stubFetch((url, init) => {
      if (url.endsWith('/api/auth/session')) return { payload: managerSession() }
      if (url.includes('/api/inventory/movements')) return { payload: { items: [], total: 0, page: 1, limit: 10 } }
      if (init?.method === 'PATCH') return { payload: { code: 'PRODUCT_ALREADY_EXISTS', message: 'Produto ou variante já cadastrado.' }, status: 409 }
      return { payload: stockProduct() }
    })
    renderWithQuery(<ProductDetailPage productId="product-1" />)

    expect(await screen.findByText('Nenhum movimento registrado.')).toBeVisible()
    expect(screen.getAllByText('FLA-M', { exact: false })).not.toHaveLength(0)

    fireEvent.click(screen.getByRole('button', { name: 'Salvar alterações' }))
    expect(await screen.findByText('Produto ou variante já cadastrado.')).toBeVisible()
    expect(screen.getByRole('textbox', { name: 'Descrição' })).toHaveValue('')
  })

  it('oculta cadastro e edicao sem products:write', async () => {
    stubFetch((url) => url.endsWith('/api/auth/session')
      ? { payload: { user: { displayName: 'Operador', role: 'operator' }, permissions: ['inventory:read'] } }
      : { payload: productsListResponse() })
    renderWithQuery(<InventoryPage />)
    await screen.findByRole('table', { name: 'Grade adulta' })
    expect(screen.queryByRole('button', { name: /Novo produto|Fechar formulário/ })).not.toBeInTheDocument()
  })

  it('descarta registro de ajuste invalido sem restaurar', async () => {
    for (const raw of [
      '{nao-json',
      JSON.stringify({ key: 'k', body: '{}', variantId, quantityDelta: 2, reason: 'x', csrf: '' }),
      JSON.stringify({
        key: 'k',
        body: JSON.stringify({ variantId, quantityDelta: 2, reason: 'x' }),
        variantId, quantityDelta: 0, reason: 'x', csrf: '',
      }),
    ]) {
      sessionStorage.setItem('erp.pendingAdjustmentOperation.v1', raw)
      const { unmount } = renderWithQuery(<StockEntryPage />)
      expect(screen.queryByRole('button', { name: /tentar novamente/i })).not.toBeInTheDocument()
      expect(sessionStorage.getItem('erp.pendingAdjustmentOperation.v1')).toBeNull()
      unmount()
      sessionStorage.clear()
    }
  })

  it('recupera ajuste incerto com mesma chave e payload apos recarga', async () => {
    const body = JSON.stringify({ variantId, quantityDelta: 2, reason: 'Contagem' })
    sessionStorage.setItem('erp.pendingAdjustmentOperation.v1', JSON.stringify({
      key: 'ajuste-1', body, variantId, quantityDelta: 2, reason: 'Contagem', csrf: '',
    }))
    const fetchMock = stubFetch(() => ({ payload: { id: 'mov-1', variantId, quantityDelta: 2, balanceAfter: 2 }, status: 201 }))
    renderWithQuery(<StockEntryPage />)

    fireEvent.click(await screen.findByRole('button', { name: /tentar novamente/i }))
    await screen.findByText(/Ajuste registrado/)
    const calls = fetchMock.mock.calls.filter(([url, init]) => String(url).endsWith('/api/inventory/movements') && (init as RequestInit)?.method === 'POST')
    expect(calls).toHaveLength(1)
    expect(new Headers((calls[0]?.[1] as RequestInit)?.headers).get('Idempotency-Key')).toBe('ajuste-1')
    expect((calls[0]?.[1] as RequestInit)?.body).toBe(body)
    expect(sessionStorage.getItem('erp.pendingAdjustmentOperation.v1')).toBeNull()
  })
})
