import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { NewPurchasePage, PurchaseDetailPage, PurchasesPage } from './PurchasePages.js'

afterEach(() => {
  vi.unstubAllGlobals()
  sessionStorage.clear()
  document.cookie = 'erp_csrf=; Max-Age=0'
  window.history.replaceState(null, '', '/compras')
})

function renderWithQuery(ui: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
}

const orderId = '55555555-5555-4555-8555-555555555555'
const supplierId = '66666666-6666-4666-8666-666666666666'
const variantId = '11111111-1111-4111-8111-111111111111'
const itemId = '77777777-7777-4777-8777-777777777777'

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } })
}
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
function ordersList() {
  return {
    items: [{
      id: orderId, supplierName: 'Fornecedor E2E', orderedOn: '2026-09-03',
      status: 'placed', pendingQuantity: 4, finalAmount: '200.00',
    }],
    page: 1, limit: 20,
  }
}
function orderDetail() {
  return {
    id: orderId, supplierId, supplierName: 'Fornecedor E2E', status: 'placed', orderedOn: '2026-09-03',
    estimatedItemsAmount: '200.00', importFeeAmount: '0.00', finalAmount: '200.00',
    items: [{
      id: itemId, variantId, orderedQuantity: 4, receivedQuantity: 0, pendingQuantity: 4,
      club: 'Flamengo', model: 'Home', type: 'Masculina', size: 'M',
      supplierUnitCost: '50.00', finalUnitCost: '50.00',
    }],
    receipts: [],
  }
}
function supplierSearch() {
  return { items: [{ id: supplierId, name: 'Fornecedor E2E', contact: null }], total: 1 }
}
function variantSearch() {
  return {
    items: [{
      id: 'product-1', club: 'Flamengo', model: 'Home',
      variants: [{ id: variantId, type: 'Masculina', size: 'M', sku: 'FLA-M', salePrice: '150.00', stockQuantity: 9 }],
    }],
    total: 1, page: 1, limit: 20,
  }
}

describe('paginas de compras', () => {
  it('filtra por status na URL e abre o detalhe pela linha', async () => {
    window.history.replaceState(null, '', '/compras?status=placed')
    const fetchMock = stubFetch((url) => url.endsWith('/api/auth/session')
      ? { payload: managerSession() }
      : { payload: ordersList() })
    renderWithQuery(<PurchasesPage />)

    const link = await screen.findByRole('link', { name: /Fornecedor E2E/ })
    expect(link).toHaveAttribute('href', `/compras/${orderId}`)
    expect(fetchMock.mock.calls.map(([url]) => String(url)).some((url) => url.includes('status=placed'))).toBe(true)
  })

  it('oferece Rascunho no filtro com URL e chamada', async () => {
    const fetchMock = stubFetch((url) => url.endsWith('/api/auth/session')
      ? { payload: managerSession() }
      : { payload: ordersList() })
    renderWithQuery(<PurchasesPage />)
    await screen.findByText(/Fornecedor E2E/)

    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'draft' } })
    expect(screen.getByRole('option', { name: 'Rascunho' })).toBeInTheDocument()
    await waitFor(() => expect(window.location.search).toContain('status=draft'))
    await waitFor(() => {
      expect(fetchMock.mock.calls.map(([url]) => String(url)).some((url) => url.includes('status=draft'))).toBe(true)
    })
  })

  it('mostra vazio por filtro com limpeza', async () => {
    window.history.replaceState(null, '', '/compras?status=fully_received')
    stubFetch((url) => url.endsWith('/api/auth/session')
      ? { payload: managerSession() }
      : { payload: { items: [], page: 1, limit: 20 } })
    renderWithQuery(<PurchasesPage />)

    expect(await screen.findByText('Nenhum pedido para estes filtros.')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Ver todos os pedidos' }))
    expect(window.location.search).toBe('')
  })

  it('cria pedido sem UUID com selecao legivel e preserva em erro', async () => {
    stubFetch((url, init) => {
      if (url.endsWith('/api/auth/session')) return { payload: managerSession() }
      if (url.includes('/api/suppliers')) return { payload: supplierSearch() }
      if (url.includes('/api/products')) return { payload: variantSearch() }
      if (url.endsWith('/api/purchase-orders') && init?.method === 'POST') {
        return { payload: { code: 'VALIDATION_ERROR', message: 'Revise os dados do pedido.' }, status: 400 }
      }
      return { payload: { items: [] } }
    })
    renderWithQuery(<NewPurchasePage />)

    fireEvent.change(screen.getByPlaceholderText('Digite ao menos 2 letras'), { target: { value: 'E2E' } })
    fireEvent.click(await screen.findByRole('radio', { name: /Fornecedor E2E/ }))
    fireEvent.change(screen.getByPlaceholderText('Clube, modelo ou SKU'), { target: { value: 'FLA' } })
    fireEvent.click(await screen.findByRole('checkbox', { name: /FLA-M/ }))
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Quantidade' }), { target: { value: '4' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Custo unitário' }), { target: { value: '50.00' } })
    fireEvent.click(screen.getByRole('button', { name: 'Criar pedido' }))

    expect(await screen.findByText('Revise os dados do pedido.')).toBeVisible()
    expect(screen.getByRole('spinbutton', { name: 'Quantidade' })).toHaveValue(4)
    expect(screen.getByRole('textbox', { name: 'Custo unitário' })).toHaveValue('50.00')
    expect(screen.queryByText(/fornecedor.*UUID|digite o UUID/i)).not.toBeInTheDocument()
  })

  it('repete mesma chave e payload na criacao incerta', async () => {
    const fetchMock = stubFetch((url, init) => {
      if (url.endsWith('/api/auth/session')) return { payload: managerSession() }
      if (url.includes('/api/suppliers')) return { payload: supplierSearch() }
      if (url.includes('/api/products')) return { payload: variantSearch() }
      if (url.endsWith('/api/purchase-orders') && init?.method === 'POST') {
        if (fetchMock.mock.calls.filter(([u, i]) => String(u).endsWith('/api/purchase-orders') && (i as RequestInit)?.method === 'POST').length === 1) {
          throw new TypeError('rede instavel')
        }
        return { payload: { id: orderId, status: 'placed', finalAmount: '200.00' }, status: 201 }
      }
      return { payload: { items: [] } }
    })
    renderWithQuery(<NewPurchasePage />)

    fireEvent.change(screen.getByPlaceholderText('Digite ao menos 2 letras'), { target: { value: 'E2E' } })
    fireEvent.click(await screen.findByRole('radio', { name: /Fornecedor E2E/ }))
    fireEvent.change(screen.getByPlaceholderText('Clube, modelo ou SKU'), { target: { value: 'FLA' } })
    fireEvent.click(await screen.findByRole('checkbox', { name: /FLA-M/ }))
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Quantidade' }), { target: { value: '4' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Custo unitário' }), { target: { value: '50.00' } })
    fireEvent.click(screen.getByRole('button', { name: 'Criar pedido' }))

    fireEvent.click(await screen.findByRole('button', { name: /tentar novamente/i }))
    await screen.findByText(/Pedido criado/)
    const posts = fetchMock.mock.calls.filter(([url, init]) => String(url).endsWith('/api/purchase-orders') && (init as RequestInit)?.method === 'POST')
    expect(posts).toHaveLength(2)
    const keys = posts.map(([, init]) => new Headers((init as RequestInit)?.headers).get('Idempotency-Key'))
    expect(keys[0]).toBeTruthy()
    expect(keys[1]).toBe(keys[0])
  })

  it('detalhe mostra itens, recebimentos e volta', async () => {
    stubFetch((url) => {
      if (url.endsWith('/api/auth/session')) return { payload: managerSession() }
      return { payload: orderDetail() }
    })
    renderWithQuery(<PurchaseDetailPage purchaseOrderId={orderId} />)

    expect(await screen.findByRole('heading', { name: `Pedido ${orderId.slice(0, 8)}` })).toBeVisible()
    expect(screen.getByText(/4 un.*pendente|pendente.*4/i)).toBeVisible()
    expect(screen.getByText('Nenhum recebimento registrado.')).toBeVisible()
    expect(screen.getByRole('cell', { name: 'Flamengo Home · Masculina M' })).toBeVisible()
    expect(screen.queryByText(variantId.slice(0, 8))).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Voltar às compras' })).toHaveAttribute('href', '/compras')
  })

  it('rejeita recebimento acima do pendente sem enviar', async () => {
    const fetchMock = stubFetch((url) => {
      if (url.endsWith('/api/auth/session')) return { payload: managerSession() }
      return { payload: orderDetail() }
    })
    renderWithQuery(<PurchaseDetailPage purchaseOrderId={orderId} />)
    await screen.findByRole('heading', { name: `Pedido ${orderId.slice(0, 8)}` })

    fireEvent.change(screen.getByRole('spinbutton', { name: /Receber item/ }), { target: { value: '9' } })
    fireEvent.click(screen.getByRole('button', { name: 'Registrar recebimento' }))

    expect(await screen.findByText(/acima do pendente/)).toBeVisible()
    expect(fetchMock.mock.calls.filter(([url, init]) => String(url).includes('/receipts') && (init as RequestInit)?.method === 'POST')).toHaveLength(0)
  })

  it('recupera recebimento incerto com mesma chave apos remount', async () => {
    const body = JSON.stringify({ items: [{ purchaseOrderItemId: itemId, quantity: 2 }] })
    sessionStorage.setItem('erp.pendingReceiptOperation.v1', JSON.stringify({
      key: 'rec-1', body, orderId, csrf: '',
    }))
    const fetchMock = stubFetch((url, init) => {
      if (url.endsWith('/api/auth/session')) return { payload: managerSession() }
      if (url.includes(`/api/purchase-orders/${orderId}/receipts`) && init?.method === 'POST') {
        return { payload: { id: 'rec-1', purchaseOrderId: orderId, status: 'partially_received', items: [{ purchaseOrderItemId: itemId, quantity: 2 }] }, status: 201 }
      }
      return { payload: orderDetail() }
    })
    const first = renderWithQuery(<PurchaseDetailPage purchaseOrderId={orderId} />)
    expect(await screen.findByRole('button', { name: /tentar novamente/i })).toBeVisible()
    first.unmount()

    renderWithQuery(<PurchaseDetailPage purchaseOrderId={orderId} />)
    fireEvent.click(await screen.findByRole('button', { name: /tentar novamente/i }))
    await screen.findByText(/Recebimento registrado/)
    const posts = fetchMock.mock.calls.filter(([url, init]) => String(url).includes('/receipts') && (init as RequestInit)?.method === 'POST')
    expect(posts).toHaveLength(1)
    expect(new Headers((posts[0]?.[1] as RequestInit)?.headers).get('Idempotency-Key')).toBe('rec-1')
    expect((posts[0]?.[1] as RequestInit)?.body).toBe(body)
    expect(sessionStorage.getItem('erp.pendingReceiptOperation.v1')).toBeNull()
  })
})

describe('cancelamento de pedido de compra', () => {
  function cancelDetail(status: string, cancellationReason: string | null = null) {
    return {
      id: orderId, supplierId, supplierName: 'Fornecedor E2E', status, orderedOn: '2026-09-03',
      cancellationReason,
      estimatedItemsAmount: '200.00', importFeeAmount: '0.00', finalAmount: '200.00',
      items: [{
        id: itemId, variantId, orderedQuantity: 4, receivedQuantity: 0, pendingQuantity: 4,
        supplierUnitCost: '50.00', finalUnitCost: '50.00',
      }],
      receipts: [],
    }
  }

  it('exige motivo, envia csrf e confirma o cancelamento', async () => {
    document.cookie = 'erp_csrf=csrf-test'
    const fetchMock = stubFetch((url, init) => {
      if (url.endsWith('/api/auth/session')) return { payload: managerSession() }
      if (url.endsWith(`/api/purchase-orders/${orderId}`)) return { payload: cancelDetail('placed') }
      if (url.endsWith(`/api/purchase-orders/${orderId}/cancel`) && init?.method === 'POST') {
        return { payload: { id: orderId, status: 'cancelled', cancellationReason: 'Pedido duplicado' } }
      }
      return { payload: {} }
    })
    renderWithQuery(<PurchaseDetailPage purchaseOrderId={orderId} />)

    await screen.findByRole('textbox', { name: 'Motivo do cancelamento' })
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar pedido' }))
    expect(await screen.findByText('Informe o motivo do cancelamento.')).toBeVisible()
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/cancel'))).toHaveLength(0)

    fireEvent.change(screen.getByRole('textbox', { name: 'Motivo do cancelamento' }), { target: { value: 'Pedido duplicado' } })
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar pedido' }))
    expect(await screen.findByText('Pedido cancelado.')).toBeVisible()

    const cancelCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/cancel'))
    const init = cancelCall?.[1] as RequestInit
    expect(new Headers(init.headers).get('x-csrf-token')).toBe('csrf-test')
    expect(JSON.parse(String(init.body))).toEqual({ reason: 'Pedido duplicado' })
  })

  it('sem permissao nao oferece cancelamento', async () => {
    stubFetch((url) => url.endsWith('/api/auth/session')
      ? { payload: { user: { displayName: 'Operador', role: 'operator' }, permissions: ['purchases:read'] } }
      : url.endsWith(`/api/purchase-orders/${orderId}`) ? { payload: cancelDetail('placed') } : { payload: {} })
    renderWithQuery(<PurchaseDetailPage purchaseOrderId={orderId} />)

    expect(await screen.findByText('Seu perfil não tem permissão para cancelar pedidos.')).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Cancelar pedido' })).not.toBeInTheDocument()
  })

  it('pedido recebido nao oferece cancelamento e explica a regra', async () => {
    stubFetch((url) => url.endsWith('/api/auth/session')
      ? { payload: managerSession() }
      : url.endsWith(`/api/purchase-orders/${orderId}`) ? { payload: cancelDetail('fully_received') } : { payload: {} })
    renderWithQuery(<PurchaseDetailPage purchaseOrderId={orderId} />)

    expect(await screen.findByText('Cancelamento não é permitido depois de recebimento.')).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Cancelar pedido' })).not.toBeInTheDocument()
  })

  it('pedido cancelado exibe o motivo registrado', async () => {
    stubFetch((url) => url.endsWith('/api/auth/session')
      ? { payload: managerSession() }
      : url.endsWith(`/api/purchase-orders/${orderId}`) ? { payload: cancelDetail('cancelled', 'Pedido duplicado') } : { payload: {} })
    renderWithQuery(<PurchaseDetailPage purchaseOrderId={orderId} />)

    expect(await screen.findByText('Motivo do cancelamento: Pedido duplicado')).toBeVisible()
    expect(screen.getByText('Pedido cancelado.')).toBeVisible()
    expect(screen.queryByRole('textbox', { name: 'Motivo do cancelamento' })).not.toBeInTheDocument()
  })
})
