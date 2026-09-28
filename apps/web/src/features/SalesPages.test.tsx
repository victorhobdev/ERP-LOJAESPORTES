import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { SaleDetailPage, SalesPage } from './SalesPages.js'

afterEach(() => {
  vi.unstubAllGlobals()
  sessionStorage.clear()
  document.cookie = 'erp_csrf=; Max-Age=0'
  window.history.replaceState(null, '', '/vendas')
})

function renderWithQuery(ui: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
}

const saleId = '22222222-2222-4222-8222-222222222222'
const variantId = '11111111-1111-4111-8111-111111111111'
function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } })
}
function pendingDetail() {
  return {
    id: saleId, customerId: null, status: 'pending', subtotalAmount: '150.00', discountAmount: '0.00',
    finalAmount: '150.00', amountDue: '150.00',
    items: [{ variantId, club: 'Flamengo', model: 'Home', type: 'Masculina', size: 'M', quantity: 1, unitPrice: '150.00', unitCost: '80.00' }],
    payments: [], exchanges: [],
  }
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
function salesStubs(extra?: (url: string, init?: RequestInit) => { payload: unknown; status?: number } | undefined) {
  return stubFetch((url, init) => {
    if (url.endsWith('/api/auth/session')) return { payload: managerSession() }
    const override = extra?.(url, init)
    if (override) return override
    if (url.includes('/api/sales/') && !url.endsWith('/payments') && !url.endsWith('/exchanges')) return { payload: pendingDetail() }
    if (url.includes('/api/sales')) {
      return {
        payload: {
          items: [{ id: saleId, customerId: null, customerName: 'Cliente da loja', productSummary: 'Flamengo I 2026 ×2', status: 'pending', finalAmount: '150.00', amountDue: '150.00', createdAt: '2026-09-03T10:00:00.000Z' }],
          total: 1, page: 1, limit: 20,
        },
      }
    }
    return { payload: { items: [] } }
  })
}

describe('paginas de vendas', () => {
  it('filtra por status na URL e abre o detalhe pela linha', async () => {
    window.history.replaceState(null, '', '/vendas?status=pending')
    const fetchMock = salesStubs()
    renderWithQuery(<SalesPage />)
    expect(await screen.findByText('Cliente da loja')).toBeVisible()
    expect(await screen.findByText('Flamengo I 2026 ×2')).toBeVisible()

    const link = await screen.findByRole('link', { name: /Pendente.*150/ })
    expect(link).toHaveAttribute('href', `/vendas/${saleId}`)
    const urls = fetchMock.mock.calls.map(([url]) => String(url))
    expect(urls.some((url) => url.includes('status=open'))).toBe(true)
    expect(screen.getByRole('button', { name: 'A receber' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('reune pendentes e parciais em A receber sem filtros redundantes', async () => {
    window.history.replaceState(null, '', '/vendas')
    const fetchMock = salesStubs()
    renderWithQuery(<SalesPage />)
    await screen.findByRole('link', { name: /Pendente.*150/ })
    fireEvent.click(screen.getByRole('button', { name: 'A receber' }))
    expect(screen.getByRole('button', { name: 'A receber' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Pendente|Em aberto|Parcial/ })).not.toBeInTheDocument()
    expect(window.location.search).toContain('status=open')
    await waitFor(() => expect(
      fetchMock.mock.calls.map(([url]) => String(url)).some((url) => url.includes('status=open')),
    ).toBe(true))
  })

  it('exibe no maximo tres miniaturas reais e substitui fotos indisponiveis por uma camisa', async () => {
    salesStubs(() => ({ payload: { items: [{ ...pendingDetail(), createdAt: '2026-09-03T10:00:00.000Z',
      customerName: 'Cliente das camisas', productSummary: 'Quatro camisas',
      productPreviews: [
        { productId: 'p1', label: 'Flamengo Home', mediaId: 'foto-1' },
        { productId: 'p2', label: 'Brasil Away', mediaId: 'foto-2' },
        { productId: 'p3', label: 'Vasco Home', mediaId: null },
        { productId: 'p4', label: 'Botafogo Home', mediaId: 'foto-4' },
      ],
    }], total: 1, page: 1, limit: 20 } }))
    renderWithQuery(<SalesPage />)
    const image = await screen.findByRole('img', { name: 'Flamengo Home' })
    expect(image).toHaveAttribute('src', '/api/catalog/media/foto-1')
    expect(screen.getAllByRole('img')).toHaveLength(3)
    expect(screen.queryByRole('img', { name: 'Botafogo Home' })).not.toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'Vasco Home: sem imagem' })).toBeVisible()
    fireEvent.error(image)
    expect(screen.getByRole('img', { name: 'Flamengo Home: sem imagem' })).toBeVisible()
    expect(screen.getAllByRole('img')).toHaveLength(3)
  })

  it('mostra vazio por filtro e pagina vazia', async () => {
    window.history.replaceState(null, '', '/vendas?status=paid&page=3')
    salesStubs(() => ({ payload: { items: [], total: 0, page: 3, limit: 20 } }))
    renderWithQuery(<SalesPage />)

    expect(await screen.findByText('Nenhuma venda para estes filtros.')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Ver todas as vendas' }))
    expect(window.location.search).toBe('')
  })

  it('detalhe inexistente e controlado com volta', async () => {
    salesStubs(() => ({ payload: { code: 'SALE_NOT_FOUND', message: 'Venda não encontrada.' }, status: 404 }))
    renderWithQuery(<SaleDetailPage saleId={saleId} />)

    expect(await screen.findByText('Venda não encontrada.')).toBeVisible()
    expect(screen.getByRole('link', { name: 'Voltar às vendas' })).toHaveAttribute('href', '/vendas')
  })

  it('oculta pagamento e troca sem permissao', async () => {
    stubFetch((url) => {
      if (url.endsWith('/api/auth/session')) {
        return { payload: { user: { displayName: 'Op', role: 'operator' }, permissions: ['sales:read'] } }
      }
      return { payload: pendingDetail() }
    })
    renderWithQuery(<SaleDetailPage saleId={saleId} />)

    await screen.findByRole('heading', { name: /Venda 22222222/ })
    expect(screen.queryByRole('button', { name: 'Registrar pagamento' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Registrar troca' })).not.toBeInTheDocument()
  })

  it('recupera pagamento incerto com mesma chave apos recarga', async () => {
    const body = JSON.stringify({ amount: '150.00', method: 'pix' })
    sessionStorage.setItem('erp.pendingPaymentOperation.v1', JSON.stringify({ key: 'pag-1', body, saleId, csrf: '' }))
    const fetchMock = salesStubs((url, init) => {
      if (url.endsWith(`/api/sales/${saleId}/payments`) && init?.method === 'POST') {
        return { payload: { id: 'pay-1', saleId, status: 'paid', amountDue: '0.00' }, status: 201 }
      }
      return undefined
    })
    renderWithQuery(<SaleDetailPage saleId={saleId} />)

    fireEvent.click(await screen.findByRole('button', { name: /tentar novamente/i }))
    await screen.findByText(/Pagamento registrado/)
    const calls = fetchMock.mock.calls.filter(([url, init]) => String(url).endsWith(`/api/sales/${saleId}/payments`) && (init as RequestInit)?.method === 'POST')
    expect(calls).toHaveLength(1)
    expect(new Headers((calls[0]?.[1] as RequestInit)?.headers).get('Idempotency-Key')).toBe('pag-1')
    expect((calls[0]?.[1] as RequestInit)?.body).toBe(body)
    expect(sessionStorage.getItem('erp.pendingPaymentOperation.v1')).toBeNull()
  })

    it('troca com erro preserva motivo e formulario', async () => {    salesStubs((url, init) => {
      if (url.endsWith(`/api/sales/${saleId}/exchanges`) && init?.method === 'POST') {
        return { payload: { code: 'EXCHANGE_VALUE_MISMATCH', message: 'Trocas com diferença de valor exigem tratamento financeiro ainda não aprovado.' }, status: 409 }
      }
      if (url.includes('/api/products')) {
        return {
          payload: {
            items: [{
              id: 'product-1', club: 'Flamengo', model: 'Home',
              variants: [{ id: variantId, type: 'Masculina', size: 'M', sku: 'FLA-M', salePrice: '150.00', stockQuantity: 5 }],
            }],
            total: 1, page: 1, limit: 20,
          },
        }
      }
      return undefined
    })
    renderWithQuery(<SaleDetailPage saleId={saleId} />)

    await screen.findByText(/Pendente/)
    fireEvent.change(screen.getByRole('textbox', { name: 'Motivo da troca' }), { target: { value: 'Tamanho errado' } })
    fireEvent.change(screen.getByLabelText('Item vendido (devolver)'), { target: { value: variantId } })
    fireEvent.change(screen.getByPlaceholderText('Digite ao menos 2 letras'), { target: { value: 'FLA' } })
    fireEvent.click(await screen.findByRole('radio'))
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Devolver (qtd)' }), { target: { value: '1' } })
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Entregar (qtd)' }), { target: { value: '1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Registrar troca' }))

    expect(await screen.findByText(/diferença de valor/)).toBeVisible()
    expect(screen.getByRole('textbox', { name: 'Motivo da troca' })).toHaveValue('Tamanho errado')
    await waitFor(() => {
      expect(screen.queryByText(/Troca registrada/)).not.toBeInTheDocument()
    })
  })

  it('trava todos os campos do pagamento em operacao incerta', async () => {
    const body = JSON.stringify({ amount: '150.00', method: 'pix' })
    sessionStorage.setItem('erp.pendingPaymentOperation.v1', JSON.stringify({ key: 'pag-1', body, saleId, csrf: '' }))
    salesStubs()
    renderWithQuery(<SaleDetailPage saleId={saleId} />)

    await screen.findByRole('button', { name: /tentar novamente/i })
    expect(screen.getByRole('textbox', { name: 'Valor' })).toBeDisabled()
    expect(screen.getByLabelText('Método')).toBeDisabled()
  })

  it('recusa pagamento invalido ou acima do saldo sem enviar', async () => {
    for (const amount of ['abc', '0.00', '200.00']) {
      const fetchMock = salesStubs()
      renderWithQuery(<SaleDetailPage saleId={saleId} />)
      await screen.findByRole('button', { name: 'Registrar pagamento' })
      fireEvent.change(screen.getByRole('textbox', { name: 'Valor' }), { target: { value: amount } })
      fireEvent.click(screen.getByRole('button', { name: 'Registrar pagamento' }))
      expect(await screen.findByRole('alert')).toBeVisible()
      expect(fetchMock.mock.calls.filter(([url, init]) => String(url).endsWith('/payments') && (init as RequestInit)?.method === 'POST')).toHaveLength(0)
      expect(screen.getByRole('textbox', { name: 'Valor' })).toHaveValue(amount)
      cleanup()
    }
  })

  it('busca de entrega com erro permite retry e saldo zero desabilita com motivo', async () => {
    let pickerCalls = 0
    salesStubs((url) => {
      if (url.includes('/api/products')) {
        pickerCalls += 1
        return pickerCalls === 1
          ? { payload: { code: 'INTERNAL_ERROR', message: 'Falha na busca.' }, status: 500 }
          : {
            payload: {
              items: [{
                id: 'product-1', club: 'Flamengo', model: 'Home',
                variants: [
                  { id: variantId, type: 'Masculina', size: 'M', sku: 'FLA-M', salePrice: '150.00', stockQuantity: 0 },
                  { id: '33333333-3333-4333-8333-333333333333', type: 'Masculina', size: 'G', sku: 'FLA-G', salePrice: '150.00', stockQuantity: 2 },
                ],
              }],
              total: 1, page: 1, limit: 20,
            },
          }
      }
      return undefined
    })
    renderWithQuery(<SaleDetailPage saleId={saleId} />)
    await screen.findByText(/Pendente/)

    fireEvent.change(screen.getByPlaceholderText('Digite ao menos 2 letras'), { target: { value: 'FLA' } })
    expect(await screen.findByText('Falha na busca.')).toBeVisible()
    fireEvent.click(await screen.findByRole('button', { name: 'Buscar novamente' }))
    const radios = await screen.findAllByRole('radio')
    expect(radios).toHaveLength(2)
    expect(radios[0]).toBeDisabled()
    expect(screen.getByText(/sem saldo/)).toBeVisible()
    expect(radios[1]).toBeEnabled()
  })

  it('descarta registro de troca malformado sem restaurar', async () => {
    for (const raw of [
      '{nao-json',
      JSON.stringify({ key: 'k', body: '{}', saleId, csrf: '' }),
      JSON.stringify({
        key: 'k',
        body: JSON.stringify({ reason: 'x', returned: [{ variantId, quantity: 1 }], delivered: [{ variantId, quantity: 1 }] }),
        saleId, csrf: '',
      }).slice(0, -20),
    ]) {
      sessionStorage.setItem('erp.pendingExchangeOperation.v1', raw)
      salesStubs()
      const { unmount } = renderWithQuery(<SaleDetailPage saleId={saleId} />)
      await screen.findByRole('button', { name: 'Registrar troca' })
      expect(screen.queryByRole('button', { name: /tentar novamente/i })).not.toBeInTheDocument()
      expect(sessionStorage.getItem('erp.pendingExchangeOperation.v1')).toBeNull()
      unmount()
      sessionStorage.clear()
    }
  })

  it('registra dois pagamentos sequenciais com chaves distintas', async () => {
    let confirmedCount = 0
    const paidAmounts: string[] = []
    const fetchMock = salesStubs((url, init) => {
      if (url.endsWith(`/api/sales/${saleId}`) && (!init || !init.method || init.method === 'GET')) {
        const payments = paidAmounts.map((amount, index) => ({ id: `pay-${index + 1}`, amount, method: 'pix', status: 'confirmed' }))
        const due = formatDue(paidAmounts)
        const status = due === '0.00' ? 'paid' : paidAmounts.length === 0 ? 'pending' : 'partially_paid'
        return { payload: { ...pendingDetail(), status, amountDue: due, payments } }
      }
      if (url.endsWith(`/api/sales/${saleId}/payments`) && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { amount: string }
        confirmedCount += 1
        paidAmounts.push(body.amount)
        const due = formatDue(paidAmounts)
        return {
          payload: {
            id: `pay-${confirmedCount}`, saleId,
            status: due === '0.00' ? 'paid' : 'partially_paid', amountDue: due,
          },
          status: 201,
        }
      }
      return undefined
    })
    function formatDue(amounts: string[]): string {
      const paid = amounts.reduce((sum, amount) => sum + Number(amount), 0)
      return (150 - paid).toFixed(2)
    }
    renderWithQuery(<SaleDetailPage saleId={saleId} />)
    await screen.findByRole('button', { name: 'Registrar pagamento' })

    fireEvent.change(screen.getByRole('textbox', { name: 'Valor' }), { target: { value: '90.00' } })
    fireEvent.click(screen.getByRole('button', { name: 'Registrar pagamento' }))
    await screen.findByText('Pagamento registrado.', { exact: true })

    await waitFor(() => expect(screen.getByText(/saldo devido/i).closest('p')).toHaveTextContent(/60,00/))
    expect(screen.getAllByText(/90,00/).length).toBeGreaterThan(0)

    fireEvent.change(screen.getByRole('textbox', { name: 'Valor' }), { target: { value: '60.00' } })
    fireEvent.click(screen.getByRole('button', { name: 'Registrar pagamento' }))
    await waitFor(() => expect(screen.getByText(/saldo devido/i).closest('p')).toHaveTextContent(/0,00/))

    const posts = fetchMock.mock.calls.filter(([url, init]) => String(url).endsWith(`/api/sales/${saleId}/payments`) && (init as RequestInit)?.method === 'POST')
    expect(posts).toHaveLength(2)
    const bodies = posts.map(([, init]) => JSON.parse(String((init as RequestInit)?.body)))
    expect(bodies).toEqual([{ amount: '90.00', method: 'pix' }, { amount: '60.00', method: 'pix' }])
    const keys = posts.map(([, init]) => new Headers((init as RequestInit)?.headers).get('Idempotency-Key'))
    expect(keys[0]).toBeTruthy()
    expect(keys[1]).toBeTruthy()
    expect(keys[0]).not.toBe(keys[1])
  })

  it('limpa o aviso anterior durante a segunda operacao incerta', async () => {
    const paidAmounts: string[] = []
    let failNextPost = false
    const fetchMock = salesStubs((url, init) => {
      if (url.endsWith(`/api/sales/${saleId}`) && (!init || !init.method || init.method === 'GET')) {
        const payments = paidAmounts.map((amount, index) => ({ id: `pay-${index + 1}`, amount, method: 'pix', status: 'confirmed' }))
        const paid = paidAmounts.reduce((sum, amount) => sum + Number(amount), 0)
        const due = (150 - paid).toFixed(2)
        return { payload: { ...pendingDetail(), status: due === '0.00' ? 'paid' : paidAmounts.length === 0 ? 'pending' : 'partially_paid', amountDue: due, payments } }
      }
      if (url.endsWith(`/api/sales/${saleId}/payments`) && init?.method === 'POST') {
        if (failNextPost) {
          failNextPost = false
          throw new TypeError('resposta perdida')
        }
        const body = JSON.parse(String(init.body)) as { amount: string }
        paidAmounts.push(body.amount)
        const paid = paidAmounts.reduce((sum, amount) => sum + Number(amount), 0)
        const due = (150 - paid).toFixed(2)
        return {
          payload: { id: `pay-${paidAmounts.length}`, saleId, status: due === '0.00' ? 'paid' : 'partially_paid', amountDue: due },
          status: 201,
        }
      }
      return undefined
    })
    renderWithQuery(<SaleDetailPage saleId={saleId} />)
    await screen.findByRole('button', { name: 'Registrar pagamento' })

    fireEvent.change(screen.getByRole('textbox', { name: 'Valor' }), { target: { value: '90.00' } })
    fireEvent.click(screen.getByRole('button', { name: 'Registrar pagamento' }))
    await screen.findByText('Pagamento registrado.', { exact: true })

    failNextPost = true
    fireEvent.change(screen.getByRole('textbox', { name: 'Valor' }), { target: { value: '60.00' } })
    fireEvent.click(screen.getByRole('button', { name: 'Registrar pagamento' }))
    await screen.findByRole('button', { name: /tentar novamente/i })
    expect(screen.queryByText('Pagamento registrado.', { exact: true })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /tentar novamente/i }))
    await screen.findByText('Pagamento registrado.', { exact: true })
    const posts = fetchMock.mock.calls.filter(([url, init]) => String(url).endsWith(`/api/sales/${saleId}/payments`) && (init as RequestInit)?.method === 'POST')
    expect(posts).toHaveLength(3)
    const keys = posts.map(([, init]) => new Headers((init as RequestInit)?.headers).get('Idempotency-Key'))
    expect(new Set(keys).size).toBe(2)
    expect(keys[1]).toBe(keys[2])
  })
})

describe('estorno de venda', () => {
  function paidDetail(status = 'paid') {
    return {
      id: saleId, customerId: null, status, subtotalAmount: '150.00', discountAmount: '0.00',
      finalAmount: '150.00', amountDue: '0.00',
      items: [{ variantId, quantity: 1, unitPrice: '150.00', unitCost: '80.00' }],
      payments: [{ id: 'pay-1', amount: '150.00', method: 'pix', status }],
      exchanges: [],
    }
  }

  it('estorna venda paga com csrf, motivo opcional e recarrega o detalhe', async () => {
    document.cookie = 'erp_csrf=csrf-test'
    const fetchMock = salesStubs((url, init) => {
      if (url.endsWith(`/api/sales/${saleId}`)) return { payload: paidDetail() }
      if (url.endsWith(`/api/sales/${saleId}/reversal`) && init?.method === 'POST') {
        return { payload: { id: saleId, status: 'reversed', paymentsReversed: 1 } }
      }
      return undefined
    })
    renderWithQuery(<SaleDetailPage saleId={saleId} />)

    await screen.findByRole('button', { name: 'Estornar venda' })
    fireEvent.click(screen.getByRole('button', { name: 'Estornar venda' }))
    await waitFor(() => expect(screen.getByText('Venda estornada.')).toBeVisible())

    const posts = fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/reversal'))
    expect(posts).toHaveLength(1)
    const init = posts[0]?.[1] as RequestInit
    expect(new Headers(init.headers).get('x-csrf-token')).toBe('csrf-test')
    expect(JSON.parse(String(init.body))).toEqual({})
  })

  it('estorna com motivo informado preservando o formulario em erro', async () => {
    document.cookie = 'erp_csrf=csrf-test'
    const fetchMock = salesStubs((url, init) => {
      if (url.endsWith(`/api/sales/${saleId}`)) return { payload: paidDetail() }
      if (url.endsWith(`/api/sales/${saleId}/reversal`) && init?.method === 'POST') {
        return { payload: { code: 'VALIDATION_ERROR', message: 'Revise a venda e o motivo do estorno.' }, status: 400 }
      }
      return undefined
    })
    renderWithQuery(<SaleDetailPage saleId={saleId} />)

    fireEvent.change(await screen.findByRole('textbox', { name: 'Motivo do estorno (opcional)' }), { target: { value: 'Venda digitada errada' } })
    fireEvent.click(screen.getByRole('button', { name: 'Estornar venda' }))
    expect(await screen.findByText('Revise a venda e o motivo do estorno.')).toBeVisible()
    expect(screen.getByRole('textbox', { name: 'Motivo do estorno (opcional)' })).toHaveValue('Venda digitada errada')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Estornar venda' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Estornar venda' }))

    await waitFor(() => expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/reversal'))).toHaveLength(2))
    const posts = fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/reversal'))
    expect(JSON.parse(String((posts[1]?.[1] as RequestInit).body))).toEqual({ reason: 'Venda digitada errada' })
    cleanup()
  })

  it('sem permissao nao oferece estorno', async () => {
    stubFetch((url) => {
      if (url.endsWith('/api/auth/session')) return { payload: { user: { displayName: 'Operador', role: 'operator' }, permissions: ['sales:read'] } }
      if (url.endsWith(`/api/sales/${saleId}`)) return { payload: paidDetail() }
      return { payload: { items: [] } }
    })
    renderWithQuery(<SaleDetailPage saleId={saleId} />)

    expect(await screen.findByText('Seu perfil não tem permissão para estornar vendas.')).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Estornar venda' })).not.toBeInTheDocument()
  })

  it('venda estornada exibe estado e nao oferece novo estorno', async () => {
    salesStubs((url) => {
      if (url.endsWith(`/api/sales/${saleId}`)) return { payload: paidDetail('reversed') }
      return undefined
    })
    renderWithQuery(<SaleDetailPage saleId={saleId} />)

    expect(await screen.findByText('Venda estornada; estoque e pagamentos foram revertidos.')).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Estornar venda' })).not.toBeInTheDocument()
  })

  it('venda com troca explica a regra no lugar do formulario', async () => {
    const detail = { ...paidDetail(), exchanges: [{ id: 'ex-1', reason: 'Tamanho', items: [] }] }
    stubFetch((url) => {
      if (url.endsWith('/api/auth/session')) return { payload: managerSession() }
      if (url.endsWith(`/api/sales/${saleId}`)) return { payload: detail }
      return { payload: { items: [] } }
    })
    renderWithQuery(<SaleDetailPage saleId={saleId} />)

    expect(await screen.findByText('Venda com troca não pode ser estornada; corrija pelas trocas.')).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Estornar venda' })).not.toBeInTheDocument()
  })
})
