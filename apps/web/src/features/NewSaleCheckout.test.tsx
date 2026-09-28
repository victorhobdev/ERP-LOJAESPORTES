import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { DashboardPage, NewSalePage, SettingsPage } from './OperationalPages.js'
import { formatCentsToMoney, saleTotalCents } from '../lib/money.js'

afterEach(() => {
  vi.unstubAllGlobals()
  sessionStorage.clear()
  document.cookie = 'erp_csrf=; Max-Age=0'
})

function renderWithQuery(ui: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
}

const variantId = '11111111-1111-4111-8111-111111111111'
function productsPayload() {
  return {
    items: [{
      id: 'product-1', club: 'Flamengo', model: 'Home', variants: [{
        id: variantId, type: 'Masculina', size: 'M', sku: 'FLA-M',
        salePrice: '150.00', stockQuantity: 2,
      }],
    }],
  }
}

/** Data futura (30 dias) em YYYY-MM-DD, computada na execucao para nao virar bomba-relogio. */
function futureDueDate(): string {
  const d = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
describe('bloco 1 regressao: venda paga confiavel', () => {
  it('reutiliza chave e payload na retentativa apos resposta perdida', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(productsPayload()), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      }))
      .mockRejectedValueOnce(new TypeError('resposta perdida'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'sale-1', status: 'paid', finalAmount: '150.00' }), {
        status: 201, headers: { 'Content-Type': 'application/json' },
      }))
    vi.stubGlobal('fetch', fetchMock)

    renderWithQuery(<NewSalePage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Adicionar Flamengo Home, tamanho M' }))
    fireEvent.click(screen.getByRole('button', { name: 'Finalizar venda' }))

    const retry = await screen.findByRole('button', { name: /tentar novamente/i })
    const firstSaleCall = fetchMock.mock.calls.find(([url, init]) => String(url).endsWith('/api/sales') && (init as RequestInit)?.method === 'POST')
    expect(firstSaleCall).toBeTruthy()
    const firstKey = new Headers((firstSaleCall?.[1] as RequestInit)?.headers).get('Idempotency-Key')
    const firstBody = (firstSaleCall?.[1] as RequestInit)?.body
    expect(firstKey).toBeTruthy()

    fireEvent.click(retry)
    await screen.findByText('Venda concluída')
    const saleCalls = fetchMock.mock.calls.filter(([url, init]) => String(url).endsWith('/api/sales') && (init as RequestInit)?.method === 'POST')
    expect(saleCalls).toHaveLength(2)
    for (const [, init] of saleCalls) {
      expect(new Headers((init as RequestInit)?.headers).get('Idempotency-Key')).toBe(firstKey)
      expect((init as RequestInit)?.body).toBe(firstBody)
    }
  })

  it('bloqueia alteracao do carrinho enquanto a operacao esta incerta', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(productsPayload()), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      }))
      .mockRejectedValueOnce(new TypeError('resposta perdida'))
    vi.stubGlobal('fetch', fetchMock)

    renderWithQuery(<NewSalePage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Adicionar Flamengo Home, tamanho M' }))
    fireEvent.click(screen.getByRole('button', { name: 'Finalizar venda' }))

    await screen.findByRole('button', { name: /tentar novamente/i })
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Adicionar Flamengo Home, tamanho M' })).toBeDisabled()
    })
  })

  it('calcula totais em centavos inteiros exatos', () => {
    expect(saleTotalCents([{ salePrice: '0.10', quantity: 3 }])).toBe(30n)
    expect(saleTotalCents([{ salePrice: '19.99', quantity: 3 }])).toBe(5997n)
    expect(formatCentsToMoney(5997n)).toBe('59.97')
  })

  it('sinaliza sessao expirada com caminho para login', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: 'UNAUTHENTICATED', message: 'Sessão inválida ou expirada.' }), {
      status: 401, headers: { 'Content-Type': 'application/json' },
    })))
    renderWithQuery(<DashboardPage date="2026-08-30" />)
    expect(await screen.findByText(/sessão expirada/i)).toBeVisible()
    expect(screen.getByRole('link', { name: /entrar/i })).toHaveAttribute('href', '/login')
  })

  it('recupera operacao incerta apos recarga com mesma chave e payload', async () => {
    const opKey = '22222222-2222-4222-8222-222222222222'
    const body = JSON.stringify({
      items: [{ variantId, quantity: 1 }],
      discountAmount: '0.00', payment: { amount: '150.00', method: 'pix' },
    })
    sessionStorage.setItem('erp.pendingSaleOperation.v1', JSON.stringify({
      key: opKey, body, csrf: 'csrf-a',
      cart: [{ id: variantId, type: 'Masculina', size: 'M', sku: 'FLA-M', salePrice: '150.00', stockQuantity: 2, label: 'Flamengo Home', quantity: 1 }],
    }))
    document.cookie = 'erp_csrf=csrf-a'
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(productsPayload()), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'sale-9', status: 'paid', finalAmount: '150.00' }), {
        status: 201, headers: { 'Content-Type': 'application/json' },
      }))
    vi.stubGlobal('fetch', fetchMock)

    renderWithQuery(<NewSalePage />)
    expect(await screen.findByRole('button', { name: /tentar novamente/i })).toBeVisible()
    expect(await screen.findByRole('button', { name: 'Adicionar Flamengo Home, tamanho M' })).toBeDisabled()
    expect(screen.getAllByText(/FLA-M/)).not.toHaveLength(0)

    fireEvent.click(screen.getByRole('button', { name: /tentar novamente/i }))
    await screen.findByText('Venda concluída')
    const saleCalls = fetchMock.mock.calls.filter(([url, init]) => String(url).endsWith('/api/sales') && (init as RequestInit)?.method === 'POST')
    expect(saleCalls).toHaveLength(1)
    expect(new Headers((saleCalls[0]?.[1] as RequestInit)?.headers).get('Idempotency-Key')).toBe(opKey)
    expect((saleCalls[0]?.[1] as RequestInit)?.body).toBe(body)
    expect(sessionStorage.getItem('erp.pendingSaleOperation.v1')).toBeNull()
  })

  it('descarta operacao gravada quando a sessao e de outro usuario', async () => {
    sessionStorage.setItem('erp.pendingSaleOperation.v1', JSON.stringify({
      key: '33333333-3333-4333-8333-333333333333', body: '{}', csrf: 'csrf-old',
      cart: [{ id: variantId, type: 'Masculina', size: 'M', sku: 'FLA-M', salePrice: '150.00', stockQuantity: 2, label: 'Flamengo Home', quantity: 1 }],
    }))
    document.cookie = 'erp_csrf=csrf-new'
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(productsPayload()), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    })))

    renderWithQuery(<NewSalePage />)
    const add = await screen.findByRole('button', { name: 'Adicionar Flamengo Home, tamanho M' })
    expect(add).toBeEnabled()
    expect(screen.queryByRole('button', { name: /tentar novamente/i })).not.toBeInTheDocument()
    expect(screen.getByText('Adicione um produto para começar.')).toBeVisible()
    expect(sessionStorage.getItem('erp.pendingSaleOperation.v1')).toBeNull()
  })

  it('conclui logout apenas apos 204 e limpa o cache do usuario anterior', async () => {
    const { assign, restore } = stubAssign()
    try {
      const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
        if (String(url).endsWith('/api/auth/session')) {
          return Promise.resolve(new Response(JSON.stringify({ user: { displayName: 'Caixa', role: 'administrator' }, permissions: ['*'] }), {
            status: 200, headers: { 'Content-Type': 'application/json' },
          }))
        }
        if (String(url).includes('/api/users')) {
          return Promise.resolve(new Response(JSON.stringify({ items: [], total: 0, page: 1, limit: 20 }), {
            status: 200, headers: { 'Content-Type': 'application/json' },
          }))
        }
        if (String(url).endsWith('/api/health/ready')) {
          return Promise.resolve(new Response(JSON.stringify({
            status: 'ready', service: 'erp-api', version: '0.0.0',
            checks: { database: 'up' }, integrations: { catalog: 'not_configured' },
          }), {
            status: 200, headers: { 'Content-Type': 'application/json' },
          }))
        }
        expect((init as RequestInit)?.method).toBe('POST')
        return Promise.resolve(new Response(null, { status: 204 }))
      })
      vi.stubGlobal('fetch', fetchMock)
      const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
      client.setQueryData(['products'], { items: [{ id: 'anterior' }] })
      render(<QueryClientProvider client={client}><SettingsPage /></QueryClientProvider>)

      fireEvent.click(await screen.findByRole('button', { name: 'Sair' }))
      await waitFor(() => expect(assign).toHaveBeenCalledWith('/login'))
      expect(client.getQueryData(['products'])).toBeUndefined()
    } finally {
      restore()
    }
  })

  it('expoe falha de rede no logout sem sair e permite nova tentativa', async () => {
    const { assign, restore } = stubAssign()
    try {
      let logoutCalls = 0
      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (String(url).endsWith('/api/auth/session')) {
          return Promise.resolve(new Response(JSON.stringify({ user: { displayName: 'Caixa', role: 'administrator' }, permissions: ['*'] }), {
            status: 200, headers: { 'Content-Type': 'application/json' },
          }))
        }
        if (String(url).includes('/api/users')) {
          return Promise.resolve(new Response(JSON.stringify({ items: [], total: 0, page: 1, limit: 20 }), {
            status: 200, headers: { 'Content-Type': 'application/json' },
          }))
        }
        if (String(url).endsWith('/api/health/ready')) {
          return Promise.resolve(new Response(JSON.stringify({
            status: 'ready', service: 'erp-api', version: '0.0.0',
            checks: { database: 'up' }, integrations: { catalog: 'not_configured' },
          }), {
            status: 200, headers: { 'Content-Type': 'application/json' },
          }))
        }
        logoutCalls += 1
        if (logoutCalls === 1) return Promise.reject(new TypeError('rede indisponível'))
        return Promise.resolve(new Response(null, { status: 204 }))
      })
      vi.stubGlobal('fetch', fetchMock)
      const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
      client.setQueryData(['products'], { items: [{ id: 'anterior' }] })
      render(<QueryClientProvider client={client}><SettingsPage /></QueryClientProvider>)

      fireEvent.click(await screen.findByRole('button', { name: 'Sair' }))
      expect(await screen.findByRole('button', { name: /tentar novamente/i })).toBeVisible()
      expect(assign).not.toHaveBeenCalled()
      expect(client.getQueryData(['products'])).toEqual({ items: [{ id: 'anterior' }] })

      fireEvent.click(screen.getByRole('button', { name: /tentar novamente/i }))
      await waitFor(() => expect(assign).toHaveBeenCalledWith('/login'))
      expect(client.getQueryData(['products'])).toBeUndefined()
    } finally {
      restore()
    }
  })

  it('expoe rejeicao de CSRF no logout sem sair', async () => {
    const { assign, restore } = stubAssign()
    try {
      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (String(url).endsWith('/api/auth/session')) {
          return Promise.resolve(new Response(JSON.stringify({ user: { displayName: 'Caixa', role: 'administrator' }, permissions: ['*'] }), {
            status: 200, headers: { 'Content-Type': 'application/json' },
          }))
        }
        if (String(url).includes('/api/users')) {
          return Promise.resolve(new Response(JSON.stringify({ items: [], total: 0, page: 1, limit: 20 }), {
            status: 200, headers: { 'Content-Type': 'application/json' },
          }))
        }
        if (String(url).endsWith('/api/health/ready')) {
          return Promise.resolve(new Response(JSON.stringify({
            status: 'ready', service: 'erp-api', version: '0.0.0',
            checks: { database: 'up' }, integrations: { catalog: 'not_configured' },
          }), {
            status: 200, headers: { 'Content-Type': 'application/json' },
          }))
        }
        return Promise.resolve(new Response(JSON.stringify({ code: 'INVALID_CSRF', message: 'Token CSRF inválido.' }), {
          status: 403, headers: { 'Content-Type': 'application/json' },
        }))
      })
      vi.stubGlobal('fetch', fetchMock)
      renderWithQuery(<SettingsPage />)

      fireEvent.click(await screen.findByRole('button', { name: 'Sair' }))
      expect(await screen.findByText('Token CSRF inválido.')).toBeVisible()
      expect(screen.getByRole('button', { name: /tentar novamente/i })).toBeVisible()
      expect(assign).not.toHaveBeenCalled()
    } finally {
      restore()
    }
  })
})

function stubAssign() {
  const assign = vi.fn()
  const original = Object.getOwnPropertyDescriptor(window, 'location')
  Object.defineProperty(window, 'location', { configurable: true, writable: true, value: { assign } })
  return { assign, restore: () => { if (original) Object.defineProperty(window, 'location', original) } }
}

const customerId = '44444444-4444-4444-8444-444444444444'
function saleStubs(extra?: (url: string, init?: RequestInit) => { payload: unknown; status?: number } | undefined) {
  const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    const address = String(url)
    if (address.includes('/api/customers')) {
      if (init?.method === 'POST') {
        return Promise.resolve(new Response(JSON.stringify({ id: customerId, name: 'Cliente E2E', contact: null }), {
          status: 201, headers: { 'Content-Type': 'application/json' },
        }))
      }
      return Promise.resolve(new Response(JSON.stringify({ items: [{ id: customerId, name: 'Cliente E2E', contact: null }], total: 1 }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      }))
    }
    const override = extra?.(address, init)
    if (override) {
      return Promise.resolve(new Response(JSON.stringify(override.payload), {
        status: override.status ?? 200, headers: { 'Content-Type': 'application/json' },
      }))
    }
    return Promise.resolve(new Response(JSON.stringify(productsPayload()), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }))
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('bloco 3: modos de criacao da venda', () => {
  it('pendente exige cliente e vencimento sem enviar', async () => {
    const fetchMock = saleStubs()
    renderWithQuery(<NewSalePage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Adicionar Flamengo Home, tamanho M' }))
    fireEvent.click(screen.getByRole('radio', { name: 'Pendente' }))
    fireEvent.click(screen.getByRole('button', { name: 'Finalizar venda' }))

    expect(await screen.findByText('Selecione ou cadastre um cliente para venda pendente ou parcial.')).toBeVisible()
    expect(salePosts(fetchMock)).toHaveLength(0)
    expect(screen.getAllByText(/FLA-M/)).not.toHaveLength(0)
  })

  it('pendente rejeita vencimento passado sem enviar', async () => {
    const fetchMock = saleStubs()
    renderWithQuery(<NewSalePage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Adicionar Flamengo Home, tamanho M' }))
    fireEvent.click(screen.getByRole('radio', { name: 'Pendente' }))
    fireEvent.change(screen.getByPlaceholderText('Digite ao menos 2 letras'), { target: { value: 'E2E' } })
    fireEvent.click(await screen.findByRole('radio', { name: /Cliente E2E/ }))
    fireEvent.change(screen.getByLabelText('Vencimento'), { target: { value: '2020-01-01' } })
    fireEvent.click(screen.getByRole('button', { name: 'Finalizar venda' }))

    expect(await screen.findByText('O vencimento deve ser uma data futura.')).toBeVisible()
    expect(salePosts(fetchMock)).toHaveLength(0)
  })

  it('pendente com cliente e vencimento grava sem pagamento', async () => {
    const fetchMock = saleStubs((url, init) => {
      if (url.endsWith('/api/sales') && init?.method === 'POST') {
        return { payload: { id: 'sale-p', status: 'pending', finalAmount: '150.00' }, status: 201 }
      }
      return undefined
    })
    renderWithQuery(<NewSalePage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Adicionar Flamengo Home, tamanho M' }))
    fireEvent.click(screen.getByRole('radio', { name: 'Pendente' }))
    fireEvent.change(screen.getByPlaceholderText('Digite ao menos 2 letras'), { target: { value: 'E2E' } })
    fireEvent.click(await screen.findByRole('radio', { name: /Cliente E2E/ }))
    fireEvent.change(screen.getByLabelText('Vencimento'), { target: { value: futureDueDate() } })
    fireEvent.click(screen.getByRole('button', { name: 'Finalizar venda' }))

    await screen.findByText('Venda concluída')
    const posts = salePosts(fetchMock)
    expect(posts).toHaveLength(1)
    expect(JSON.parse(String(posts[0]?.[1] && (posts[0][1] as RequestInit).body))).toEqual({
      items: [{ variantId, quantity: 1 }],
      discountAmount: '0.00',
      customerId,
      paymentDueDate: futureDueDate(),
    })
  })

  it('parcial valida valor e grava com saldo', async () => {
    const fetchMock = saleStubs((url, init) => {
      if (url.endsWith('/api/sales') && init?.method === 'POST') {
        return { payload: { id: 'sale-pp', status: 'partially_paid', finalAmount: '150.00' }, status: 201 }
      }
      return undefined
    })
    renderWithQuery(<NewSalePage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Adicionar Flamengo Home, tamanho M' }))
    fireEvent.click(screen.getByRole('radio', { name: 'Parcialmente pago' }))
    fireEvent.change(screen.getByPlaceholderText('Digite ao menos 2 letras'), { target: { value: 'E2E' } })
    fireEvent.click(await screen.findByRole('radio', { name: /Cliente E2E/ }))
    fireEvent.change(screen.getByLabelText('Vencimento'), { target: { value: futureDueDate() } })

    fireEvent.change(screen.getByLabelText('Valor inicial'), { target: { value: '0.00' } })
    fireEvent.click(screen.getByRole('button', { name: 'Finalizar venda' }))
    expect(await screen.findByText(/maior que zero/)).toBeVisible()
    expect(salePosts(fetchMock)).toHaveLength(0)

    fireEvent.change(screen.getByLabelText('Valor inicial'), { target: { value: '150.00' } })
    fireEvent.click(screen.getByRole('button', { name: 'Finalizar venda' }))
    expect(await screen.findByText(/menor que o total/)).toBeVisible()
    expect(salePosts(fetchMock)).toHaveLength(0)

    fireEvent.change(screen.getByLabelText('Valor inicial'), { target: { value: '60.00' } })
    fireEvent.click(screen.getByRole('button', { name: 'Finalizar venda' }))
    await screen.findByText('Venda concluída')
    const posts = salePosts(fetchMock)
    expect(posts).toHaveLength(1)
    expect(JSON.parse(String(posts[0]?.[1] && (posts[0][1] as RequestInit).body))).toMatchObject({
      customerId, paymentDueDate: futureDueDate(), payment: { amount: '60.00', method: 'pix' },
    })
  })

  it('cadastra cliente inline e usa na venda', async () => {
    const fetchMock = saleStubs((url, init) => {
      if (url.endsWith('/api/sales') && init?.method === 'POST') {
        return { payload: { id: 'sale-c', status: 'pending', finalAmount: '150.00' }, status: 201 }
      }
      return undefined
    })
    renderWithQuery(<NewSalePage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Adicionar Flamengo Home, tamanho M' }))
    fireEvent.click(screen.getByRole('radio', { name: 'Pendente' }))
    fireEvent.click(screen.getByRole('button', { name: 'Novo cliente' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Nome do cliente' }), { target: { value: 'Cliente E2E' } })
    fireEvent.click(screen.getByRole('button', { name: 'Cadastrar cliente' }))

    await screen.findByText(/Selecionado: Cliente E2E/)
    fireEvent.change(screen.getByLabelText('Vencimento'), { target: { value: futureDueDate() } })
    fireEvent.click(screen.getByRole('button', { name: 'Finalizar venda' }))
    await screen.findByText('Venda concluída')
    const posts = salePosts(fetchMock)
    expect(posts).toHaveLength(1)
    expect(JSON.parse(String(posts[0]?.[1] && (posts[0][1] as RequestInit).body))).toMatchObject({ customerId })
  })

  it('busca produtos por clube/modelo/SKU na URL da API', async () => {
    const fetchMock = saleStubs()
    renderWithQuery(<NewSalePage />)
    await screen.findByRole('button', { name: 'Adicionar Flamengo Home, tamanho M' })

    fireEvent.change(screen.getByPlaceholderText('Clube, modelo ou SKU'), { target: { value: 'FLA-M' } })
    await waitFor(() => {
      expect(fetchMock.mock.calls.map(([url]) => String(url)).some((url) => url.includes('search=FLA-M'))).toBe(true)
    })
  })

  it('recarga restaura modo, cliente e vencimento da operacao', async () => {
    const body = JSON.stringify({
      items: [{ variantId, quantity: 1 }], discountAmount: '0.00',
      customerId, paymentDueDate: futureDueDate(),
    })
    sessionStorage.setItem('erp.pendingSaleOperation.v1', JSON.stringify({
      key: 'k-pend', body, csrf: '',
      cart: [{ id: variantId, type: 'Masculina', size: 'M', sku: 'FLA-M', salePrice: '150.00', stockQuantity: 2, label: 'Flamengo Home', quantity: 1 }],
      context: { mode: 'pending', customerId, customerName: 'Cliente E2E', dueDate: futureDueDate(), amount: '', method: '' },
    }))
    saleStubs()
    renderWithQuery(<NewSalePage />)

    expect(await screen.findByRole('button', { name: /tentar novamente/i })).toBeVisible()
    expect(screen.getByRole('radio', { name: 'Pendente' })).toBeChecked()
    expect(screen.getByText(/Selecionado: Cliente E2E/)).toBeVisible()
    expect(screen.getByLabelText('Vencimento')).toHaveValue(futureDueDate())
  })
})

function salePosts(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.filter(([url, init]) => String(url).endsWith('/api/sales') && (init as RequestInit)?.method === 'POST')
}

describe('bloco 3 revisao: incerteza, contexto e cliente', () => {
  it('desabilita Finalizar venda em operacao incerta sem bloquear retry', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(productsPayload()), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      }))
      .mockRejectedValueOnce(new TypeError('resposta perdida'))
    vi.stubGlobal('fetch', fetchMock)

    renderWithQuery(<NewSalePage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Adicionar Flamengo Home, tamanho M' }))
    fireEvent.click(screen.getByRole('button', { name: 'Finalizar venda' }))

    const retry = await screen.findByRole('button', { name: /tentar novamente/i })
    expect(retry).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Finalizar venda' })).toBeDisabled()
  })

  it('troca de modo nao invalida a recuperacao da venda incerta', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(productsPayload()), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 'INTERNAL_ERROR', message: 'Falha.' }), {
        status: 500, headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify(productsPayload()), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'sale-1', status: 'paid', finalAmount: '150.00' }), {
        status: 201, headers: { 'Content-Type': 'application/json' },
      }))
    vi.stubGlobal('fetch', fetchMock)

    const first = renderWithQuery(<NewSalePage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Adicionar Flamengo Home, tamanho M' }))
    fireEvent.click(screen.getByRole('radio', { name: 'Pendente' }))
    fireEvent.change(screen.getByLabelText('Vencimento'), { target: { value: futureDueDate() } })
    fireEvent.click(screen.getByRole('radio', { name: 'Pago agora' }))
    fireEvent.click(screen.getByRole('button', { name: 'Finalizar venda' }))

    await screen.findByRole('button', { name: /tentar novamente/i })
    const firstKey = new Headers((salePosts(fetchMock)[0]?.[1] as RequestInit)?.headers).get('Idempotency-Key')
    expect(sessionStorage.getItem('erp.pendingSaleOperation.v1')).not.toBeNull()
    first.unmount()

    renderWithQuery(<NewSalePage />)
    fireEvent.click(await screen.findByRole('button', { name: /tentar novamente/i }))
    await screen.findByText('Venda concluída')
    const posts = salePosts(fetchMock)
    expect(posts).toHaveLength(2)
    for (const [, init] of posts) {
      expect(new Headers((init as RequestInit)?.headers).get('Idempotency-Key')).toBe(firstKey)
    }
    expect(sessionStorage.getItem('erp.pendingSaleOperation.v1')).toBeNull()
  })

  it('busca de cliente exibe loading com papel status', async () => {
    const resolvers: Array<(value: Response) => void> = []
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => new Promise<Response>((resolve) => { resolvers.push(resolve) })))

    renderWithQuery(<NewSalePage />)
    const productsResponse = new Response(JSON.stringify(productsPayload()), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    })
    await waitFor(() => expect(resolvers.length).toBeGreaterThan(0))
    resolvers[0]!(productsResponse)
    await screen.findByRole('button', { name: 'Adicionar Flamengo Home, tamanho M' })

    fireEvent.change(screen.getByPlaceholderText('Digite ao menos 2 letras'), { target: { value: 'Cl' } })
    expect(await screen.findByText(/buscando clientes/i)).toBeVisible()
    expect(screen.getByText(/buscando clientes/i).closest('[role="status"]')).not.toBeNull()

    resolvers.slice(1).forEach((resolve) => resolve(new Response(JSON.stringify({ items: [], total: 0 }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    })))
    await screen.findByText('Nenhum cliente para esta busca.')
  })

  it('cadastro de cliente repete mesma chave apos falha incerta', async () => {    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(productsPayload()), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      }))
      .mockRejectedValueOnce(new TypeError('rede instavel'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: customerId, name: 'Cliente Novo', contact: null }), {
        status: 201, headers: { 'Content-Type': 'application/json' },
      }))
    vi.stubGlobal('fetch', fetchMock)

    renderWithQuery(<NewSalePage />)
    await screen.findByRole('button', { name: 'Adicionar Flamengo Home, tamanho M' })
    fireEvent.click(screen.getByRole('button', { name: 'Novo cliente' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Nome do cliente' }), { target: { value: 'Cliente Novo' } })
    fireEvent.click(screen.getByRole('button', { name: 'Cadastrar cliente' }))

    const retry = await screen.findByRole('button', { name: /tentar novamente o cadastro/i })
    const firstCall = fetchMock.mock.calls.find(([url, init]) => String(url).endsWith('/api/customers') && (init as RequestInit)?.method === 'POST')
    const firstKey = new Headers((firstCall?.[1] as RequestInit)?.headers).get('Idempotency-Key')
    expect(firstKey).toBeTruthy()

    fireEvent.click(retry)
    await screen.findByText(/Selecionado: Cliente Novo/)
    const posts = fetchMock.mock.calls.filter(([url, init]) => String(url).endsWith('/api/customers') && (init as RequestInit)?.method === 'POST')
    expect(posts).toHaveLength(2)
    for (const [, init] of posts) {
      expect(new Headers((init as RequestInit)?.headers).get('Idempotency-Key')).toBe(firstKey)
    }
    expect(screen.queryByRole('textbox', { name: 'Nome do cliente' })).not.toBeInTheDocument()
  })

  it('4xx no cadastro limpa a operacao sem apagar os campos', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(productsPayload()), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 'VALIDATION_ERROR', message: 'Revise os dados do cliente.' }), {
        status: 400, headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify(productsPayload()), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      }))
    vi.stubGlobal('fetch', fetchMock)

    const first = renderWithQuery(<NewSalePage />)
    await screen.findByRole('button', { name: 'Adicionar Flamengo Home, tamanho M' })
    fireEvent.click(screen.getByRole('button', { name: 'Novo cliente' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Nome do cliente' }), { target: { value: 'Cliente Ruim' } })
    fireEvent.click(screen.getByRole('button', { name: 'Cadastrar cliente' }))

    expect(await screen.findByText('Revise os dados do cliente.')).toBeVisible()
    expect(screen.getByRole('textbox', { name: 'Nome do cliente' })).toHaveValue('Cliente Ruim')
    expect(screen.getByRole('textbox', { name: 'Nome do cliente' })).toBeEnabled()
    expect(sessionStorage.getItem('erp.pendingCustomerOperation.v1')).toBeNull()
    first.unmount()

    renderWithQuery(<NewSalePage />)
    await screen.findByRole('button', { name: 'Adicionar Flamengo Home, tamanho M' })
    expect(screen.queryByRole('button', { name: /tentar novamente o cadastro/i })).not.toBeInTheDocument()
  })
})

const pendingSaleKey = 'erp.pendingSaleOperation.v1'
const validSaleBody = JSON.stringify({
  items: [{ variantId, quantity: 1 }],
  discountAmount: '0.00', payment: { amount: '150.00', method: 'pix' },
})
function validCart() {
  return [{ id: variantId, type: 'Masculina', size: 'M', sku: 'FLA-M', salePrice: '150.00', stockQuantity: 2, label: 'Flamengo Home', quantity: 1 }]
}
function renderInventoryAfterReload() {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(productsPayload()), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  })))
  renderWithQuery(<NewSalePage />)
}

describe('bloco 2: registro de recuperacao invalido nunca restaura', () => {
  it.each([
    ['json invalido', '{nao-json'],
    ['cart nulo', JSON.stringify({ key: 'k', body: validSaleBody, cart: null, csrf: '' })],
    ['item null', JSON.stringify({ key: 'k', body: validSaleBody, cart: [null], csrf: '' })],
    ['preco invalido', JSON.stringify({ key: 'k', body: validSaleBody, cart: [{ ...validCart()[0], salePrice: 'abc' }], csrf: '' })],
    ['quantidade invalida', JSON.stringify({ key: 'k', body: validSaleBody, cart: [{ ...validCart()[0], quantity: 0 }], csrf: '' })],
    ['payload divergente', JSON.stringify({ key: 'k', body: JSON.stringify({ items: [{ variantId, quantity: 2 }], discountAmount: '0.00', payment: { amount: '300.00', method: 'pix' } }), cart: validCart(), csrf: '' })],
  ])('descarta %s sem crash e sem restaurar', async (_label, raw) => {
    sessionStorage.setItem(pendingSaleKey, raw)
    renderInventoryAfterReload()
    const add = await screen.findByRole('button', { name: 'Adicionar Flamengo Home, tamanho M' })
    expect(add).toBeEnabled()
    expect(screen.queryByRole('button', { name: /tentar novamente/i })).not.toBeInTheDocument()
    expect(screen.getByText('Adicione um produto para começar.')).toBeVisible()
    expect(sessionStorage.getItem(pendingSaleKey)).toBeNull()
  })

  it('preserva operacao incerta valida e permite retry com a mesma chave', async () => {
    sessionStorage.setItem(pendingSaleKey, JSON.stringify({ key: 'k-valida', body: validSaleBody, cart: validCart(), csrf: '' }))
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(productsPayload()), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'sale-1', status: 'paid', finalAmount: '150.00' }), {
        status: 201, headers: { 'Content-Type': 'application/json' },
      }))
    vi.stubGlobal('fetch', fetchMock)
    renderWithQuery(<NewSalePage />)
    fireEvent.click(await screen.findByRole('button', { name: /tentar novamente/i }))
    await screen.findByText('Venda concluída')
    const saleCalls = fetchMock.mock.calls.filter(([url, init]) => String(url).endsWith('/api/sales') && (init as RequestInit)?.method === 'POST')
    expect(saleCalls).toHaveLength(1)
    expect(new Headers((saleCalls[0]?.[1] as RequestInit)?.headers).get('Idempotency-Key')).toBe('k-valida')
    expect((saleCalls[0]?.[1] as RequestInit)?.body).toBe(validSaleBody)
    expect(sessionStorage.getItem(pendingSaleKey)).toBeNull()
  })
})

describe('bloco 1 revisao: resultado incerto nunca apaga a operacao', () => {
  it('201 malformada preserva chave/payload e retry apos recarga usa a mesma chave', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(productsPayload()), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response('truncated JSON', {
        status: 201, headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify(productsPayload()), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'sale-7', status: 'paid', finalAmount: '150.00' }), {
        status: 201, headers: { 'Content-Type': 'application/json' },
      }))
    vi.stubGlobal('fetch', fetchMock)

    const first = renderWithQuery(<NewSalePage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Adicionar Flamengo Home, tamanho M' }))
    fireEvent.click(screen.getByRole('button', { name: 'Finalizar venda' }))

    expect(await screen.findByRole('button', { name: /tentar novamente/i })).toBeVisible()
    expect(screen.queryByText('Venda concluída')).not.toBeInTheDocument()
    const firstCall = fetchMock.mock.calls.find(([url, init]) => String(url).endsWith('/api/sales') && (init as RequestInit)?.method === 'POST')
    const firstKey = new Headers((firstCall?.[1] as RequestInit)?.headers).get('Idempotency-Key')
    const firstBody = (firstCall?.[1] as RequestInit)?.body
    expect(firstKey).toBeTruthy()
    expect(sessionStorage.getItem('erp.pendingSaleOperation.v1')).not.toBeNull()
    first.unmount()

    renderWithQuery(<NewSalePage />)
    expect(await screen.findByRole('button', { name: /tentar novamente/i })).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: /tentar novamente/i }))
    await screen.findByText('Venda concluída')

    const saleCalls = fetchMock.mock.calls.filter(([url, init]) => String(url).endsWith('/api/sales') && (init as RequestInit)?.method === 'POST')
    expect(saleCalls).toHaveLength(2)
    for (const [, init] of saleCalls) {
      expect(new Headers((init as RequestInit)?.headers).get('Idempotency-Key')).toBe(firstKey)
      expect((init as RequestInit)?.body).toBe(firstBody)
    }
    expect(sessionStorage.getItem('erp.pendingSaleOperation.v1')).toBeNull()
  })

  it('recusa o envio quando a recuperacao nao pode ser persistida', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(productsPayload()), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Quota exceeded', 'QuotaExceededError')
    })
    try {
      renderWithQuery(<NewSalePage />)
      fireEvent.click(await screen.findByRole('button', { name: 'Adicionar Flamengo Home, tamanho M' }))
      fireEvent.click(screen.getByRole('button', { name: 'Finalizar venda' }))

      expect(await screen.findByText(/não foi possível garantir a recuperação/i)).toBeVisible()
      expect(fetchMock.mock.calls.filter(([url, init]) => String(url).endsWith('/api/sales') && (init as RequestInit)?.method === 'POST')).toHaveLength(0)
      expect(screen.getAllByText(/FLA-M/)).not.toHaveLength(0)
    } finally {
      setItem.mockRestore()
    }
  })
})
