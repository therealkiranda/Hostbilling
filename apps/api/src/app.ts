import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';
import { authRoutes, requireTenantRole } from './auth.js';
import { createDatabaseClient, type PrismaClient } from '@hostbilling/database';

interface BuildAppOptions {
  db?: PrismaClient;
  jwtSecret?: string;
}

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const jwtSecret = options.jwtSecret ?? process.env.JWT_SECRET;

  if (!jwtSecret || Buffer.byteLength(jwtSecret) < 32) {
    throw new Error('JWT_SECRET must contain at least 32 bytes of random data.');
  }

  const ownsDatabase = !options.db;
  const db = options.db ?? createDatabaseClient();

  const app = Fastify({
    logger: process.env.NODE_ENV !== 'test',
  });

  app.decorateRequest('authContext', null);
  app.decorateRequest('tenantContext', null);

  app.register(jwt, { secret: jwtSecret });
  app.register(rateLimit, {
    global: true,
    max: 100,
    timeWindow: '1 minute',
  });
  app.register(authRoutes, { db });

  app.get('/health', async () => ({
    status: 'ok',
    service: 'hostbilling-api',
  }));

  app.addHook('onClose', async () => {
    if (ownsDatabase) {
      await db.$disconnect();
    }
  });

  return app;
}

export { requireTenantRole };
