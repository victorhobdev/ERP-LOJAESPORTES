import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { DashboardPage, LoginPage, NewSalePage } from './OperationalPages.js'

afterEach(() => {
  vi.unstubAllGlobals()
  window.history.replaceState(null, '', '/inicio')
})

function dashboardPayload() {
  return {
    date: '2026-08-15',
    timezone: 'America/Sao_Paulo',
    bases: { sales: 'sale_created_at', cash: 'payment_received_at', pending: 'current_state_as_of_request' },
    salesCreatedToday: '300.00', confirmedPaymentsToday: '150.00', pendingSalesCount: 2,
    overdueSalesCount: 1, lowStockVariants: 2, outOfStockVariants: 1,
    openPurchaseOrders: 1, pendingPurchaseUnits: 3, openCustomerOrders: 2,
  }
}

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } })
}

function renderWithQuery(ui: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
}

describe('operational pages', () => {
  it('opens the operation directly instead of rendering login fields', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(dashboardPayload())))

    renderWithQuery(<LoginPage />)

    expect(await screen.findByRole('heading', { name: 'Visão da operação' })).toBeVisible()
    expect(screen.queryByLabelText('Usuário')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Senha')).not.toBeInTheDocument()
  })

  it('renders reconciled dashboard values and their bases', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      date: '2026-08-30',
      timezone: 'America/Sao_Paulo',
      bases: { sales: 'sale_created_at', cash: 'payment_received_at', pending: 'current_state_as_of_request' },
      salesCreatedToday: '300.00', confirmedPaymentsToday: '150.00', pendingSalesCount: 1,
      overdueSalesCount: 1, lowStockVariants: 2, outOfStockVariants: 1,
      openPurchaseOrders: 1, pendingPurchaseUnits: 3, openCustomerOrders: 2,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })))

    renderWithQuery(<DashboardPage date="2026-08-30" />)

    expect(await screen.findByText('R$ 150,00')).toBeVisible()
    expect(screen.getByText('Caixa por data de recebimento')).toBeVisible()
    expect(screen.getByText('1 vencida')).toBeVisible()
  })

  it('reads the reference date from the URL and refetches on apply without losing focus', async () => {
    window.history.replaceState(null, '', '/inicio?date=2026-08-15')
    const fetchMock = vi.fn().mockImplementation((url: string) =>
      Promise.resolve(jsonResponse({ ...dashboardPayload(), date: String(url).includes('2026-08-16') ? '2026-08-16' : '2026-08-15' })))
    vi.stubGlobal('fetch', fetchMock)
    renderWithQuery(<DashboardPage />)
    await screen.findByText('R$ 150,00')
    expect(fetchMock.mock.calls.map(([url]) => String(url)).some((url) => url.includes('date=2026-08-15'))).toBe(true)
    const input = screen.getByLabelText('Data de referência', { selector: 'input' }) as HTMLInputElement
    fireEvent.change(input, { target: { value: '2026-08-16' } })
    fireEvent.click(screen.getByRole('button', { name: 'Aplicar data' }))
    await waitFor(() => expect(window.location.search).toContain('date=2026-08-16'))
    await waitFor(() => expect(fetchMock.mock.calls.map(([url]) => String(url)).some((url) => url.includes('date=2026-08-16'))).toBe(true))
    await screen.findByText('R$ 150,00')
    expect(document.activeElement).toBe(input)
  })

  it('rejects an impossible date from the URL without requesting', async () => {
    window.history.replaceState(null, '', '/inicio?date=2026-02-30')
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse(dashboardPayload())))
    vi.stubGlobal('fetch', fetchMock)
    renderWithQuery(<DashboardPage />)
    expect(await screen.findByText(/Data inválida/i)).toBeVisible()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('shows a controlled error with retry keeping the date', async () => {
    window.history.replaceState(null, '', '/inicio?date=2026-08-15')
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => Promise.resolve(new Response(JSON.stringify({ code: 'X', message: 'boom' }), { status: 500 })))
      .mockImplementation(() => Promise.resolve(jsonResponse(dashboardPayload())))
    vi.stubGlobal('fetch', fetchMock)
    renderWithQuery(<DashboardPage />)
    expect(await screen.findByRole('alert')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Tentar novamente' }))
    expect(await screen.findByText('R$ 150,00')).toBeVisible()
    expect(window.location.search).toContain('date=2026-08-15')
  })

  it('renders a navigable work queue with safe links and explicit as-of', async () => {
    window.history.replaceState(null, '', '/inicio?date=2026-08-15')
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => Promise.resolve(jsonResponse(dashboardPayload()))))
    renderWithQuery(<DashboardPage />)
    await screen.findByText('R$ 150,00')
    expect(screen.getByRole('link', { name: /Vendas em aberto: 2/ })).toHaveAttribute('href', '/vendas?status=open')
    expect(screen.getByRole('link', { name: /Estoque baixo ou zerado: 3/ })).toHaveAttribute('href', '/estoque?availability=low')
    expect(screen.getByRole('link', { name: /Compras abertas: 1/ })).toHaveAttribute('href', '/compras')
    expect(screen.getByRole('link', { name: /Encomendas em aberto: 2/ })).toHaveAttribute('href', '/encomendas')
    fireEvent.click(screen.getByText('Definições e bases'))
    expect(screen.getByText(/sale_created_at/)).toBeVisible()
    expect(screen.getByText(/current_state_as_of_request/)).toBeVisible()
  })

  it('keeps the cart until the API confirms a sale and sends an idempotency key', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [{
        id: 'product-1', club: 'Flamengo', model: 'Home', variants: [{
          id: '11111111-1111-4111-8111-111111111111', type: 'Masculina', size: 'M', sku: 'FLA-M',
          salePrice: '150.00', stockQuantity: 2,
        }],
      }] }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'sale-1', status: 'paid', finalAmount: '150.00' }), {
        status: 201, headers: { 'Content-Type': 'application/json' },
      }))
    vi.stubGlobal('fetch', fetchMock)

    renderWithQuery(<NewSalePage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Adicionar Flamengo Home, tamanho M' }))
    expect(screen.getAllByText(/FLA-M/)).toHaveLength(2)
    fireEvent.click(screen.getByRole('button', { name: 'Finalizar venda' }))

    await screen.findByText('Venda concluída')
    const saleCalls = fetchMock.mock.calls.filter(([url, init]) => String(url) === '/api/sales' && (init as RequestInit)?.method === 'POST')
    expect(saleCalls).toHaveLength(1)
    expect(saleCalls[0]?.[0]).toBe('/api/sales')
    const request = saleCalls[0]?.[1] as RequestInit
    expect(new Headers(request.headers).get('Idempotency-Key')).toEqual(expect.any(String))
    await waitFor(() => expect(screen.queryByText('FLA-M')).not.toBeInTheDocument())
  })
})
