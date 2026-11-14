import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { PrismaClient } from '@hostbilling/database';
import { authenticate, requireTenant, requireTenantRole } from './auth.js';

interface InvoicePluginOptions {
  db: PrismaClient;
}

const MAX_MINOR_UNITS = 2_147_483_647;

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

const invoiceInclude = {
  lineItems: { orderBy: { createdAt: 'asc' } },
  customer: { select: { id: true, name: true, email: true } },
} as const;

function isUniqueConstraintError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';
}

const formatDate = (value: Date): string => value.toISOString().slice(0, 10);

export function formatInvoiceNumber(sequence: number): string {
  return `INV-${String(sequence).padStart(6, '0')}`;
}

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

      const { currentPeriodStart, currentPeriodEnd, startedAt } = subscription;

      if (subscription.status !== 'ACTIVE' || !currentPeriodStart || !currentPeriodEnd) {
        return reply.code(409).send({ error: 'Only active subscriptions can be invoiced' });
      }

      const periodLabel = `${formatDate(currentPeriodStart)} to ${formatDate(currentPeriodEnd)}`;
      const lineItems = [
        {
          description: `${subscription.plan.name} hosting (${periodLabel})`,
          quantity: 1,
          unitAmountMinorUnits: subscription.priceMinorUnits,
          amountMinorUnits: subscription.priceMinorUnits,
        },
      ];

      // The one-time setup fee is billed on the invoice for the first period only.
      if (
        subscription.setupFeeMinorUnits > 0 &&
        startedAt &&
        startedAt.getTime() === currentPeriodStart.getTime()
      ) {
        lineItems.push({
          description: `${subscription.plan.name} setup fee`,
          quantity: 1,
          unitAmountMinorUnits: subscription.setupFeeMinorUnits,
          amountMinorUnits: subscription.setupFeeMinorUnits,
        });
      }

      const total = lineItems.reduce((sum, item) => sum + item.amountMinorUnits, 0);

      if (total > MAX_MINOR_UNITS) {
        return reply.code(422).send({ error: 'Invoice total is too large' });
      }

      const issuedAt = new Date();
      const dueAt = new Date(issuedAt.getTime() + parsed.data.dueInDays * 24 * 60 * 60 * 1000);
      // One live invoice per subscription period; voiding frees the key for reissue.
      const periodKey = `${subscription.id}:${currentPeriodStart.toISOString()}`;

      try {
        const invoice = await db.$transaction(async (transaction) => {
          const existing = await transaction.invoice.findFirst({
            where: { tenantId, periodKey },
            select: { id: true },
          });

          if (existing) {
            return null;
          }

          // The increment is atomic, so concurrent requests never share a number.
          const { invoiceCounter } = await transaction.tenant.update({
            where: { id: tenantId },
            data: { invoiceCounter: { increment: 1 } },
            select: { invoiceCounter: true },
          });

          return transaction.invoice.create({
            data: {
              tenantId,
              customerId: subscription.customerId,
              subscriptionId: subscription.id,
              number: formatInvoiceNumber(invoiceCounter),
              currency: subscription.currency,
              subtotalMinorUnits: total,
              totalMinorUnits: total,
              issuedAt,
              dueAt,
              periodStart: currentPeriodStart,
              periodEnd: currentPeriodEnd,
              periodKey,
              lineItems: { create: lineItems.map((item) => ({ ...item, tenantId })) },
            },
            include: invoiceInclude,
          });
        });

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
