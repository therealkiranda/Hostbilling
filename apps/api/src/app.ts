import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';
import { authRoutes, requireTenantRole } from './auth.js';
import { customerRoutes } from './customers.js';
import { hostingPlanRoutes } from './hosting-plans.js';
import { hostPanelRoutes } from './hostpanel.js';
import { invoiceRoutes } from './invoices.js';
import { paymentRoutes } from './payments.js';
import type { ClientOptions } from './hostpanel-client.js';
import { renewalRoutes } from './renewals.js';
import { parseSecretsKey } from './secrets.js';
import { storefrontRoutes } from './storefront.js';
import { subscriptionRoutes } from './subscriptions.js';
import { createDatabaseClient, type PrismaClient } from '@hostbilling/database';

interface BuildAppOptions {
  db?: PrismaClient;
  jwtSecret?: string;
  /** Browser origins allowed to call the API. Defaults to the CORS_ORIGINS variable. */
  corsOrigins?: string[];
  /** 32-byte key that encrypts stored panel API keys. Defaults to the SECRETS_KEY variable. */
  secretsKey?: Buffer | null;
  /** Overrides how the API calls HostPanel. Used by tests. */
  panelClientOptions?: ClientOptions;
}

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const jwtSecret = options.jwtSecret ?? process.env.JWT_SECRET;

  if (!jwtSecret || Buffer.byteLength(jwtSecret) < 32) {
    throw new Error('JWT_SECRET must contain at least 32 bytes of random data.');
  }

  const panel = {
    secretsKey:
      options.secretsKey === undefined
        ? parseSecretsKey(process.env.SECRETS_KEY)
        : options.secretsKey,
    clientOptions: options.panelClientOptions ?? {
      allowPrivateHosts: process.env.HOSTPANEL_ALLOW_PRIVATE_HOSTS === 'true',
    },
  };

  const ownsDatabase = !options.db;
  const db = options.db ?? createDatabaseClient();

  const app = Fastify({
    logger: process.env.NODE_ENV !== 'test',
  });

  app.decorateRequest('authContext', null);
  app.decorateRequest('tenantContext', null);

  const corsOrigins =
    options.corsOrigins ??
    (process.env.CORS_ORIGINS ?? '')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean);

  // Cross-origin browser access is off unless origins are listed explicitly.
  app.register(cors, {
    origin: corsOrigins.length > 0 ? corsOrigins : false,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['authorization', 'content-type', 'x-tenant-id'],
    maxAge: 600,
  });
  app.register(jwt, { secret: jwtSecret });
  app.register(rateLimit, {
    global: true,
    max: 100,
    timeWindow: '1 minute',
  });
  app.register(authRoutes, { db });
  app.register(hostingPlanRoutes, { db });
  app.register(subscriptionRoutes, { db, panel });
  app.register(hostPanelRoutes, { db, panel });
  app.register(invoiceRoutes, { db });
  app.register(paymentRoutes, { db });
  app.register(renewalRoutes, { db });
  app.register(storefrontRoutes, { db });
  app.register(customerRoutes, { db });

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
