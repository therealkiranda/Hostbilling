import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { PrismaClient } from '@hostbilling/database';
import { authenticate, requireTenant, requireTenantRole } from './auth.js';
import {
  MAX_MINOR_UNITS,
  buildInvoiceLines,
  createPeriodInvoice,
  invoiceInclude,
  isUniqueConstraintError,
} from './invoice-issuing.js';

export { formatInvoiceNumber } from './invoice-issuing.js';

interface InvoicePluginOptions {
  db: PrismaClient;
}

const statusSchema = z.enum(['OPEN', 'PAID', 'VOID']);

const createInvoiceSchema = z
  .object({
    dueInDays: z.number().int().min(0).max(90).default(7),
  })
  .strict();

const listInvoicesSchema = z.object({
  status: statusSchema.optional(),
  customerId: z.string().uuid().optional(),
  subscriptionId: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

const subscriptionParamsSchema = z.object({ subscriptionId: z.string().uuid() });
const invoiceParamsSchema = z.object({ invoiceId: z.string().uuid() });

export const invoiceRoutes: FastifyPluginAsync<InvoicePluginOptions> = async (app, { db }) => {
  const tenantAccess = [authenticate(db), requireTenant(db)];
  const invoiceManagement = [...tenantAccess, requireTenantRole('OWNER', 'ADMIN', 'BILLING')];

  app.get('/tenant/invoices', { preHandler: tenantAccess }, async (request, reply) => {
    const parsed = listInvoicesSchema.safeParse(request.query);

    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid invoice filters' });
    }

    const { status, customerId, subscriptionId, page, pageSize } = parsed.data;
    const where = {
      tenantId: request.tenantContext!.tenantId,
      ...(status ? { status } : {}),
      ...(customerId ? { customerId } : {}),
      ...(subscriptionId ? { subscriptionId } : {}),
    };

    const [invoices, total] = await Promise.all([
      db.invoice.findMany({
        where,
        include: invoiceInclude,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      db.invoice.count({ where }),
    ]);

    return {
      invoices,
      pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
    };
  });

  app.get('/tenant/invoices/:invoiceId', { preHandler: tenantAccess }, async (request, reply) => {
    const params = invoiceParamsSchema.safeParse(request.params);

    if (!params.success) {
      return reply.code(400).send({ error: 'Invalid invoice ID' });
    }

    const invoice = await db.invoice.findFirst({
      where: { id: params.data.invoiceId, tenantId: request.tenantContext!.tenantId },
      include: invoiceInclude,
    });

    if (!invoice) {
      return reply.code(404).send({ error: 'Invoice not found' });
    }

    return { invoice };
  });

  // Invoices are generated from the subscription's own pricing snapshot, never from
  // amounts in the request, so a client cannot choose what it will be billed.
  app.post(
    '/tenant/subscriptions/:subscriptionId/invoices',
    { preHandler: invoiceManagement },
    async (request, reply) => {
      const params = subscriptionParamsSchema.safeParse(request.params);
      const parsed = createInvoiceSchema.safeParse(request.body ?? {});

      if (!params.success) {
        return reply.code(400).send({ error: 'Invalid subscription ID' });
      }

      if (!parsed.success) {
        return reply.code(400).send({
          error: 'Invalid invoice details',
          details: parsed.error.flatten().fieldErrors,
        });
      }

      const tenantId = request.tenantContext!.tenantId;

      const subscription = await db.subscription.findFirst({
        where: { id: params.data.subscriptionId, tenantId },
        include: { plan: { select: { name: true } } },
      });

      if (!subscription) {
        return reply.code(404).send({ error: 'Subscription not found' });
      }

      const { currentPeriodStart, currentPeriodEnd } = subscription;

      if (subscription.status !== 'ACTIVE' || !currentPeriodStart || !currentPeriodEnd) {
        return reply.code(409).send({ error: 'Only active subscriptions can be invoiced' });
      }

      const { total } = buildInvoiceLines(subscription, currentPeriodStart, currentPeriodEnd);

      if (total > MAX_MINOR_UNITS) {
        return reply.code(422).send({ error: 'Invoice total is too large' });
      }

      try {
        const invoice = await db.$transaction((transaction) =>
          createPeriodInvoice(transaction, {
            tenantId,
            subscription,
            periodStart: currentPeriodStart,
            periodEnd: currentPeriodEnd,
            dueInDays: parsed.data.dueInDays,
          }),
        );

        if (!invoice) {
          return reply.code(409).send({ error: 'This billing period has already been invoiced' });
        }

        return reply.code(201).send({ invoice });
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          return reply.code(409).send({ error: 'This billing period has already been invoiced' });
        }

        throw error;
      }
    },
  );

  // Issued invoices are never edited. Voiding is the only change, and only while open.
  app.post(
    '/tenant/invoices/:invoiceId/void',
    { preHandler: invoiceManagement },
    async (request, reply) => {
      const params = invoiceParamsSchema.safeParse(request.params);

      if (!params.success) {
        return reply.code(400).send({ error: 'Invalid invoice ID' });
      }

      const tenantId = request.tenantContext!.tenantId;
      const { invoiceId } = params.data;

      const existing = await db.invoice.findFirst({
        where: { id: invoiceId, tenantId },
        select: { status: true },
      });

      if (!existing) {
        return reply.code(404).send({ error: 'Invoice not found' });
      }

      if (existing.status !== 'OPEN') {
        return reply
          .code(409)
          .send({ error: `Cannot void a ${existing.status.toLowerCase()} invoice` });
      }

      const updated = await db.invoice.updateMany({
        where: { id: invoiceId, tenantId, status: 'OPEN' },
        data: { status: 'VOID', voidedAt: new Date(), periodKey: null },
      });

      if (updated.count !== 1) {
        return reply.code(409).send({ error: 'Invoice changed; reload and try again' });
      }

      const invoice = await db.invoice.findFirst({
        where: { id: invoiceId, tenantId },
        include: invoiceInclude,
      });

      return { invoice };
    },
  );
};
