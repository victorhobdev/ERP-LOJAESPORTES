export type ApiErrorBody = { code?: string; message?: string; requestId?: string }

export class ApiError extends Error {
  constructor(public readonly status: number, public readonly body: ApiErrorBody) {
    super(body.message ?? 'Não foi possível concluir a operação.')
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers)
  headers.set('Accept', 'application/json')
  if (init.body) headers.set('Content-Type', 'application/json')
  const csrf = readCookie('erp_csrf')
  if (csrf && init.method && init.method !== 'GET') headers.set('X-CSRF-Token', csrf)
  const response = await fetch(`/api${path}`, { ...init, credentials: 'include', headers })
  const body = await response.json() as T | ApiErrorBody
  if (!response.ok) throw new ApiError(response.status, body as ApiErrorBody)
  return body as T
}

export function idempotencyHeaders(): Record<string, string> {
  return { 'Idempotency-Key': crypto.randomUUID() }
}

export function formatMoney(value: string): string {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(value))
}

function readCookie(name: string): string | undefined {
  const prefix = `${encodeURIComponent(name)}=`
  const part = document.cookie.split('; ').find((item) => item.startsWith(prefix))
  return part ? decodeURIComponent(part.slice(prefix.length)) : undefined
}
