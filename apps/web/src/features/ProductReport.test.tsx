import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ProductReportPage } from './OperationalPages.js'

afterEach(() => {
  vi.unstubAllGlobals()
  window.history.replaceState(null, '', '/relatorios/produtos')
})

function renderWithQuery(ui: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
}

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } })
}

function productReport() {
  return {
    period: { from: '2026-08-01', to: '2026-08-31', timezone: 'America/Sao_Paulo' },
    filters: { club: null, type: null, size: null },
    timezone: 'America/Sao_Paulo',
    bases: { sales: 'sale_created_at', stock: 'current_state_as_of_request' },
    items: [
      {
        variantId: '11111111-1111-4111-8111-111111111111', club: 'Atlas FC', model: 'Home',
        type: 'Masculina', size: 'M', sku: 'ATL-M', currentStockQuantity: 2, lowStockThreshold: 5,
        unitsSold: '2', salesAmount: '200.00', historicalCost: '120.00', grossProfit: '80.00',
        noTurnover: false, lowStock: true,
      },
      {
        variantId: '22222222-2222-4222-8222-222222222222', club: 'Atlas FC', model: 'Home',
        type: 'Feminina', size: 'G', sku: 'ATL-G', currentStockQuantity: 0, lowStockThreshold: 3,
        unitsSold: '0', salesAmount: '0.00', historicalCost: '0.00', grossProfit: '0.00',
        noTurnover: true, lowStock: false,
      },
    ],
    summary: {
      variantCount: 2,
      totalUnitsSold: '2',
      totalSalesAmount: '200.00',
      totalGrossProfit: '80.00',
      noTurnoverCount: 1,
      lowStockCount: 1,
      salesByClub: [{ name: 'Atlas FC', unitsSold: '2', salesAmount: '200.00', sharePercent: '100.00' }],
      salesByType: [{ name: 'Masculina', unitsSold: '2', salesAmount: '200.00', sharePercent: '100.00' }],
      salesBySize: [{ name: 'M', unitsSold: '2', salesAmount: '200.00', sharePercent: '100.00' }],
    },
    updatedAt: '2026-08-31T12:00:00.000Z',
    stockAsOf: '2026-08-31T12:00:00.000Z',
  }
}

function stubFetch(handler: (url: string) => { payload: unknown; status?: number }) {
  const fetchMock = vi.fn().mockImplementation((url: string) => {
    const { payload, status } = handler(String(url))
    return Promise.resolve(jsonResponse(payload, status))
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('relatorio de produtos', () => {
  it('le filtros da URL e reaplica sem perder o foco', async () => {
    window.history.replaceState(null, '', '/relatorios/produtos?from=2026-08-01&to=2026-08-31&club=Atlas')
    const fetchMock = stubFetch(() => ({ payload: productReport() }))
    renderWithQuery(<ProductReportPage />)
    await screen.findByText('Detalhamento por variante')
    expect(fetchMock.mock.calls.map(([url]) => String(url)).some((url) => url.includes('club=Atlas'))).toBe(true)
    const club = screen.getByLabelText('Clube')
    club.focus()
    fireEvent.change(club, { target: { value: 'Atlas FC' } })
    expect(document.activeElement).toBe(club)
    fireEvent.click(screen.getByRole('button', { name: 'Aplicar filtros' }))
    await waitFor(() => expect(window.location.search).toContain('club=Atlas+FC'))
    await waitFor(() => {
      expect(fetchMock.mock.calls.map(([url]) => String(url)).some((url) => url.includes('club=Atlas'))).toBe(true)
    })
  })

  it('renderiza KPIs, participacoes e flags sem giro/estoque baixo', async () => {
    window.history.replaceState(null, '', '/relatorios/produtos?from=2026-08-01&to=2026-08-31')
    stubFetch(() => ({ payload: productReport() }))
    renderWithQuery(<ProductReportPage />)
    expect(await screen.findByText('Unidades vendidas')).toBeVisible()
    expect(screen.getByText('Mais vendidos por clube')).toBeVisible()
    expect(screen.getByText('Mais vendidos por tipo')).toBeVisible()
    expect(screen.getByText('Mais vendidos por tamanho')).toBeVisible()
    expect(screen.getByText('Atlas FC')).toBeVisible()
    expect(screen.getByText('Sem giro')).toBeVisible()
    expect(screen.getAllByText('Estoque baixo')[0]).toBeVisible()
    expect(screen.getAllByText(/snapshots históricos/)[0]).toBeVisible()
    fireEvent.click(screen.getByText('Definições e bases'))
    expect(screen.getByText(/sale_created_at/)).toBeVisible()
    expect(screen.getByText(/current_state_as_of_request/)).toBeVisible()
    expect(screen.getAllByText(/2026-08-31T12:00:00.000Z/)[0]).toBeVisible()
  })

  it('mantem o foco no filtro apos nova resposta e renderizacao', async () => {
    window.history.replaceState(null, '', '/relatorios/produtos?from=2026-08-01&to=2026-08-31')
    const second = { ...productReport(), filters: { club: 'Boreal', type: null, size: null } }
    let calls = 0
    const fetchMock = vi.fn().mockImplementation(() => {
      calls += 1
      return Promise.resolve(jsonResponse(calls === 1 ? productReport() : second))
    })
    vi.stubGlobal('fetch', fetchMock)
    renderWithQuery(<ProductReportPage />)
    await screen.findByText('Detalhamento por variante')
    const club = screen.getByLabelText('Clube') as HTMLInputElement
    fireEvent.change(club, { target: { value: 'Boreal' } })
    fireEvent.click(screen.getByRole('button', { name: 'Aplicar filtros' }))
    club.focus()
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(1))
    await screen.findByText('Detalhamento por variante')
    expect(document.activeElement).toBe(club)
  })

  it('mostra vazio por filtro e vazio sem variantes', async () => {
    window.history.replaceState(null, '', '/relatorios/produtos?from=2026-08-01&to=2026-08-31&club=zzz')
    stubFetch(() => ({
      payload: { ...productReport(), filters: { club: 'zzz', type: null, size: null }, items: [] },
    }))
    const { unmount } = renderWithQuery(<ProductReportPage />)
    expect(await screen.findByText(/Nenhuma variante para estes filtros/)).toBeVisible()
    unmount()
    window.history.replaceState(null, '', '/relatorios/produtos?from=2026-08-01&to=2026-08-31')
    stubFetch(() => ({
      payload: {
        ...productReport(),
        items: [],
        summary: {
          variantCount: 0, totalUnitsSold: '0', totalSalesAmount: '0.00', totalGrossProfit: '0.00',
          noTurnoverCount: 0, lowStockCount: 0, salesByClub: [], salesByType: [], salesBySize: [],
        },
      },
    }))
    renderWithQuery(<ProductReportPage />)
    expect(await screen.findByText(/Nenhuma variante ativa cadastrada/)).toBeVisible()
  })

  it('mostra erro controlado com retry e bloqueia request em periodo invalido', async () => {
    window.history.replaceState(null, '', '/relatorios/produtos?from=2026-08-01&to=2026-08-31')
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => Promise.resolve(new Response(JSON.stringify({ code: 'X', message: 'boom' }), { status: 500 })))
      .mockImplementation(() => Promise.resolve(jsonResponse(productReport())))
    vi.stubGlobal('fetch', fetchMock)
    const { unmount } = renderWithQuery(<ProductReportPage />)
    expect(await screen.findByRole('alert')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Tentar novamente' }))
    expect(await screen.findByText('Detalhamento por variante')).toBeVisible()
    unmount()
    window.history.replaceState(null, '', '/relatorios/produtos?from=2026-13-01&to=2026-13-05')
    const invalidFetch = stubFetch(() => ({ payload: productReport() }))
    renderWithQuery(<ProductReportPage />)
    expect(await screen.findByText(/Período inválido/i)).toBeVisible()
    expect(invalidFetch).not.toHaveBeenCalled()
  })
})
