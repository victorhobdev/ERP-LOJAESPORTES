import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CatalogPage } from './OperationalPages.js'

const productA = '33333333-3333-4333-8333-333333333333'
const productB = '44444444-4444-4344-8344-444444444444'

afterEach(() => {
  vi.unstubAllGlobals()
  window.history.replaceState(null, '', '/catalogo')
})

function renderWithQuery(ui: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
}

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } })
}

function catalogItem(id: string, club: string, model: string, hasImage: boolean, mediaId: string | null = null) {
  return {
    id, club, model, totalStock: 2, hasImage, mediaId,
    variants: [{
      id: '11111111-1111-4111-8111-111111111111', type: 'Masculina', size: 'M', sku: `${club.slice(0, 3).toUpperCase()}-M`,
      salePrice: '150.00', stockQuantity: 2,
    }],
  }
}

function catalogPayload() {
  return {
    items: [
      catalogItem(productA, 'Flamengo', 'Home', true),
      catalogItem(productB, 'Brasil', 'Away', false),
    ],
    total: 2, page: 1, limit: 50,
  }
}

let sessionPermissions: string[] = ['inventory:read']

const sessionPayload = {
  user: { displayName: 'Gestor Catalogo', username: 'gestor.catalogo', role: 'manager' },
  permissions: sessionPermissions,
}

function stubFetch(handler: (url: string) => { payload: unknown; status?: number }) {
  const fetchMock = vi.fn().mockImplementation((input: string | URL | Request) => {
    const url = String(input)
    if (url.includes('/auth/session')) {
      return Promise.resolve(jsonResponse({ user: sessionPayload.user, permissions: sessionPermissions }))
    }
    const { payload, status } = handler(url)
    return Promise.resolve(jsonResponse(payload, status))
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('catalogo read-only', () => {
  it('le filtros da URL e reaplica mantendo o foco na busca', async () => {
    window.history.replaceState(null, '', '/catalogo?club=Fla&image=without&availability=all')
    const fetchMock = stubFetch(() => ({ payload: catalogPayload() }))
    renderWithQuery(<CatalogPage />)
    await screen.findByText('Flamengo')
    const urls = fetchMock.mock.calls.map(([url]) => String(url))
    expect(urls.some((url) => url.includes('club=Fla') && url.includes('image=without') && url.includes('availability=in_stock'))).toBe(true)
    await waitFor(() => expect(window.location.search).not.toContain('availability='))
    const search = screen.getByLabelText('Busca')
    fireEvent.change(search, { target: { value: 'Flamengo' } })
    fireEvent.click(screen.getByRole('button', { name: 'Aplicar filtros' }))
    await waitFor(() => expect(window.location.search).toContain('search=Flamengo'))
    await waitFor(() => {
      expect(fetchMock.mock.calls.map(([url]) => String(url)).some((url) => url.includes('search=Flamengo'))).toBe(true)
    })
    expect(document.activeElement).toBe(search)
  })

  it('pagina resultados com total e limite do envelope preservando filtros', async () => {
    window.history.replaceState(null, '', '/catalogo?club=Fla')
    const fetchMock = stubFetch((url) => {
      const page = new URL(url, 'http://localhost').searchParams.get('page') ?? '1'
      return {
        payload: {
          items: page === '1' ? [catalogItem(productA, 'Flamengo', 'Home', true)] : [catalogItem(productB, 'Brasil', 'Away', false)],
          total: 2, page: Number(page), limit: 1,
        },
      }
    })
    renderWithQuery(<CatalogPage />)
    expect(await screen.findByText('Página 1 de 2 · 2 registro(s)')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Anterior' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Próxima' }))
    await waitFor(() => expect(window.location.search).toContain('page=2'))
    await waitFor(() => expect(window.location.search).toContain('club=Fla'))
    await waitFor(() => {
      const urls = fetchMock.mock.calls.map(([url]) => String(url))
      expect(urls.some((url) => url.includes('page=2') && url.includes('club=Fla') && url.includes('limit=50') && url.includes('availability=in_stock'))).toBe(true)
    })
    expect(await screen.findByText('Página 2 de 2 · 2 registro(s)')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Próxima' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Anterior' })).toBeEnabled()
  })

  it('expoe navegacao de volta em pagina vazia fora do alcance', async () => {
    window.history.replaceState(null, '', '/catalogo?page=5000')
    const fetchMock = stubFetch((url) => {
      const page = Number(new URL(url, 'http://localhost').searchParams.get('page') ?? '1')
      return { payload: { items: [], total: 2, page, limit: 50 } }
    })
    renderWithQuery(<CatalogPage />)
    expect(await screen.findByText('Nenhum produto nesta página.')).toBeVisible()
    expect(screen.getByText('Página 5000 de 1 · 2 registro(s)')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Anterior' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Próxima' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Voltar para página válida' }))
    await waitFor(() => expect(window.location.search).not.toContain('page='))
    await waitFor(() => {
      expect(fetchMock.mock.calls.map(([url]) => String(url)).some((url) => url.includes('page=1'))).toBe(true)
    })
  })

  it('navega a partir da pagina autoritativa do envelope', async () => {
    window.history.replaceState(null, '', '/catalogo?page=5000')
    stubFetch(() => ({ payload: { items: [], total: 250, page: 3, limit: 50 } }))
    renderWithQuery(<CatalogPage />)
    expect(await screen.findByText('Página 3 de 5 · 250 registro(s)')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Anterior' }))
    await waitFor(() => expect(window.location.search).toContain('page=2'))
  })

  it('anterior em pagina fora do alcance cai direto na ultima valida', async () => {
    window.history.replaceState(null, '', '/catalogo?page=5000')
    stubFetch((url) => {
      const page = Number(new URL(url, 'http://localhost').searchParams.get('page') ?? '1')
      return { payload: { items: [], total: 2, page, limit: 50 } }
    })
    renderWithQuery(<CatalogPage />)
    expect(await screen.findByText('Página 5000 de 1 · 2 registro(s)')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Anterior' }))
    await waitFor(() => expect(window.location.search).not.toContain('page='))
  })

  it.each([
    ['page=abc', '/catalogo?page=abc'],
    ['page=1 explícito', '/catalogo?page=1'],
    ['inteiro inseguro', '/catalogo?page=99999999999999999999999'],
  ])('canonicaliza URL com %s preservando filtros', async (_label, start) => {
    window.history.replaceState(null, '', `${start}&club=Fla`)
    const fetchMock = stubFetch(() => ({ payload: catalogPayload() }))
    renderWithQuery(<CatalogPage />)
    await screen.findByText('Flamengo')
    await waitFor(() => expect(window.location.search).not.toContain('page='))
    expect(window.location.search).toContain('club=Fla')
    expect(fetchMock.mock.calls.map(([url]) => String(url)).some((url) => url.includes('page=1'))).toBe(true)
  })

  it('normaliza pagina invalida da URL para 1', async () => {
    window.history.replaceState(null, '', '/catalogo?page=abc')
    const fetchMock = stubFetch(() => ({ payload: catalogPayload() }))
    renderWithQuery(<CatalogPage />)
    await screen.findByText('Flamengo')
    expect(fetchMock.mock.calls.map(([url]) => String(url)).some((url) => url.includes('page=1'))).toBe(true)
  })

  it('prioriza modelo e saldo no card, sem texto de pendencia, com link ao estoque', async () => {
    window.history.replaceState(null, '', '/catalogo')
    stubFetch(() => ({ payload: catalogPayload() }))
    renderWithQuery(<CatalogPage />)
    expect(await screen.findByText('Flamengo')).toBeVisible()
    expect(screen.getByRole('img', { name: 'Com imagem: Flamengo Home' })).toBeVisible()
    expect(screen.getByRole('img', { name: 'Sem imagem: Brasil Away' })).toBeVisible()
    expect(screen.getAllByText('Sem imagem')).toHaveLength(2)
    expect(screen.queryByText(/pendente/)).not.toBeInTheDocument()
    expect(screen.getAllByText('2 unid. em estoque · 1 tam.')).toHaveLength(2)
    const detailLinks = screen.getAllByRole('link', { name: 'Abrir estoque' })
    expect(detailLinks[0]).toHaveAttribute('href', `/estoque/produtos/${productA}`)
    expect(screen.queryByText(/Fundação em construção/)).not.toBeInTheDocument()
  })

  it('mostra vazio por filtro com limpeza e vazio inicial', async () => {
    window.history.replaceState(null, '', '/catalogo?search=zzz')
    stubFetch(() => ({ payload: { items: [], total: 0, page: 1, limit: 50 } }))
    const { unmount } = renderWithQuery(<CatalogPage />)
    expect(await screen.findByText(/Nenhum produto para estes filtros/)).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Limpar filtros' }))
    expect(window.location.search).toBe('')
    unmount()
    window.history.replaceState(null, '', '/catalogo')
    stubFetch(() => ({ payload: { items: [], total: 0, page: 1, limit: 50 } }))
    renderWithQuery(<CatalogPage />)
    expect(await screen.findByText('Nenhum produto com estoque disponível.')).toBeVisible()
  })

  it('mostra erro controlado com retry', async () => {
    window.history.replaceState(null, '', '/catalogo')
    let productAttempts = 0
    const fetchMock = vi.fn().mockImplementation((input: string | URL | Request) => {
      const url = String(input)
      if (url.includes('/auth/session')) {
        return Promise.resolve(jsonResponse({ user: sessionPayload.user, permissions: sessionPermissions }))
      }
      if (url.includes('/catalog')) {
        productAttempts += 1
        if (productAttempts === 1) {
          return Promise.resolve(new Response(JSON.stringify({ code: 'X', message: 'boom' }), { status: 500 }))
        }
        return Promise.resolve(jsonResponse(catalogPayload()))
      }
      return Promise.resolve(jsonResponse(catalogPayload()))
    })
    vi.stubGlobal('fetch', fetchMock)
    renderWithQuery(<CatalogPage />)
    expect(await screen.findByRole('alert')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Tentar novamente' }))
    expect(await screen.findByText('Flamengo')).toBeVisible()
  })
})

function headerMap(init?: RequestInit): Record<string, string> {
  return Object.fromEntries(new Headers(init?.headers).entries())
}

const mediaIdA = '55555555-5555-4555-8555-555555555555'
const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

describe('catalogo com midia e sincronizacao', () => {
  beforeEach(() => {
    document.cookie = 'erp_csrf=csrf-test'
  })

  afterEach(() => {
    document.cookie = 'erp_csrf=; Max-Age=0'
  })

  it('operador sem catalog:write nao ve controles de upload nem sincronizacao', async () => {
    window.history.replaceState(null, '', '/catalogo')
    stubFetch(() => ({ payload: catalogPayload() }))
    renderWithQuery(<CatalogPage />)
    expect(await screen.findByText('Flamengo')).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Sincronizar catálogo' })).toBeNull()
    expect(screen.queryByLabelText(/Enviar imagem de/)).toBeNull()
  })

  it('gestor revisa a prévia e acompanha o progresso real da publicação', async () => {
    window.history.replaceState(null, '', '/catalogo')
    sessionPermissions = ['inventory:read', 'catalog:write']
    let jobPolls = 0
    const fetchMock = vi.fn().mockImplementation((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/auth/session')) {
        return Promise.resolve(jsonResponse({ user: sessionPayload.user, permissions: sessionPermissions }))
      }
      if (url.includes('/catalog/publish/preview')) {
        return Promise.resolve(jsonResponse({ items: [
          { productName: 'FLAMENGO I 2026 Masculina', club: 'FLAMENGO', model: 'I 2026', type: 'Masculina', sizes: 'M, G', status: 'OK', hasLocalImage: true },
          { productName: 'REAL MADRID PLAYER Masculina', club: 'REAL MADRID', model: 'PLAYER', type: 'Masculina', sizes: '2GG', status: 'DESATUALIZADO', hasLocalImage: true },
        ] }))
      }
      if (url.endsWith('/catalog/publish/jobs') && init?.method === 'POST') {
        return Promise.resolve(jsonResponse({ jobId: 'job-1', status: 'running', current: 0, total: 1, message: 'Preparando…' }, 202))
      }
      if (url.includes('/catalog/publish/jobs/job-1')) {
        jobPolls += 1
        if (jobPolls === 1) return Promise.resolve(jsonResponse({ jobId: 'job-1', status: 'running', current: 1, total: 2, message: 'Processando REAL MADRID PLAYER' }))
        return Promise.resolve(jsonResponse({
          jobId: 'job-1', status: 'completed', current: 2, total: 2, message: 'Concluído',
          result: { status: 'completed', created: 0, updated: 1, removed: 0, pendingWithoutImage: 0, errors: [] },
        }))
      }
      return Promise.resolve(jsonResponse(catalogPayload()))
    })
    vi.stubGlobal('fetch', fetchMock)
    renderWithQuery(<CatalogPage />)

    expect(await screen.findByText('REAL MADRID PLAYER Masculina')).toBeVisible()
    expect(screen.getByText('Desatualizado')).toBeVisible()
    expect(screen.getByText('1 pendente')).toBeVisible()

    const syncButton = await screen.findByRole('button', { name: 'Sincronizar catálogo' })
    fireEvent.click(syncButton)

    const progress = await screen.findByRole('progressbar')
    expect(progress).toHaveAttribute('aria-valuenow', '1')
    expect(screen.getByText('Processando REAL MADRID PLAYER')).toBeVisible()
    expect(await screen.findByText(/Sincronização concluída/)).toBeVisible()
    expect(screen.getByText(/0 criado · 1 atualizados · 0 removidos/)).toBeVisible()
    sessionPermissions = ['inventory:read']
  })

  it('sincronizacao parcial lista erros e falha ao iniciar oferece retry', async () => {
    window.history.replaceState(null, '', '/catalogo')
    sessionPermissions = ['inventory:read', 'catalog:write']
    const fetchMock = stubFetch(() => ({ payload: catalogPayload() }))
    let starts = 0
    fetchMock.mockImplementation((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/auth/session')) {
        return Promise.resolve(jsonResponse({ user: sessionPayload.user, permissions: sessionPermissions }))
      }
      if (url.includes('/catalog/publish/preview')) return Promise.resolve(jsonResponse({ items: [] }))
      if (url.endsWith('/catalog/publish/jobs') && init?.method === 'POST') {
        starts += 1
        if (starts === 1) return Promise.resolve(new Response(JSON.stringify({ code: 'X', message: 'boom' }), { status: 500 }))
        return Promise.resolve(jsonResponse({ jobId: 'job-partial', status: 'running', current: 0, total: 1, message: 'Preparando…' }, 202))
      }
      if (url.includes('/catalog/publish/jobs/job-partial')) return Promise.resolve(jsonResponse({
        jobId: 'job-partial', status: 'completed', current: 1, total: 1, message: 'Concluído',
        result: { status: 'partial', created: 0, updated: 1, removed: 0, pendingWithoutImage: 0, errors: ['X__Y: PRODUCT_NOT_FOUND'] },
      }))
      return Promise.resolve(jsonResponse(catalogPayload()))
    })
    renderWithQuery(<CatalogPage />)
    const syncButton = await screen.findByRole('button', { name: 'Sincronizar catálogo' })
    await waitFor(() => expect(syncButton).toBeEnabled())
    fireEvent.click(syncButton)
    expect(await screen.findByRole('alert')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Tentar novamente' }))
    expect(await screen.findByText(/Sincronização parcial/)).toBeVisible()
    expect(screen.getByText(/X__Y/)).toBeVisible()
    expect(starts).toBe(2)
    sessionPermissions = ['inventory:read']
  })

  it('publicacao nao configurada exibe o erro retornado pela API', async () => {
    window.history.replaceState(null, '', '/catalogo')
    sessionPermissions = ['inventory:read', 'catalog:write']
    const fetchMock = stubFetch(() => ({ payload: catalogPayload() }))
    fetchMock.mockImplementation((input: string | URL | Request) => {
      const url = String(input)
      if (url.includes('/auth/session')) return Promise.resolve(jsonResponse({ user: sessionPayload.user, permissions: sessionPermissions }))
      if (url.includes('/catalog/publish/preview')) return Promise.resolve(jsonResponse({
        code: 'CATALOG_PUBLISH_NOT_CONFIGURED', message: 'Publicação no Google Drive não configurada.',
      }, 503))
      return Promise.resolve(jsonResponse(catalogPayload()))
    })
    renderWithQuery(<CatalogPage />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Publicação no Google Drive não configurada.')
    sessionPermissions = ['inventory:read']
  })

  it('gestor envia imagem e o cartao passa a exibir a imagem real', async () => {
    window.history.replaceState(null, '', '/catalogo')
    sessionPermissions = ['inventory:read', 'catalog:write']
    let withImage = false
    const fetchMock = stubFetch(() => ({
      payload: {
        items: [catalogItem(productA, 'Flamengo', 'Home', withImage, withImage ? mediaIdA : null), catalogItem(productB, 'Brasil', 'Away', false)],
        total: 2, page: 1, limit: 50,
      },
    }))
    renderWithQuery(<CatalogPage />)
    const input = await screen.findByLabelText('Enviar imagem de Flamengo Home')
    fetchMock.mockImplementationOnce((input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toContain(`/api/catalog/images?productId=${productA}`)
      const headers = headerMap(init)
      expect(headers['x-csrf-token']).toBeTruthy()
      expect(headers['content-type']).toBeUndefined()
      expect(init?.body).toBeInstanceOf(FormData)
      withImage = true
      return Promise.resolve(jsonResponse({ id: mediaIdA, productId: productA, url: `/catalog/media/${mediaIdA}`, originalName: 'escudo.png', mimeType: 'image/png', byteSize: pngBytes.length, deduplicated: false }, 201))
    })
    fireEvent.change(input, { target: { files: [new File([pngBytes], 'escudo.png', { type: 'image/png' })] } })
    const image = await screen.findByRole('img', { name: 'Imagem: Flamengo Home' })
    expect(image).toHaveAttribute('src', `/api/catalog/media/${mediaIdA}`)
    sessionPermissions = ['inventory:read']
  })

  it('falha de upload mantem o arquivo escolhido e o retry reenvia o mesmo arquivo', async () => {
    window.history.replaceState(null, '', '/catalogo')
    sessionPermissions = ['inventory:read', 'catalog:write']
    let attempts = 0
    let withImage = false
    const fetchMock = stubFetch(() => ({
      payload: {
        items: [catalogItem(productA, 'Flamengo', 'Home', withImage, withImage ? mediaIdA : null), catalogItem(productB, 'Brasil', 'Away', false)],
        total: 2, page: 1, limit: 50,
      },
    }))
    renderWithQuery(<CatalogPage />)
    const input = await screen.findByLabelText('Enviar imagem de Flamengo Home')
    fetchMock.mockImplementation((input: string | URL | Request) => {
      const url = String(input)
      if (url.includes('/auth/session')) {
        return Promise.resolve(jsonResponse({ user: sessionPayload.user, permissions: sessionPermissions }))
      }
      if (url.includes('/catalog/images')) {
        attempts += 1
        if (attempts === 1) return Promise.resolve(new Response(JSON.stringify({ code: 'IMAGE_TOO_LARGE', message: 'grande' }), { status: 413 }))
        withImage = true
        return Promise.resolve(jsonResponse({ id: mediaIdA, productId: productA, url: `/catalog/media/${mediaIdA}`, originalName: 'escudo.png', mimeType: 'image/png', byteSize: 8, deduplicated: false }, 201))
      }
      return Promise.resolve(jsonResponse({
        items: [catalogItem(productA, 'Flamengo', 'Home', withImage, withImage ? mediaIdA : null), catalogItem(productB, 'Brasil', 'Away', false)],
        total: 2, page: 1, limit: 50,
      }))
    })
    const file = new File([pngBytes], 'escudo.png', { type: 'image/png' })
    fireEvent.change(input, { target: { files: [file] } })
    expect(await screen.findByRole('alert')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Tentar novamente' }))
    expect(await screen.findByRole('img', { name: 'Imagem: Flamengo Home' })).toBeVisible()
    expect(attempts).toBe(2)
    sessionPermissions = ['inventory:read']
  })

  it('erro ao carregar imagem cai no placeholder recuperavel com retry', async () => {
    window.history.replaceState(null, '', '/catalogo')
    stubFetch(() => ({ payload: { items: [catalogItem(productA, 'Flamengo', 'Home', true, mediaIdA)], total: 1, page: 1, limit: 50 } }))
    renderWithQuery(<CatalogPage />)
    const image = await screen.findByRole('img', { name: 'Imagem: Flamengo Home' })
    fireEvent.error(image)
    expect(await screen.findByText('Falha ao carregar a imagem.')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Recarregar imagem' }))
    expect(await screen.findByRole('img', { name: 'Imagem: Flamengo Home' })).toBeVisible()
  })
})
