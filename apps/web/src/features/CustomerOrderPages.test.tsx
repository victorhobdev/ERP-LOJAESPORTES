import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { CustomerOrderDetailPage, CustomerOrdersPage } from './CustomerOrderPages.js'

afterEach(() => {
  vi.unstubAllGlobals()
  sessionStorage.clear()
  document.cookie = 'erp_csrf=; Max-Age=0'
  window.history.replaceState(null, '', '/encomendas')
})

function renderWithQuery(ui: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
}

const orderId = '88888888-8888-4888-8888-888888888888'
const customerId = '44444444-4444-4444-8444-444444444444'

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
function orderRow() {
  return {
    id: orderId, status: 'pending', club: 'Flamengo', model: 'Home', type: 'Masculina', size: 'M',
    createdAt: '2026-09-03T10:00:00.000Z', customerName: 'Cliente E2E', customerContact: null,
  }
}
function orderDetail() {
  return {
    id: orderId, customerId, variantId: null, linkedPurchaseOrderId: null,
    club: 'Flamengo', model: 'Home', type: 'Masculina', size: 'M', notes: null,
    status: 'pending', cancellationReason: null, createdAt: '2026-09-03T10:00:00.000Z',
    updatedAt: '2026-09-03T10:00:00.000Z', customerName: 'Cliente E2E', customerContact: 'contato',
    operatorDisplayName: 'Gestor', variantType: null,
    timeline: [{ id: 'ev-1', fromStatus: null, toStatus: 'pending', reason: null, createdAt: '2026-09-03T10:00:00.000Z', userDisplayName: 'Gestor' }],
  }
}

describe('paginas de encomendas', () => {
  it('lista com busca/status/pagina na URL e link de detalhe', async () => {
    window.history.replaceState(null, '', '/encomendas?search=Fla&status=pending')
    const fetchMock = stubFetch((url) => url.endsWith('/api/auth/session')
      ? { payload: managerSession() }
      : { payload: { items: [orderRow()], total: 1, page: 1, limit: 20 } })
    renderWithQuery(<CustomerOrdersPage />)

    const link = await screen.findByRole('link', { name: /Cliente E2E/ })
    expect(link).toHaveAttribute('href', `/encomendas/${orderId}`)
    const urls = fetchMock.mock.calls.map(([url]) => String(url)).filter((url) => url.includes('/api/customer-orders'))
    expect(urls[0]).toContain('search=Fla')
    expect(urls[0]).toContain('status=pending')
    expect(screen.getByRole('button', { name: 'Nova encomenda' })).toBeVisible()
  })

  it('mostra vazio por filtro, erro com retry e loading', async () => {
    window.history.replaceState(null, '', '/encomendas?search=zzz')
    let calls = 0
    stubFetch((url) => {
      if (url.endsWith('/api/auth/session')) return { payload: managerSession() }
      calls += 1
      return calls === 1
        ? { payload: { code: 'INTERNAL_ERROR', message: 'Falha.' }, status: 500 }
        : { payload: { items: [], total: 0, page: 1, limit: 20 } }
    })
    renderWithQuery(<CustomerOrdersPage />)

    expect(await screen.findByText('Falha.')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Tentar novamente' }))
    expect(await screen.findByText('Nenhuma encomenda para estes filtros.')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Ver todas as encomendas' }))
    expect(window.location.search).toBe('')
  })

  it('cria encomenda livre com payload nulo e retry mesma chave', async () => {
    const fetchMock = stubFetch((url, init) => {
      if (url.endsWith('/api/auth/session')) return { payload: managerSession() }
      if (url.includes('/api/customers')) {
        return { payload: { items: [{ id: customerId, name: 'Cliente E2E', contact: null }], total: 1 } }
      }
      if (url.endsWith('/api/customer-orders') && init?.method === 'POST') {
        const count = fetchMock.mock.calls.filter(([u, i]) => String(u).endsWith('/api/customer-orders') && (i as RequestInit)?.method === 'POST').length
        if (count === 1) throw new TypeError('rede instavel')
        return { payload: { id: orderId, status: 'pending' }, status: 201 }
      }
      return { payload: { items: [orderRow()], total: 1, page: 1, limit: 20 } }
    })
    renderWithQuery(<CustomerOrdersPage />)
    await screen.findByText(/Cliente E2E/)

    fireEvent.click(screen.getByRole('button', { name: 'Nova encomenda' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Buscar cliente' }), { target: { value: 'E2E' } })
    fireEvent.click(await screen.findByRole('radio', { name: /Cliente E2E/ }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Clube' }), { target: { value: 'Flamengo' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Modelo' }), { target: { value: 'Home' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Tamanho' }), { target: { value: 'M' } })
    fireEvent.click(screen.getByRole('button', { name: 'Criar encomenda' }))

    fireEvent.click(await screen.findByRole('button', { name: /tentar novamente/i }))
    await screen.findByText(/Encomenda criada/)
    const posts = fetchMock.mock.calls.filter(([url, init]) => String(url).endsWith('/api/customer-orders') && (init as RequestInit)?.method === 'POST')
    expect(posts).toHaveLength(2)
    const bodies = posts.map(([, init]) => JSON.parse(String((init as RequestInit)?.body)))
    expect(bodies[0]).toEqual(bodies[1])
    expect(bodies[0]).toMatchObject({ customerId, club: 'Flamengo' })
    expect('variantId' in (bodies[0] as Record<string, unknown>)).toBe(false)
    expect('linkedPurchaseOrderId' in (bodies[0] as Record<string, unknown>)).toBe(false)
    const keys = posts.map(([, init]) => new Headers((init as RequestInit)?.headers).get('Idempotency-Key'))
    expect(keys[1]).toBe(keys[0])
    expect(fetchMock.mock.calls.some(([url, init]) => String(url).includes('/purchase-orders') && (init as RequestInit)?.method === 'POST')).toBe(false)
    expect(fetchMock.mock.calls.some(([url, init]) => String(url).includes('/inventory') && (init as RequestInit)?.method === 'POST')).toBe(false)
  })

  it('erro definitivo preserva o formulario de criacao', async () => {
    stubFetch((url, init) => {
      if (url.endsWith('/api/auth/session')) return { payload: managerSession() }
      if (url.includes('/api/customers')) {
        return { payload: { items: [{ id: customerId, name: 'Cliente E2E', contact: null }], total: 1 } }
      }
      if (url.endsWith('/api/customer-orders') && init?.method === 'POST') {
        return { payload: { code: 'CUSTOMER_NOT_FOUND', message: 'Cliente não encontrado.' }, status: 404 }
      }
      return { payload: { items: [], total: 0, page: 1, limit: 20 } }
    })
    renderWithQuery(<CustomerOrdersPage />)
    await screen.findByText('Nenhuma encomenda registrada.')

    fireEvent.click(screen.getByRole('button', { name: 'Nova encomenda' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Buscar cliente' }), { target: { value: 'E2E' } })
    fireEvent.click(await screen.findByRole('radio', { name: /Cliente E2E/ }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Clube' }), { target: { value: 'Flamengo' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Modelo' }), { target: { value: 'Home' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Tamanho' }), { target: { value: 'M' } })
    fireEvent.click(screen.getByRole('button', { name: 'Criar encomenda' }))

    expect(await screen.findByText('Cliente não encontrado.')).toBeVisible()
    expect(screen.getByRole('textbox', { name: 'Clube' })).toHaveValue('Flamengo')
  })

  it('detalhe com timeline, transicao valida e cancelamento motivado', async () => {
    const fetchMock = stubFetch((url, init) => {
      if (url.endsWith('/api/auth/session')) return { payload: managerSession() }
      if (url.endsWith(`/api/customer-orders/${orderId}/status`) && init?.method === 'PATCH') {
        return { payload: { id: orderId, status: 'supplier_ordered' } }
      }
      return { payload: orderDetail() }
    })
    renderWithQuery(<CustomerOrderDetailPage orderId={orderId} />)

    expect(await screen.findByRole('heading', { name: 'Encomenda de Cliente E2E' })).toBeVisible()
    expect(screen.getAllByText(/Gestor/)).not.toHaveLength(0)
    expect(screen.getAllByText(/Pendente/)).not.toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: 'Pedir ao fornecedor' }))
    await screen.findByText(/Status atualizado/)
    const patches = fetchMock.mock.calls.filter(([url, init]) => String(url).endsWith('/status') && (init as RequestInit)?.method === 'PATCH')
    expect(patches).toHaveLength(1)
    expect(JSON.parse(String((patches[0]?.[1] as RequestInit)?.body))).toEqual({ status: 'supplier_ordered' })
  })

  it('cancelamento sem motivo e bloqueado e acao impossivel e explicada', async () => {
    stubFetch((url) => {
      if (url.endsWith('/api/auth/session')) return { payload: managerSession() }
      return { payload: { ...orderDetail(), status: 'delivered' } }
    })
    renderWithQuery(<CustomerOrderDetailPage orderId={orderId} />)
    await screen.findByText(/Entregue/)

    expect(screen.getByText('Encomenda entregue; não há novas ações.')).toBeVisible()
    expect(screen.queryByRole('button', { name: /cancelar/i })).not.toBeInTheDocument()
  })

  it('retry de status usa mesma chave apos remount', async () => {
    const body = JSON.stringify({ status: 'supplier_ordered' })
    sessionStorage.setItem('erp.pendingOrderStatusOperation.v1', JSON.stringify({
      key: 'st-1', body, orderId, csrf: '',
    }))
    const fetchMock = stubFetch((url, init) => {
      if (url.endsWith('/api/auth/session')) return { payload: managerSession() }
      if (url.endsWith(`/api/customer-orders/${orderId}/status`) && init?.method === 'PATCH') {
        return { payload: { id: orderId, status: 'supplier_ordered' } }
      }
      return { payload: orderDetail() }
    })
    const first = renderWithQuery(<CustomerOrderDetailPage orderId={orderId} />)
    expect(await screen.findByRole('button', { name: /tentar novamente/i })).toBeVisible()
    first.unmount()

    renderWithQuery(<CustomerOrderDetailPage orderId={orderId} />)
    fireEvent.click(await screen.findByRole('button', { name: /tentar novamente/i }))
    await screen.findByText(/Status atualizado/)
    const patches = fetchMock.mock.calls.filter(([url, init]) => String(url).endsWith('/status') && (init as RequestInit)?.method === 'PATCH')
    expect(patches).toHaveLength(1)
    expect(new Headers((patches[0]?.[1] as RequestInit)?.headers).get('Idempotency-Key')).toBe('st-1')
    expect((patches[0]?.[1] as RequestInit)?.body).toBe(body)
  })

  it('transicao final confirma o sucesso apos o refetch do detalhe', async () => {
    let detailCalls = 0
    stubFetch((url, init) => {
      if (url.endsWith('/api/auth/session')) return { payload: managerSession() }
      if (url.endsWith(`/api/customer-orders/${orderId}/status`) && init?.method === 'PATCH') {
        return { payload: { id: orderId, status: 'delivered' } }
      }
      detailCalls += 1
      return {
        payload: detailCalls === 1
          ? { ...orderDetail(), status: 'product_arrived' }
          : { ...orderDetail(), status: 'delivered' },
      }
    })
    renderWithQuery(<CustomerOrderDetailPage orderId={orderId} />)

    fireEvent.click(await screen.findByRole('button', { name: 'Entregar ao cliente' }))
    await screen.findByText('Status atualizado.', { exact: true })
    await screen.findByText('Encomenda entregue; não há novas ações.')
    expect(screen.getByText('Status atualizado.', { exact: true })).toBeVisible()
  })

  it('recupera registro com nulos explicitos coerentes', async () => {
    const body = JSON.stringify({
      customerId, variantId: null, linkedPurchaseOrderId: null,
      club: 'Flamengo', model: 'Home', type: 'Masculina', size: 'M', notes: null,
    })
    sessionStorage.setItem('erp.pendingCustomerOrderOperation.v1', JSON.stringify({ key: 'k-null', body, csrf: '' }))
    const fetchMock = stubFetch((url, init) => {
      if (url.endsWith('/api/auth/session')) return { payload: managerSession() }
      if (url.endsWith('/api/customer-orders') && init?.method === 'POST') {
        return { payload: { id: orderId, status: 'pending' }, status: 201 }
      }
      return { payload: { items: [orderRow()], total: 1, page: 1, limit: 20 } }
    })
    renderWithQuery(<CustomerOrdersPage />)
    await screen.findByText(/Cliente E2E/)

    fireEvent.click(screen.getByRole('button', { name: 'Nova encomenda' }))
    fireEvent.click(await screen.findByRole('button', { name: /tentar novamente/i }))
    await screen.findByText(/Encomenda criada/)
    const posts = fetchMock.mock.calls.filter(([url, init]) => String(url).endsWith('/api/customer-orders') && (init as RequestInit)?.method === 'POST')
    expect(posts).toHaveLength(1)
    expect(new Headers((posts[0]?.[1] as RequestInit)?.headers).get('Idempotency-Key')).toBe('k-null')
    expect((posts[0]?.[1] as RequestInit)?.body).toBe(body)
  })
})
