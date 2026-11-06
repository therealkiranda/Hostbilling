import Fastify, { type FastifyInstance } from 'fastify';

export function buildApp(): FastifyInstance {
  const app = Fastify({
    logger: process.env.NODE_ENV !== 'test',
  });

  app.get('/health', async () => ({
    status: 'ok',
    service: 'hostbilling-api',
  }));

  return app;
}
