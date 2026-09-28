import cookie from '@fastify/cookie'
import cors from '@fastify/cors'
import helmet from '@fastify/helmet'
import rateLimit from '@fastify/rate-limit'
import Fastify, { type FastifyServerOptions } from 'fastify'
import type { Pool } from 'pg'

import { registerAuthRoutes } from './modules/auth/routes.js'
import { registerCatalogRoutes, type CatalogPublisher } from './modules/catalog/routes.js'
import type { CatalogSyncProvider } from './modules/catalog/sync-provider.js'
import { registerCustomerOrderRoutes } from './modules/customer-orders/routes.js'
import { registerCustomerRoutes } from './modules/customers/routes.js'
import { registerInventoryRoutes } from './modules/inventory/routes.js'
import { registerProductRoutes } from './modules/products/routes.js'
import { registerPurchaseRoutes } from './modules/purchases/routes.js'
import { registerReportRoutes } from './modules/reports/routes.js'
import { registerExchangeRoutes } from './modules/sales/exchange-routes.js'
import { registerSalesRoutes } from './modules/sales/routes.js'
import { registerUserRoutes } from './modules/users/routes.js'

type BuildAppOptions = {
  allowedOrigins?: string[]
  logger?: FastifyServerOptions['logger']
  pool?: Pool
  secureCookies?: boolean
  mediaStorageDir?: string
  catalogSyncProvider?: CatalogSyncProvider | (() => CatalogSyncProvider | undefined)
  catalogPublisher?: CatalogPublisher
  catalogRateLimits?: { uploadPerMinute?: number; syncPerMinute?: number }
  authenticationDisabled?: boolean
}

const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/

export function safeVersion(value: string | undefined): string {
  if (value === undefined || value.length > 32 || !versionPattern.test(value)) return '0.0.0'
  return value
}

export function buildApp(options: BuildAppOptions = {}) {
  const app = Fastify({ logger: options.logger ?? true })
  const allowedOrigins = options.allowedOrigins ?? []

  app.decorate('authenticationDisabled', options.authenticationDisabled ?? false)

  void app.register(cookie)
  void app.register(cors, {
    credentials: true,
    origin(origin, callback) {
      callback(null, !origin || allowedOrigins.includes(origin))
    },
  })
  void app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        fontSrc: ["'self'"],
        connectSrc: ["'self'"],
      },
    },
    frameguard: { action: 'sameorigin' },
  })

  app.addHook('onRequest', (request, reply, done) => {
    reply.header('x-request-id', request.id)
    done()
  })

  app.get('/health', async () => ({ status: 'ok', service: 'erp-api' }))

  app.get('/health/ready', async (_request, reply) => {
    const version = safeVersion(process.env['APP_VERSION'])
    const catalog = process.env['CATALOG_SYNC_ENABLED'] === 'true' ? 'configured' : 'not_configured'
    if (!options.pool) {
      return reply.status(503).send({
        status: 'not_ready', service: 'erp-api', version,
        checks: { database: 'unconfigured' }, integrations: { catalog },
      })
    }
    try {
      await options.pool.query('SELECT 1')
    } catch {
      return reply.status(503).send({
        status: 'not_ready', service: 'erp-api', version,
        checks: { database: 'down' }, integrations: { catalog },
      })
    }
    return reply.send({
      status: 'ready', service: 'erp-api', version,
      checks: { database: 'up' }, integrations: { catalog },
    })
  })

  if (options.pool) {
    void app.register(async (authScope) => {
      await authScope.register(rateLimit, { global: false })
      registerAuthRoutes(authScope, options.pool!, { secureCookies: options.secureCookies ?? true })
      registerProductRoutes(authScope, options.pool!)
      registerInventoryRoutes(authScope, options.pool!)
      registerSalesRoutes(authScope, options.pool!)
      registerExchangeRoutes(authScope, options.pool!)
      registerPurchaseRoutes(authScope, options.pool!)
      registerCustomerOrderRoutes(authScope, options.pool!)
      registerCustomerRoutes(authScope, options.pool!)
      registerReportRoutes(authScope, options.pool!)
      registerUserRoutes(authScope, options.pool!)
      registerCatalogRoutes(authScope, options.pool!, {
        ...(options.mediaStorageDir === undefined ? {} : { mediaStorageDir: options.mediaStorageDir }),
        ...(options.catalogSyncProvider === undefined ? {} : { syncProvider: options.catalogSyncProvider }),
        ...(options.catalogPublisher === undefined ? {} : { publisher: options.catalogPublisher }),
        ...(options.catalogRateLimits === undefined ? {} : { rateLimits: options.catalogRateLimits }),
      })
    })
  }

  app.setNotFoundHandler((request, reply) => {
    return reply.status(404).send({
      code: 'NOT_FOUND',
      message: 'Recurso não encontrado.',
      fieldErrors: null,
      requestId: request.id,
    })
  })

  app.setErrorHandler((error, request, reply) => {
    const statusCode = typeof error === 'object' && error !== null && 'statusCode' in error && error.statusCode === 429 ? 429 : 500
    if (statusCode === 500) request.log.error({ err: error }, 'Unhandled request error')

    return reply.status(statusCode).send({
      code: statusCode === 429 ? 'RATE_LIMITED' : 'INTERNAL_ERROR',
      message: statusCode === 429 ? 'Muitas tentativas. Aguarde antes de tentar novamente.' : 'Não foi possível concluir a operação.',
      fieldErrors: null,
      requestId: request.id,
    })
  })

  return app
}
