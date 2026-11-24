import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { PrismaClient } from '@hostbilling/database';
import { authenticate, requireTenant, requireTenantRole } from './auth.js';
import { HostPanelClient, HostPanelError, validatePanelUrl } from './hostpanel-client.js';
import { syncSubscriptionToPanel, type PanelDeps } from './panel-sync.js';
import { encryptSecret, decryptSecret } from './secrets.js';

interface HostPanelPluginOptions {
  db: PrismaClient;
  panel: PanelDeps;
}

const connectionSchema = z
  .object({
    baseUrl: z.string().trim().min(1).max(300),
    apiKey: z
      .string()
      .trim()
      .regex(/^hpk_[0-9a-f]{8}_[0-9a-f]{48}$/, 'Enter the key exactly as HostPanel showed it'),
    defaultType: z.enum(['php', 'static', 'node', 'python']).default('php'),
    defaultPhp: z
      .string()
      .trim()
      .regex(/^\d\.\d{1,2}$/)
      .optional(),
  })
  .strict();

const subscriptionParamsSchema = z.object({ subscriptionId: z.string().uuid() });

const publicConnection = (connection: {
  baseUrl: string;
  defaultType: string;
  defaultPhp: string | null;
  updatedAt: Date;
}) => ({
  baseUrl: connection.baseUrl,
  defaultType: connection.defaultType,
  defaultPhp: connection.defaultPhp,
  hasKey: true,
  updatedAt: connection.updatedAt,
});

export const hostPanelRoutes: FastifyPluginAsync<HostPanelPluginOptions> = async (
  app,
  { db, panel },
) => {
  const tenantAccess = [authenticate(db), requireTenant(db)];
  // The key can create and delete websites, so only owners manage it.
  const connectionManagement = [...tenantAccess, requireTenantRole('OWNER')];
  const syncAccess = [...tenantAccess, requireTenantRole('OWNER', 'ADMIN')];

  app.get('/tenant/hostpanel', { preHandler: connectionManagement }, async (request) => {
    const connection = await db.hostPanelConnection.findFirst({
      where: { tenantId: request.tenantContext!.tenantId },
    });

    return { connection: connection ? publicConnection(connection) : null };
  });

  // Saving checks the key against the panel first, so a wrong key is caught immediately.
  app.put('/tenant/hostpanel', { preHandler: connectionManagement }, async (request, reply) => {
    if (!panel.secretsKey) {
      return reply.code(503).send({ error: 'Storing panel keys is not configured on this server' });
    }

    const parsed = connectionSchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.code(400).send({
        error: 'Invalid panel connection',
        details: parsed.error.flatten().fieldErrors,
      });
    }

    const tenantId = request.tenantContext!.tenantId;

    try {
      const baseUrl = await validatePanelUrl(parsed.data.baseUrl, panel.clientOptions);
      await new HostPanelClient(
        { baseUrl, apiKey: parsed.data.apiKey },
        panel.clientOptions,
      ).ping();

      const data = {
        baseUrl,
        apiKeyCiphertext: encryptSecret(parsed.data.apiKey, panel.secretsKey),
        defaultType: parsed.data.defaultType,
        defaultPhp: parsed.data.defaultPhp ?? null,
      };

      const connection = await db.hostPanelConnection.upsert({
        where: { tenantId },
        create: { tenantId, ...data },
        update: data,
      });

      return { connection: publicConnection(connection) };
    } catch (error) {
      if (error instanceof HostPanelError) {
        return reply.code(422).send({ error: error.message, code: error.code });
      }
      throw error;
    }
  });

  app.post(
    '/tenant/hostpanel/test',
    { preHandler: connectionManagement },
    async (request, reply) => {
      const connection = await db.hostPanelConnection.findFirst({
        where: { tenantId: request.tenantContext!.tenantId },
      });

      if (!connection) {
        return reply.code(404).send({ error: 'No panel is connected' });
      }

      if (!panel.secretsKey) {
        return reply
          .code(503)
          .send({ error: 'Storing panel keys is not configured on this server' });
      }

      try {
        const apiKey = decryptSecret(connection.apiKeyCiphertext, panel.secretsKey);
        await new HostPanelClient(
          { baseUrl: connection.baseUrl, apiKey },
          panel.clientOptions,
        ).ping();
        return { ok: true };
      } catch (error) {
        if (error instanceof HostPanelError) {
          return reply.code(422).send({ error: error.message, code: error.code });
        }
        return reply
          .code(422)
          .send({ error: 'The saved panel key could not be used. Save the connection again.' });
      }
    },
  );

  app.delete('/tenant/hostpanel', { preHandler: connectionManagement }, async (request, reply) => {
    const removed = await db.hostPanelConnection.deleteMany({
      where: { tenantId: request.tenantContext!.tenantId },
    });

    return removed.count === 1
      ? reply.code(204).send()
      : reply.code(404).send({ error: 'No panel is connected' });
  });

  // Retry after a failure, or provision a subscription that was activated before a panel
  // was connected.
  app.post(
    '/tenant/subscriptions/:subscriptionId/panel-sync',
    { preHandler: syncAccess },
    async (request, reply) => {
      const params = subscriptionParamsSchema.safeParse(request.params);

      if (!params.success) {
        return reply.code(400).send({ error: 'Invalid subscription ID' });
      }

      const tenantId = request.tenantContext!.tenantId;
      const existing = await db.subscription.findFirst({
        where: { id: params.data.subscriptionId, tenantId },
        select: { id: true },
      });

      if (!existing) {
        return reply.code(404).send({ error: 'Subscription not found' });
      }

      const panelResult = await syncSubscriptionToPanel(db, panel, tenantId, existing.id);

      if (panelResult.kind === 'not-configured') {
        return reply.code(409).send({ error: 'No panel is connected' });
      }

      const subscription = await db.subscription.findFirst({
        where: { id: existing.id, tenantId },
        include: {
          customer: { select: { id: true, name: true, email: true } },
          plan: { select: { id: true, slug: true, name: true } },
        },
      });

      return { subscription, panel: panelResult };
    },
  );
};
