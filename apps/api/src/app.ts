import cookie from '@fastify/cookie'
import cors from '@fastify/cors'
import helmet from '@fastify/helmet'
import rateLimit from '@fastify/rate-limit'
import Fastify, { type FastifyServerOptions } from 'fastify'
import type { Pool } from 'pg'

import { registerAuthRoutes } from './modules/auth/routes.js'
import { registerInventoryRoutes } from './modules/inventory/routes.js'
import { registerProductRoutes } from './modules/products/routes.js'
import { registerExchangeRoutes } from './modules/sales/exchange-routes.js'
import { registerSalesRoutes } from './modules/sales/routes.js'

type BuildAppOptions = {
  allowedOrigins?: string[]
  logger?: FastifyServerOptions['logger']
  pool?: Pool
  secureCookies?: boolean
}

export function buildApp(options: BuildAppOptions = {}) {
  const app = Fastify({ logger: options.logger ?? true })
  const allowedOrigins = options.allowedOrigins ?? []

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

  if (options.pool) {
    void app.register(async (authScope) => {
      await authScope.register(rateLimit, { global: false })
      registerAuthRoutes(authScope, options.pool!, { secureCookies: options.secureCookies ?? true })
      registerProductRoutes(authScope, options.pool!)
      registerInventoryRoutes(authScope, options.pool!)
      registerSalesRoutes(authScope, options.pool!)
      registerExchangeRoutes(authScope, options.pool!)
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
