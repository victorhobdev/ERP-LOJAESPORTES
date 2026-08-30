import Fastify, { type FastifyServerOptions } from 'fastify'

type BuildAppOptions = {
  logger?: FastifyServerOptions['logger']
}

export function buildApp(options: BuildAppOptions = {}) {
  const app = Fastify({ logger: options.logger ?? true })

  app.addHook('onRequest', (request, reply, done) => {
    reply.header('x-request-id', request.id)
    done()
  })

  app.get('/health', async () => ({ status: 'ok', service: 'erp-api' }))

  app.setNotFoundHandler((request, reply) => {
    return reply.status(404).send({
      code: 'NOT_FOUND',
      message: 'Recurso não encontrado.',
      fieldErrors: null,
      requestId: request.id,
    })
  })

  app.setErrorHandler((_error, request, reply) => {
    return reply.status(500).send({
      code: 'INTERNAL_ERROR',
      message: 'Não foi possível concluir a operação.',
      fieldErrors: null,
      requestId: request.id,
    })
  })

  return app
}
