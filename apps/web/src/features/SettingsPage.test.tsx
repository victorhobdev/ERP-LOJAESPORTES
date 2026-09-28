import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { SettingsPage } from './OperationalPages.js'

afterEach(() => vi.unstubAllGlobals())

function renderWithQuery(ui: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
}

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } })
}

function sessionPayload(permissions: string[]) {
  return {
    user: { displayName: 'Caixa Sintético', username: 'caixa.sintetico', role: 'operator' },
    permissions,
  }
}

function directoryPayload() {
  return {
    items: [
      {
        id: '11111111-1111-4111-8111-111111111111', username: 'admin.sintetica',
        displayName: 'Administradora Sintética', role: 'administrator', active: true, createdAt: '2026-08-01T10:00:00.000Z',
      },
      {
        id: '22222222-2222-4222-8222-222222222222', username: 'caixa.sintetico',
        displayName: 'Caixa Sintético', role: 'operator', active: false, createdAt: '2026-08-02T10:00:00.000Z',
      },
    ],
    total: 2, page: 1, limit: 20,
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

describe('configuracoes e diretorio de usuarios', () => {
  it('mostra perfil, papel e permissoes sem buscar usuarios para operador', async () => {
    const fetchMock = stubFetch((url) => {
      if (url.endsWith('/api/auth/session')) return { payload: sessionPayload(['sales:read', 'inventory:read']) }
      throw new Error(`request inesperado: ${url}`)
    })
    renderWithQuery(<SettingsPage />)
    expect(await screen.findByText('Caixa Sintético')).toBeVisible()
    expect(screen.getByText('Usuário: caixa.sintetico')).toBeVisible()
    expect(screen.getByText('Perfil: Operador')).toBeVisible()
    expect(screen.getByText('2 permissões efetivas')).toBeVisible()
    fireEvent.click(screen.getByText('Permissões efetivas'))
    expect(screen.getByText('sales:read')).toBeVisible()
    expect(screen.getByText(/restrita a administradores/)).toBeVisible()
    expect(fetchMock.mock.calls.map(([url]) => String(url)).some((url) => url.includes('/api/users'))).toBe(false)
  })

  it('renderiza diretorio, busca e paginacao para administrador', async () => {
    const fetchMock = stubFetch((url) => {
      if (url.endsWith('/api/auth/session')) {
        return { payload: { user: { displayName: 'Chef', username: 'chef', role: 'administrator' }, permissions: ['*'] } }
      }
      if (url.includes('/api/users')) {
        const params = new URL(url, 'http://localhost').searchParams
        const search = params.get('search') ?? ''
        const page = params.get('page') ?? '1'
        const items = page === '2'
          ? [directoryPayload().items[1]]
          : directoryPayload().items.filter((item) => item.displayName.includes(search))
        return { payload: { items, total: 21, page: Number(page), limit: 20 } }
      }
      throw new Error(`request inesperado: ${url}`)
    })
    renderWithQuery(<SettingsPage />)
    expect(await screen.findByText('Usuários (21)')).toBeVisible()
    expect(screen.getByText('Administradora Sintética')).toBeVisible()
    expect(screen.getByText('Inativo')).toBeVisible()
    expect(screen.getByText('Página 1 de 2 · 21 registro(s)')).toBeVisible()
    fireEvent.change(screen.getByLabelText('Busca'), { target: { value: 'Caixa' } })
    fireEvent.click(screen.getByRole('button', { name: 'Buscar' }))
    await waitFor(() => {
      expect(fetchMock.mock.calls.map(([url]) => String(url)).some((url) => url.includes('search=Caixa'))).toBe(true)
    })
  })

  it('avanca para a segunda pagina do diretorio atualizando resumo e itens', async () => {
    const fetchMock = stubFetch((url) => {
      if (url.endsWith('/api/auth/session')) {
        return { payload: { user: { displayName: 'Chef', username: 'chef', role: 'administrator' }, permissions: ['*'] } }
      }
      if (url.includes('/api/users')) {
        const page = new URL(url, 'http://localhost').searchParams.get('page') ?? '1'
        const items = page === '2' ? [directoryPayload().items[1]] : [directoryPayload().items[0]]
        return { payload: { items, total: 21, page: Number(page), limit: 20 } }
      }
      throw new Error(`request inesperado: ${url}`)
    })
    renderWithQuery(<SettingsPage />)
    expect(await screen.findByText('Administradora Sintética')).toBeVisible()
    expect(screen.queryByText('Caixa Sintético')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Próxima' }))
    await waitFor(() => {
      expect(fetchMock.mock.calls.map(([url]) => String(url)).some((url) => url.includes('page=2'))).toBe(true)
    })
    expect(await screen.findByText('Página 2 de 2 · 21 registro(s)')).toBeVisible()
    expect(screen.getByText('Caixa Sintético')).toBeVisible()
    expect(screen.queryByText('Administradora Sintética')).not.toBeInTheDocument()
  })

  it('sessao 401 exibe sessao expirada sem buscar usuarios nem status', async () => {
    const fetchMock = stubFetch((url) => {
      if (url.endsWith('/api/auth/session')) {
        return { payload: { code: 'UNAUTHENTICATED', message: 'Sessão inválida ou expirada.' }, status: 401 }
      }
      throw new Error(`request inesperado: ${url}`)
    })
    renderWithQuery(<SettingsPage />)
    expect(await screen.findByText(/sessão expirada/i)).toBeVisible()
    expect(screen.getByRole('link', { name: /entrar/i })).toHaveAttribute('href', '/login')
    const urls = fetchMock.mock.calls.map(([url]) => String(url))
    expect(urls.some((url) => url.includes('/api/users'))).toBe(false)
    expect(urls.some((url) => url.includes('/api/health/ready'))).toBe(false)
  })

  it('exibe status operacional com atualizacao manual e sem polling', async () => {
    const fetchMock = stubFetch((url) => {
      if (url.endsWith('/api/auth/session')) return { payload: sessionPayload(['sales:read']) }
      if (url.endsWith('/api/health/ready')) {
        return {
          payload: {
            status: 'ready', service: 'erp-api', version: '0.0.0',
            checks: { database: 'up' }, integrations: { catalog: 'not_configured' },
          },
        }
      }
      throw new Error(`request inesperado: ${url}`)
    })
    renderWithQuery(<SettingsPage />)
    expect(await screen.findByText('Status operacional')).toBeVisible()
    expect(await screen.findByText('Versão: 0.0.0')).toBeVisible()
    expect(screen.getByText('API: pronta')).toBeVisible()
    expect(screen.getByText('Banco de dados: em operação')).toBeVisible()
    expect(screen.getByText('Catálogo externo: não configurado')).toBeVisible()
    const healthCalls = () => fetchMock.mock.calls.filter(([url]) => String(url).includes('/api/health/ready')).length
    expect(healthCalls()).toBe(1)
    fireEvent.click(screen.getByRole('button', { name: 'Atualizar status' }))
    await waitFor(() => expect(healthCalls()).toBe(2))
  })

  it('renderiza envelope 503 degradado sem expor detalhes brutos', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
      if (String(url).endsWith('/api/auth/session')) return Promise.resolve(jsonResponse(sessionPayload(['sales:read'])))
      return Promise.resolve(jsonResponse({
        status: 'not_ready', service: 'erp-api', version: '0.0.0',
        checks: { database: 'down' }, integrations: { catalog: 'not_configured' },
        silentExtra: 'postgres://must-never-render',
      }, 503))
    }))
    renderWithQuery(<SettingsPage />)
    expect(await screen.findByText('Serviço degradado.')).toBeVisible()
    expect(screen.getByText('Versão: 0.0.0')).toBeVisible()
    expect(screen.getByText('API: indisponível')).toBeVisible()
    expect(screen.getByText('Banco de dados: indisponível')).toBeVisible()
    expect(screen.getByText('Catálogo externo: não configurado')).toBeVisible()
    expect(screen.queryByText(/must-never-render/)).not.toBeInTheDocument()
    expect(screen.queryByText(/postgres:\/\//)).not.toBeInTheDocument()
  })

  it('mostra erro controlado do status com retry', async () => {
    let calls = 0
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
      calls += 1
      if (String(url).endsWith('/api/auth/session')) return Promise.resolve(jsonResponse(sessionPayload(['sales:read'])))
      if (calls === 2) return Promise.resolve(new Response(JSON.stringify({ code: 'X', message: 'boom' }), { status: 503 }))
      return Promise.resolve(jsonResponse({
        status: 'ready', service: 'erp-api', version: '0.0.0',
        checks: { database: 'up' }, integrations: { catalog: 'not_configured' },
      }))
    }))
    renderWithQuery(<SettingsPage />)
    expect(await screen.findByText('Status operacional')).toBeVisible()
    expect(await screen.findByRole('alert')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Atualizar status' }))
    expect(await screen.findByText('Versão: 0.0.0')).toBeVisible()
  })

  it('cobre loading, erro com retry e diretorio vazio', async () => {
    const admin = { user: { displayName: 'Chef', username: 'chef', role: 'administrator' }, permissions: ['*'] }
    const readiness = {
      status: 'ready', service: 'erp-api', version: '0.0.0',
      checks: { database: 'up' }, integrations: { catalog: 'not_configured' },
    }
    let usersCalls = 0
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (String(url).endsWith('/api/auth/session')) return Promise.resolve(jsonResponse(admin))
      if (String(url).endsWith('/api/health/ready')) return Promise.resolve(jsonResponse(readiness))
      usersCalls += 1
      if (usersCalls === 1) return Promise.resolve(new Response(JSON.stringify({ code: 'X', message: 'boom' }), { status: 500 }))
      return Promise.resolve(jsonResponse({ items: [], total: 0, page: 1, limit: 20 }))
    })
    vi.stubGlobal('fetch', fetchMock)
    renderWithQuery(<SettingsPage />)
    expect(await screen.findByRole('alert')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Tentar novamente' }))
    expect(await screen.findByText('Nenhum usuário encontrado.')).toBeVisible()
  })
})

function adminStubs(onWrite: (url: string, init: RequestInit) => { payload: unknown; status?: number } | undefined) {
  const readiness = {
    status: 'ready', service: 'erp-api', version: '0.0.0',
    checks: { database: 'up' }, integrations: { catalog: 'not_configured' },
  }
  const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    if (String(url).endsWith('/api/auth/session')) {
      return Promise.resolve(jsonResponse({
        user: { displayName: 'Chef', username: 'chef', role: 'administrator' }, permissions: ['*'],
      }))
    }
    if (String(url).endsWith('/api/health/ready')) return Promise.resolve(jsonResponse(readiness))
    if (String(url).includes('/api/users') && (init?.method === undefined || init.method === 'GET')) {
      return Promise.resolve(jsonResponse(directoryPayload()))
    }
    const override = onWrite(String(url), (init ?? {}) as RequestInit)
    if (override) {
      const { payload, status } = override
      return Promise.resolve(jsonResponse(payload, status))
    }
    throw new Error(`request inesperado: ${String(url)} ${(init?.method ?? 'GET')}`)
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function fillCreateForm(values: { username: string; displayName: string; role: string; password: string }) {
  fireEvent.change(screen.getByLabelText('Nome de usuário'), { target: { value: values.username } })
  fireEvent.change(screen.getByLabelText('Nome de exibição'), { target: { value: values.displayName } })
  fireEvent.change(screen.getByLabelText('Perfil'), { target: { value: values.role } })
  fireEvent.change(screen.getByLabelText('Senha'), { target: { value: values.password } })
}

describe('formularios administrativos de usuarios', () => {
  it('exibe formularios somente para admin e nunca faz POST como operador', async () => {
    const fetchMock = stubFetch((url) => {
      if (url.endsWith('/api/auth/session')) return { payload: sessionPayload(['sales:read', 'inventory:read']) }
      if (url.endsWith('/api/health/ready')) {
        return {
          payload: {
            status: 'ready', service: 'erp-api', version: '0.0.0',
            checks: { database: 'up' }, integrations: { catalog: 'not_configured' },
          },
        }
      }
      throw new Error(`request inesperado: ${url}`)
    })
    renderWithQuery(<SettingsPage />)
    expect(await screen.findByText(/restrita a administradores/)).toBeVisible()
    expect(screen.queryByText('Novo usuário')).not.toBeInTheDocument()
    expect(fetchMock.mock.calls.every(([, init]) => (init as RequestInit | undefined)?.method === undefined)).toBe(true)
  })

  it('cria usuario com payload normalizado, limpa e refaz a lista', async () => {
    const posts: Array<{ url: string; body: unknown }> = []
    const fetchMock = adminStubs((url, init) => {
      if (init.method === 'POST' && url.endsWith('/api/users')) {
        posts.push({ url, body: JSON.parse(String(init.body)) })
        return { payload: { ...directoryPayload().items[0], id: '99999999-9999-4999-8999-999999999999' }, status: 201 }
      }
      return undefined
    })
    renderWithQuery(<SettingsPage />)
    expect(await screen.findByText('Novo usuário')).toBeVisible()
    fillCreateForm({ username: '  Novo.User ', displayName: 'Novo Usuário', role: 'operator', password: 'Senha-Sintetica-12' })
    fireEvent.click(screen.getByRole('button', { name: 'Cadastrar usuário' }))
    await waitFor(() => expect(posts).toHaveLength(1))
    expect(posts[0]!.body).toEqual({ username: 'novo.user', displayName: 'Novo Usuário', role: 'operator', password: 'Senha-Sintetica-12' })
    expect(await screen.findByText('Usuário criado.')).toBeVisible()
    expect((screen.getByLabelText('Nome de usuário') as HTMLInputElement).value).toBe('')
    await waitFor(() => {
      expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/api/users') && String(url).includes('page=1')).length).toBeGreaterThan(1)
    })
  })

  it('valida localmente sem POST', async () => {
    const fetchMock = adminStubs(() => undefined)
    renderWithQuery(<SettingsPage />)
    expect(await screen.findByText('Novo usuário')).toBeVisible()
    fillCreateForm({ username: 'curto.user', displayName: 'Curto', role: 'operator', password: 'curta' })
    fireEvent.click(screen.getByRole('button', { name: 'Cadastrar usuário' }))
    expect(await screen.findByText(/12 e 256/)).toBeVisible()
    expect(fetchMock.mock.calls.some(([url, init]) => String(url).includes('/api/users') && (init as RequestInit)?.method === 'POST')).toBe(false)
  })

  it('conflito 409 preserva valores e retry conclui', async () => {
    let posts = 0
    adminStubs((url, init) => {
      if (init.method === 'POST' && url.endsWith('/api/users')) {
        posts += 1
        if (posts === 1) return { payload: { code: 'USERNAME_TAKEN', message: 'Nome de usuário já cadastrado.' }, status: 409 }
        return { payload: { ...directoryPayload().items[0], username: 'novo.user' }, status: 201 }
      }
      return undefined
    })
    renderWithQuery(<SettingsPage />)
    expect(await screen.findByText('Novo usuário')).toBeVisible()
    fillCreateForm({ username: 'novo.user', displayName: 'Novo Usuário', role: 'operator', password: 'Senha-Sintetica-12' })
    fireEvent.click(screen.getByRole('button', { name: 'Cadastrar usuário' }))
    expect(await screen.findByText('Nome de usuário já cadastrado.')).toBeVisible()
    expect((screen.getByLabelText('Nome de usuário') as HTMLInputElement).value).toBe('novo.user')
    fireEvent.click(screen.getByRole('button', { name: 'Tentar novamente' }))
    expect(await screen.findByText('Usuário criado.')).toBeVisible()
    expect(posts).toBe(2)
  })

  it('gestor nao dispara nenhuma chamada de usuarios', async () => {
    const fetchMock = stubFetch((url) => {
      if (url.endsWith('/api/auth/session')) {
        return {
          payload: {
            user: { displayName: 'Gestora Sintética', username: 'gestora.sintetica', role: 'manager' },
            permissions: ['sales:read', 'reports:read'],
          },
        }
      }
      if (url.endsWith('/api/health/ready')) {
        return {
          payload: {
            status: 'ready', service: 'erp-api', version: '0.0.0',
            checks: { database: 'up' }, integrations: { catalog: 'not_configured' },
          },
        }
      }
      throw new Error(`request inesperado: ${url}`)
    })
    renderWithQuery(<SettingsPage />)
    expect(await screen.findByText(/restrita a administradores/)).toBeVisible()
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/api/users'))).toBe(false)
  })

  it('envia CSRF do helper sem token paralelo', async () => {
    document.cookie = 'erp_csrf=csrf-test'
    try {
      const seen: Array<Record<string, string>> = []
      adminStubs((url, init) => {
        if (init.method === 'POST' && url.endsWith('/api/users')) {
          seen.push(Object.fromEntries(new Headers(init.headers).entries()))
          return { payload: { ...directoryPayload().items[0], id: '99999999-9999-4999-8999-999999999999' }, status: 201 }
        }
        return undefined
      })
      renderWithQuery(<SettingsPage />)
      expect(await screen.findByText('Novo usuário')).toBeVisible()
      fillCreateForm({ username: 'csrf.user', displayName: 'Csrf', role: 'operator', password: 'Senha-Sintetica-12' })
      fireEvent.click(screen.getByRole('button', { name: 'Cadastrar usuário' }))
      await waitFor(() => expect(seen).toHaveLength(1))
      expect(seen[0]!['x-csrf-token']).toBe('csrf-test')
    } finally {
      document.cookie = 'erp_csrf=; Max-Age=0'
    }
  })

  it('edita nome e papel apos 200 e fecha o formulario', async () => {
    const patches: Array<{ url: string; body: unknown }> = []
    const fetchMock = adminStubs((url, init) => {
      if (init.method === 'PATCH' && url.includes('/api/users/')) {
        patches.push({ url, body: JSON.parse(String(init.body)) })
        return { payload: { ...directoryPayload().items[1], displayName: 'Caixa Renomeado', role: 'manager' }, status: 200 }
      }
      return undefined
    })
    renderWithQuery(<SettingsPage />)
    expect(await screen.findByText('Caixa Sintético')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Editar Caixa Sintético' }))
    const form = within(screen.getByRole('region', { name: 'Editar usuário' }))
    fireEvent.change(form.getByLabelText('Nome de exibição'), { target: { value: 'Caixa Renomeado' } })
    fireEvent.change(form.getByLabelText('Perfil'), { target: { value: 'manager' } })
    const getsBefore = fetchMock.mock.calls.filter(([url, init]) => String(url).includes('/api/users?') && (init as RequestInit | undefined)?.method === undefined).length
    fireEvent.click(form.getByRole('button', { name: 'Salvar alterações' }))
    await waitFor(() => expect(patches).toHaveLength(1))
    expect(patches[0]!.body).toEqual({ displayName: 'Caixa Renomeado', role: 'manager' })
    expect(patches[0]!.url).toContain('/api/users/22222222-2222-4222-8222-222222222222')
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Editar usuário' })).not.toBeInTheDocument())
    await waitFor(() => {
      const getsAfter = fetchMock.mock.calls.filter(([url, init]) => String(url).includes('/api/users?') && (init as RequestInit | undefined)?.method === undefined).length
      expect(getsAfter).toBeGreaterThan(getsBefore)
    })
  })

  it('sem mudanca nao faz PATCH', async () => {
    const fetchMock = adminStubs(() => undefined)
    renderWithQuery(<SettingsPage />)
    expect(await screen.findByText('Caixa Sintético')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Editar Caixa Sintético' }))
    const form = within(screen.getByRole('region', { name: 'Editar usuário' }))
    fireEvent.click(form.getByRole('button', { name: 'Salvar alterações' }))
    expect(await screen.findByText(/Nenhuma alteração/)).toBeVisible()
    expect(fetchMock.mock.calls.some(([url, init]) => String(url).includes('/api/users/') && (init as RequestInit)?.method === 'PATCH')).toBe(false)
  })

  it('retry do PATCH preserva o mesmo body mesmo com edicao posterior', async () => {
    const patches: Array<{ url: string; body: unknown }> = []
    adminStubs((url, init) => {
      if (init.method === 'PATCH' && url.includes('/api/users/')) {
        patches.push({ url, body: JSON.parse(String(init.body)) })
        if (patches.length === 1) return { payload: { code: 'X', message: 'boom' }, status: 500 }
        return { payload: { ...directoryPayload().items[1], displayName: 'Caixa Um' }, status: 200 }
      }
      return undefined
    })
    renderWithQuery(<SettingsPage />)
    expect(await screen.findByText('Caixa Sintético')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Editar Caixa Sintético' }))
    const form = within(screen.getByRole('region', { name: 'Editar usuário' }))
    fireEvent.change(form.getByLabelText('Nome de exibição'), { target: { value: 'Caixa Um' } })
    fireEvent.click(form.getByRole('button', { name: 'Salvar alterações' }))
    await waitFor(() => expect(patches).toHaveLength(1))
    expect(patches[0]!.body).toEqual({ displayName: 'Caixa Um' })
    fireEvent.change(form.getByLabelText('Nome de exibição'), { target: { value: 'Caixa Dois' } })
    const getsBefore = await screen.findByText('Caixa Sintético')
    expect(getsBefore).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Tentar novamente' }))
    await waitFor(() => expect(patches).toHaveLength(2))
    expect(patches[1]!.body).toEqual({ displayName: 'Caixa Um' })
  })

  it.each([
    ['SELF_PROTECTION', 409, 'não pode rebaixar ou desativar o próprio usuário'],
    ['LAST_ADMIN', 409, 'último administrador ativo'],
  ] as Array<[string, number, string]>)('PATCH %s mostra mensagem segura', async (code, status, message) => {
    adminStubs((url, init) => {
      if (init.method === 'PATCH' && url.includes('/api/users/')) {
        return { payload: { code, message: 'detalhe bruto que não deve aparecer' }, status }
      }
      return undefined
    })
    renderWithQuery(<SettingsPage />)
    expect(await screen.findByText('Caixa Sintético')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Editar Caixa Sintético' }))
    const form = within(screen.getByRole('region', { name: 'Editar usuário' }))
    fireEvent.change(form.getByLabelText('Nome de exibição'), { target: { value: 'Caixa Novo' } })
    fireEvent.click(form.getByRole('button', { name: 'Salvar alterações' }))
    expect(await screen.findByText(new RegExp(message))).toBeVisible()
    expect(screen.queryByText(/detalhe bruto/)).not.toBeInTheDocument()
  })

  it('PATCH 401 mostra sessao expirada com login', async () => {
    adminStubs((url, init) => {
      if (init.method === 'PATCH' && url.includes('/api/users/')) {
        return { payload: { code: 'UNAUTHENTICATED', message: 'Sessão inválida ou expirada.' }, status: 401 }
      }
      return undefined
    })
    renderWithQuery(<SettingsPage />)
    expect(await screen.findByText('Caixa Sintético')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Editar Caixa Sintético' }))
    const form = within(screen.getByRole('region', { name: 'Editar usuário' }))
    fireEvent.change(form.getByLabelText('Nome de exibição'), { target: { value: 'Caixa Novo' } })
    fireEvent.click(form.getByRole('button', { name: 'Salvar alterações' }))
    expect(await screen.findByText(/sessão expirada/i)).toBeVisible()
    expect(screen.getByRole('link', { name: /entrar/i })).toBeVisible()
  })

  it('sem invalidacao da lista antes do sucesso', async () => {
    const fetchMock = adminStubs((url, init) => {
      if (init.method === 'PATCH' && url.includes('/api/users/')) {
        return { payload: { code: 'X', message: 'boom' }, status: 500 }
      }
      return undefined
    })
    renderWithQuery(<SettingsPage />)
    expect(await screen.findByText('Caixa Sintético')).toBeVisible()
    const getsBefore = fetchMock.mock.calls.filter(([url, init]) => String(url).includes('/api/users?') && (init as RequestInit | undefined)?.method === undefined).length
    fireEvent.click(screen.getByRole('button', { name: 'Editar Caixa Sintético' }))
    const form = within(screen.getByRole('region', { name: 'Editar usuário' }))
    fireEvent.change(form.getByLabelText('Nome de exibição'), { target: { value: 'Caixa Novo' } })
    fireEvent.click(form.getByRole('button', { name: 'Salvar alterações' }))
    await screen.findByRole('button', { name: 'Tentar novamente' })
    await new Promise((resolve) => setTimeout(resolve, 100))
    const getsAfter = fetchMock.mock.calls.filter(([url, init]) => String(url).includes('/api/users?') && (init as RequestInit | undefined)?.method === undefined).length
    expect(getsAfter).toBe(getsBefore)
  })

  it('confirmacao congela payload, move foco, Escape cancela e retorna', async () => {
    const patches: Array<{ url: string; body: unknown }> = []
    adminStubs((url, init) => {
      if (init.method === 'PATCH' && url.includes('/api/users/')) {
        patches.push({ url, body: JSON.parse(String(init.body)) })
        return { payload: { ...directoryPayload().items[0] }, status: 200 }
      }
      return undefined
    })
    renderWithQuery(<SettingsPage />)
    expect(await screen.findByText('Administradora Sintética')).toBeVisible()
    const opener = screen.getByRole('button', { name: 'Editar Administradora Sintética' })
    fireEvent.click(opener)
    const form = within(screen.getByRole('region', { name: 'Editar usuário' }))
    const nameInput = form.getByLabelText('Nome de exibição') as HTMLInputElement
    fireEvent.change(nameInput, { target: { value: 'Admin Congelada' } })
    fireEvent.click(form.getByLabelText('Ativo'))
    fireEvent.click(form.getByRole('button', { name: 'Salvar alterações' }))
    const dialog = await screen.findByRole('alertdialog')
    expect(nameInput).toBeDisabled()
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Confirmar desativação' }))
    fireEvent.keyDown(dialog, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
    expect(document.activeElement).toBe(form.getByRole('button', { name: 'Salvar alterações' }))
    expect(patches).toHaveLength(0)
    fireEvent.change(nameInput, { target: { value: 'Admin Final' } })
    fireEvent.click(form.getByRole('button', { name: 'Salvar alterações' }))
    await screen.findByRole('alertdialog')
    fireEvent.change(nameInput, { target: { value: 'Admin Burlada' } })
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar desativação' }))
    await waitFor(() => expect(patches).toHaveLength(1))
    expect(patches[0]!.body).toEqual({ displayName: 'Admin Final', active: false })
  })

  it('modal torna o fundo inerte e prende o Tab em ciclo', async () => {
    adminStubs(() => undefined)
    const { container } = renderWithQuery(<SettingsPage />)
    expect(await screen.findByText('Administradora Sintética')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Editar Administradora Sintética' }))
    fireEvent.click(within(screen.getByRole('region', { name: 'Editar usuário' })).getByLabelText('Ativo'))
    fireEvent.click(screen.getByRole('button', { name: 'Salvar alterações' }))
    const dialog = await screen.findByRole('alertdialog')
    const appNodes = Array.from(document.body.children).filter((node) => node !== dialog.parentElement)
    expect(appNodes.length).toBeGreaterThan(0)
    for (const node of appNodes) expect(node).toHaveAttribute('inert')
    const confirm = within(dialog).getByRole('button', { name: 'Confirmar desativação' })
    const back = within(dialog).getByRole('button', { name: 'Voltar' })
    expect(document.activeElement).toBe(confirm)
    back.focus()
    fireEvent.keyDown(dialog, { key: 'Tab' })
    expect(document.activeElement).toBe(confirm)
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(back)
    fireEvent.keyDown(dialog, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
    for (const node of Array.from(document.body.children)) {
      if (node.textContent?.includes('Confirmar desativação') === true) continue
      expect(node).not.toHaveAttribute('inert')
    }
    expect(container.textContent).not.toContain('Confirmar desativação')
  })

  it('erro no PATCH foca o retry e repete o delta identico', async () => {
    const patches: Array<{ url: string; body: unknown }> = []
    adminStubs((url, init) => {
      if (init.method === 'PATCH' && url.includes('/api/users/')) {
        patches.push({ url, body: JSON.parse(String(init.body)) })
        if (patches.length === 1) return { payload: { code: 'X', message: 'boom' }, status: 500 }
        return { payload: { ...directoryPayload().items[1], displayName: 'Caixa Um' }, status: 200 }
      }
      return undefined
    })
    renderWithQuery(<SettingsPage />)
    expect(await screen.findByText('Caixa Sintético')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Editar Caixa Sintético' }))
    const form = within(screen.getByRole('region', { name: 'Editar usuário' }))
    fireEvent.change(form.getByLabelText('Nome de exibição'), { target: { value: 'Caixa Um' } })
    fireEvent.click(form.getByRole('button', { name: 'Salvar alterações' }))
    await waitFor(() => expect(patches).toHaveLength(1))
    const retry = await screen.findByRole('button', { name: 'Tentar novamente' })
    expect(document.activeElement).toBe(retry)
    fireEvent.click(retry)
    await waitFor(() => expect(patches).toHaveLength(2))
    expect(patches[1]!.body).toEqual(patches[0]!.body)
  })

  it('sucesso fecha sem residuo modal e foca contexto restante', async () => {
    adminStubs((url, init) => {
      if (init.method === 'PATCH' && url.includes('/api/users/')) {
        return { payload: { ...directoryPayload().items[1], displayName: 'Caixa Um' }, status: 200 }
      }
      return undefined
    })
    renderWithQuery(<SettingsPage />)
    expect(await screen.findByText('Caixa Sintético')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Editar Caixa Sintético' }))
    const form = within(screen.getByRole('region', { name: 'Editar usuário' }))
    fireEvent.change(form.getByLabelText('Nome de exibição'), { target: { value: 'Caixa Um' } })
    fireEvent.click(form.getByRole('button', { name: 'Salvar alterações' }))
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Editar usuário' })).not.toBeInTheDocument())
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    for (const node of Array.from(document.body.children)) expect(node).not.toHaveAttribute('inert')
    expect(document.activeElement).toBe(screen.getByLabelText('Busca'))
  })

  it('sessao com erro nao-401 oferece retry local', async () => {
    let sessions = 0
    const admin = { user: { displayName: 'Chef', username: 'chef', role: 'administrator' }, permissions: ['*'] }
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (String(url).endsWith('/api/auth/session')) {
        sessions += 1
        if (sessions === 1) return Promise.resolve(new Response(JSON.stringify({ code: 'X', message: 'boom' }), { status: 500 }))
        return Promise.resolve(jsonResponse(admin))
      }
      if (String(url).endsWith('/api/health/ready')) {
        return Promise.resolve(jsonResponse({
          status: 'ready', service: 'erp-api', version: '0.0.0',
          checks: { database: 'up' }, integrations: { catalog: 'not_configured' },
        }))
      }
      if (String(url).includes('/api/users')) return Promise.resolve(jsonResponse(directoryPayload()))
      throw new Error(`request inesperado: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    renderWithQuery(<SettingsPage />)
    expect(await screen.findByRole('alert')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Tentar novamente' }))
    expect(await screen.findByText('Novo usuário')).toBeVisible()
    expect(sessions).toBe(2)
  })

  it('desativacao exige confirmacao acessivel antes do PATCH', async () => {
    const patches: Array<{ url: string; body: unknown }> = []
    adminStubs((url, init) => {
      if (init.method === 'PATCH' && url.includes('/api/users/')) {
        patches.push({ url, body: JSON.parse(String(init.body)) })
        return { payload: { ...directoryPayload().items[0], active: false }, status: 200 }
      }
      return undefined
    })
    renderWithQuery(<SettingsPage />)
    expect(await screen.findByText('Administradora Sintética')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Editar Administradora Sintética' }))
    fireEvent.click(screen.getByLabelText('Ativo'))
    fireEvent.click(screen.getByRole('button', { name: 'Salvar alterações' }))
    expect(await screen.findByText(/invalida as sessões/)).toBeVisible()
    expect(patches).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar desativação' }))
    await waitFor(() => expect(patches).toHaveLength(1))
    expect(patches[0]!.body).toMatchObject({ active: false })
  })
})
