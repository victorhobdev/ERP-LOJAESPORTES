import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { DashboardPage, NewSalePage } from './OperationalPages.js'

afterEach(() => vi.unstubAllGlobals())

function renderWithQuery(ui: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
}

describe('operational pages', () => {
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
    expect(fetchMock).toHaveBeenLastCalledWith('/api/sales', expect.objectContaining({ method: 'POST' }))
    const request = fetchMock.mock.calls.at(-1)?.[1] as RequestInit
    expect(new Headers(request.headers).get('Idempotency-Key')).toEqual(expect.any(String))
    await waitFor(() => expect(screen.queryByText('FLA-M')).not.toBeInTheDocument())
  })
})
