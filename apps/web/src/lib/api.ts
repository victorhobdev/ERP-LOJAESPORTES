export type ApiErrorBody = { code?: string; message?: string; requestId?: string }

export class ApiError extends Error {
  constructor(public readonly status: number, public readonly body: ApiErrorBody) {
    super(body.message ?? 'Não foi possível concluir a operação.')
  }
}

export class UncertainResultError extends Error {
  constructor(public readonly status: number, message = 'Resposta da API não pôde ser interpretada; o resultado é incerto.') {
    super(message)
  }
}

async function parseResponse<T>(response: Response): Promise<T> {
  if (response.status === 204) return undefined as T
  let body: T | ApiErrorBody
  try {
    body = await response.json() as T | ApiErrorBody
  } catch {
    if (response.ok) throw new UncertainResultError(response.status)
    throw new ApiError(response.status, {})
  }
  if (!response.ok) throw new ApiError(response.status, body as ApiErrorBody)
  return body as T
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers)
  headers.set('Accept', 'application/json')
  if (init.body) headers.set('Content-Type', 'application/json')
  const csrf = readCookie('erp_csrf')
  if (csrf && init.method && init.method !== 'GET') headers.set('X-CSRF-Token', csrf)
  const response = await fetch(`/api${path}`, { ...init, credentials: 'include', headers })
  return parseResponse<T>(response)
}

/** Upload multipart com CSRF. Nao define Content-Type manualmente: o navegador precisa do boundary. */
export async function apiUpload<T>(path: string, file: File, headers: Record<string, string> = {}): Promise<T> {
  const requestHeaders = new Headers(headers)
  requestHeaders.set('Accept', 'application/json')
  const csrf = readCookie('erp_csrf')
  if (csrf) requestHeaders.set('X-CSRF-Token', csrf)
  const form = new FormData()
  form.append('file', file, file.name)
  const response = await fetch(`/api${path}`, { method: 'POST', credentials: 'include', headers: requestHeaders, body: form })
  return parseResponse<T>(response)
}

export function idempotencyHeaders(existing?: string): Record<string, string> {
  return { 'Idempotency-Key': existing ?? crypto.randomUUID() }
}

export function isUnauthorized(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401
}

export function currentCsrfToken(): string | undefined {
  return readCookie('erp_csrf')
}

export function formatMoney(value: string): string {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(value))
}

function readCookie(name: string): string | undefined {
  const prefix = `${encodeURIComponent(name)}=`
  const part = document.cookie.split('; ').find((item) => item.startsWith(prefix))
  return part ? decodeURIComponent(part.slice(prefix.length)) : undefined
}
