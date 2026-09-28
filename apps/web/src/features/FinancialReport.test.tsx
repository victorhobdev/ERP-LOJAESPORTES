import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { FinancialReportPage } from './OperationalPages.js'

afterEach(() => {
  vi.unstubAllGlobals()
  window.history.replaceState(null, '', '/relatorios/financeiro')
})

function renderWithQuery(ui: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
}

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } })
}

function fullReport() {
  return {
    period: { from: '2026-08-10', to: '2026-08-12', timezone: 'America/Sao_Paulo' },
    bases: { sales: 'sale_created_at', cash: 'payment_received_at' },
    salesBySaleDate: '250.00',
    confirmedPaymentsByReceiptDate: '80.00',
    outstandingForPeriodSales: '170.00',
    historicalCostOfPeriodSales: '100.00',
    grossProfitOnSalesBasis: '150.00',
    grossMarginPercentOnSalesBasis: '60.00',
    averageTicketOnSalesBasis: '125.00',
    inventoryCostValue: '150.00',
    inventoryPotentialValue: '300.00',
    openPurchaseCapital: '60.00',
    paymentsByMethod: [{ method: 'pix', amount: '80.00' }],
    comparison: {
      period: { from: '2026-08-07', to: '2026-08-09', timezone: 'America/Sao_Paulo' },
      salesBySaleDate: '100.00',
      confirmedPaymentsByReceiptDate: '100.00',
    },
    dailySeries: [
      { date: '2026-08-10', salesBySaleDate: '200.00', confirmedPaymentsByReceiptDate: '0.00' },
      { date: '2026-08-11', salesBySaleDate: '0.00', confirmedPaymentsByReceiptDate: '80.00' },
      { date: '2026-08-12', salesBySaleDate: '50.00', confirmedPaymentsByReceiptDate: '0.00' },
    ],
    receivables: [{
      saleId: '11111111-1111-4111-8111-111111111111',
      customerDisplay: 'Cliente Parcial',
      dueDate: '2099-01-01',
      amountDue: '120.00',
      overdue: false,
    }],
    receivablesBasis: 'sales_created_in_period_with_open_balance',
    overdueAsOf: '2026-08-12',
    updatedAt: '2026-08-12T12:00:00.000Z',
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

describe('relatorio financeiro reconciliado', () => {
  it('le periodo da URL e reaplica via Aplicar atualizando URL e consulta', async () => {
    window.history.replaceState(null, '', '/relatorios/financeiro?from=2026-08-10&to=2026-08-12&compare=true')
    const fetchMock = stubFetch(() => ({ payload: fullReport() }))
    renderWithQuery(<FinancialReportPage />)
    await screen.findAllByText('Vendas pela data da venda')
    const urls = fetchMock.mock.calls.map(([url]) => String(url))
    expect(urls.some((u) => u.includes('from=2026-08-10') && u.includes('to=2026-08-12') && u.includes('compare=true'))).toBe(true)
    fireEvent.change(screen.getByLabelText('Início'), { target: { value: '2026-08-11' } })
    fireEvent.click(screen.getByRole('button', { name: 'Aplicar período' }))
    await waitFor(() => expect(window.location.search).toContain('from=2026-08-11'))
    await waitFor(() => {
      const all = fetchMock.mock.calls.map(([url]) => String(url))
      expect(all.some((u) => u.includes('from=2026-08-11'))).toBe(true)
    })
  })

  it('renderiza KPIs, comparacao, metodos, serie e recebiveis com drilldown', async () => {
    window.history.replaceState(null, '', '/relatorios/financeiro?from=2026-08-10&to=2026-08-12&compare=true')
    stubFetch(() => ({ payload: fullReport() }))
    renderWithQuery(<FinancialReportPage />)
    expect((await screen.findAllByText('Vendas pela data da venda'))[0]).toBeVisible()
    expect((await screen.findAllByText(/Recebimentos pela data do recebimento/))[0]).toBeVisible()
    expect(screen.getByText(/gerencial, n\u00e3o cont\u00e1bil\/fiscal/i)).toBeVisible()
    expect(screen.getByText(/Per\u00edodo anterior/)).toBeVisible()
    expect(screen.getByText('pix')).toBeVisible()
    expect(screen.getByText('2026-08-11')).toBeVisible()
    const drill = await screen.findByRole('link', { name: /Cliente Parcial/ })
    expect(drill.getAttribute('href')).toBe('/vendas/11111111-1111-4111-8111-111111111111')
  })

  it('explica ausencia sem serie enganosa quando vazio', async () => {
    window.history.replaceState(null, '', '/relatorios/financeiro?from=2026-08-10&to=2026-08-12')
    stubFetch(() => ({
      payload: {
        ...fullReport(),
        salesBySaleDate: '0.00',
        confirmedPaymentsByReceiptDate: '0.00',
        outstandingForPeriodSales: '0.00',
        paymentsByMethod: [],
        comparison: undefined,
        dailySeries: [
          { date: '2026-08-10', salesBySaleDate: '0.00', confirmedPaymentsByReceiptDate: '0.00' },
          { date: '2026-08-11', salesBySaleDate: '0.00', confirmedPaymentsByReceiptDate: '0.00' },
          { date: '2026-08-12', salesBySaleDate: '0.00', confirmedPaymentsByReceiptDate: '0.00' },
        ],
        receivables: [],
      },
    }))
    renderWithQuery(<FinancialReportPage />)
    expect(await screen.findByText(/Nenhum movimento no per\u00edodo/)).toBeVisible()
    expect(screen.getByText(/2026-08-10/)).toBeVisible()
  })

  it('mostra erro controlado com retry sem perder periodo', async () => {
    window.history.replaceState(null, '', '/relatorios/financeiro?from=2026-08-10&to=2026-08-12')
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => Promise.resolve(new Response(JSON.stringify({ code: 'X', message: 'boom' }), { status: 500 })))
      .mockImplementation(() => Promise.resolve(jsonResponse(fullReport())))
    vi.stubGlobal('fetch', fetchMock)
    renderWithQuery(<FinancialReportPage />)
    expect(await screen.findByRole('alert')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Tentar novamente' }))
    expect((await screen.findAllByText('Vendas pela data da venda'))[0]).toBeVisible()
    expect(window.location.search).toContain('from=2026-08-10')
  })

  it('rejeita periodo invalido localmente sem consultar a API', async () => {
    window.history.replaceState(null, '', '/relatorios/financeiro')
    const fetchMock = stubFetch(() => ({ payload: fullReport() }))
    renderWithQuery(<FinancialReportPage />)
    await screen.findAllByText('Vendas pela data da venda')
    const callsBefore = fetchMock.mock.calls.length
    fireEvent.change(screen.getByLabelText('Início'), { target: { value: '2026-08-12' } })
    fireEvent.change(screen.getByLabelText('Fim'), { target: { value: '2026-08-10' } })
    fireEvent.click(screen.getByRole('button', { name: 'Aplicar período' }))
    expect(await screen.findByText(/in\u00edcio deve ser anterior ou igual ao fim/i)).toBeVisible()
    expect(fetchMock.mock.calls.length).toBe(callsBefore)
  })

  it('rejeita periodo acima de 366 dias sem consultar a API', async () => {
    window.history.replaceState(null, '', '/relatorios/financeiro')
    const fetchMock = stubFetch(() => ({ payload: fullReport() }))
    renderWithQuery(<FinancialReportPage />)
    await screen.findAllByText('Vendas pela data da venda')
    const callsBefore = fetchMock.mock.calls.length
    fireEvent.change(screen.getByLabelText('Início'), { target: { value: '2025-01-01' } })
    fireEvent.change(screen.getByLabelText('Fim'), { target: { value: '2026-01-02' } })
    fireEvent.click(screen.getByRole('button', { name: 'Aplicar período' }))
    expect(await screen.findByText(/no m\u00e1ximo 366 dias/i)).toBeVisible()
    expect(fetchMock.mock.calls.length).toBe(callsBefore)
  })

  it('rejeita faixa civil sem suporte vinda da URL sem consultar a API', async () => {
    window.history.replaceState(null, '', '/relatorios/financeiro?from=0001-01-01&to=0001-01-03')
    const fetchMock = stubFetch(() => ({ payload: fullReport() }))
    renderWithQuery(<FinancialReportPage />)
    expect(await screen.findByText(/faixa suportada/i)).toBeVisible()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each<[string, string, string]>([
    ['mês impossível', '2026-13-01', '2026-13-05'],
    ['dia impossível', '2026-02-30', '2026-03-02'],
  ])('rejeita %s vindo da URL sem erro e sem consultar a API', async (_label, from, to) => {
    window.history.replaceState(null, '', `/relatorios/financeiro?from=${from}&to=${to}`)
    const fetchMock = stubFetch(() => ({ payload: fullReport() }))
    renderWithQuery(<FinancialReportPage />)
    expect(await screen.findByText(/Período inválido/i)).toBeVisible()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('descreve a data de apuracao da situacao de vencimento', async () => {
    window.history.replaceState(null, '', '/relatorios/financeiro?from=2026-08-10&to=2026-08-12')
    stubFetch(() => ({ payload: fullReport() }))
    renderWithQuery(<FinancialReportPage />)
    expect(await screen.findByText(/situa\u00e7\u00e3o de vencimento apurada em 2026-08-12/i)).toBeVisible()
  })
})
