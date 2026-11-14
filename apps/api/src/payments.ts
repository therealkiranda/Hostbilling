import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { PrismaClient } from '@hostbilling/database';
import { authenticate, requireTenant, requireTenantRole } from './auth.js';

interface PaymentPluginOptions {
  db: PrismaClient;
}

// Allows for small clock differences between the browser and the server.
const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

const paymentMethodSchema = z.enum(['BANK_TRANSFER', 'CASH', 'MOBILE_WALLET', 'OTHER']);
const paymentStatusSchema = z.enum(['COMPLETED', 'REVERSED']);

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((value) => (value ? value : undefined));

const recordPaymentSchema = z
  .object({
    method: paymentMethodSchema,
    reference: optionalText(200),
    note: optionalText(1000),
    paidAt: z.string().datetime().optional(),
  })
  .strict();

const listPaymentsSchema = z.object({
  status: paymentStatusSchema.optional(),
  invoiceId: z.string().uuid().optional(),
  customerId: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

const invoiceParamsSchema = z.object({ invoiceId: z.string().uuid() });
const paymentParamsSchema = z.object({ paymentId: z.string().uuid() });

const paymentInclude = {
  invoice: { select: { id: true, number: true, status: true } },
  customer: { select: { id: true, name: true, email: true } },
} as const;

class ConflictError extends Error {}

function isUniqueConstraintError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';
}

export const paymentRoutes: FastifyPluginAsync<PaymentPluginOptions> = async (app, { db }) => {
  const tenantAccess = [authenticate(db), requireTenant(db)];
  const paymentRecording = [...tenantAccess, requireTenantRole('OWNER', 'ADMIN', 'BILLING')];
  const paymentReversal = [...tenantAccess, requireTenantRole('OWNER', 'ADMIN')];

  app.get('/tenant/payments', { preHandler: tenantAccess }, async (request, reply) => {
    const parsed = listPaymentsSchema.safeParse(request.query);

    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid payment filters' });
    }

    const { status, invoiceId, customerId, page, pageSize } = parsed.data;
    const where = {
      tenantId: request.tenantContext!.tenantId,
      ...(status ? { status } : {}),
      ...(invoiceId ? { invoiceId } : {}),
      ...(customerId ? { customerId } : {}),
    };

    const [payments, total] = await Promise.all([
      db.payment.findMany({
        where,
        include: paymentInclude,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      db.payment.count({ where }),
    ]);

    return {
      payments,
      pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
    };
  });

  app.get('/tenant/payments/:paymentId', { preHandler: tenantAccess }, async (request, reply) => {
    const params = paymentParamsSchema.safeParse(request.params);

    if (!params.success) {
      return reply.code(400).send({ error: 'Invalid payment ID' });
    }

    const payment = await db.payment.findFirst({
      where: { id: params.data.paymentId, tenantId: request.tenantContext!.tenantId },
      include: paymentInclude,
    });

    if (!payment) {
      return reply.code(404).send({ error: 'Payment not found' });
    }

    return { payment };
  });

  // The amount and currency always come from the invoice. This milestone records full
  // payments only, so a request can never under- or over-settle an invoice.
  app.post(
    '/tenant/invoices/:invoiceId/payments',
    { preHandler: paymentRecording },
    async (request, reply) => {
      const params = invoiceParamsSchema.safeParse(request.params);

      if (!params.success) {
        return reply.code(400).send({ error: 'Invalid invoice ID' });
      }

      const parsed = recordPaymentSchema.safeParse(request.body);

      if (!parsed.success) {
        return reply.code(400).send({
          error: 'Invalid payment details',
          details: parsed.error.flatten().fieldErrors,
        });
      }

      const now = new Date();
      const paidAt = parsed.data.paidAt ? new Date(parsed.data.paidAt) : now;

      if (paidAt.getTime() > now.getTime() + FUTURE_TOLERANCE_MS) {
        return reply.code(400).send({ error: 'Payment date cannot be in the future' });
      }

      const tenantId = request.tenantContext!.tenantId;
      const invoice = await db.invoice.findFirst({
        where: { id: params.data.invoiceId, tenantId },
      });

      if (!invoice) {
        return reply.code(404).send({ error: 'Invoice not found' });
      }

      if (invoice.status !== 'OPEN') {
        return reply.code(409).send({
          error: `Cannot record a payment for a ${invoice.status.toLowerCase()} invoice`,
        });
      }

      try {
        const payment = await db.$transaction(async (transaction) => {
          // The status guard means two simultaneous payments cannot both settle the invoice.
          const settled = await transaction.invoice.updateMany({
            where: { id: invoice.id, tenantId, status: 'OPEN' },
            data: { status: 'PAID', paidAt },
          });

          if (settled.count !== 1) {
            return null;
          }

          return transaction.payment.create({
            data: {
              tenantId,
              invoiceId: invoice.id,
              customerId: invoice.customerId,
              method: parsed.data.method,
              amountMinorUnits: invoice.totalMinorUnits,
              currency: invoice.currency,
              ...(parsed.data.reference ? { reference: parsed.data.reference } : {}),
              ...(parsed.data.note ? { note: parsed.data.note } : {}),
              paidAt,
              activeKey: invoice.id,
              recordedByUserId: request.authContext!.userId,
            },
            include: paymentInclude,
          });
        });

        if (!payment) {
          return reply.code(409).send({ error: 'Invoice changed; reload and try again' });
        }

        return reply.code(201).send({ payment });
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          return reply.code(409).send({ error: 'Invoice already has a payment' });
        }

        throw error;
      }
    },
  );

  // A payment is never edited or deleted. Reversing keeps the record, marks it reversed,
  // and reopens the invoice so the correct payment can be recorded.
  app.post(
    '/tenant/payments/:paymentId/reverse',
    { preHandler: paymentReversal },
    async (request, reply) => {
      const params = paymentParamsSchema.safeParse(request.params);

      if (!params.success) {
        return reply.code(400).send({ error: 'Invalid payment ID' });
      }

      const tenantId = request.tenantContext!.tenantId;
      const { paymentId } = params.data;

      const payment = await db.payment.findFirst({ where: { id: paymentId, tenantId } });

      if (!payment) {
        return reply.code(404).send({ error: 'Payment not found' });
      }

      if (payment.status !== 'COMPLETED') {
        return reply
          .code(409)
          .send({ error: `Cannot reverse a ${payment.status.toLowerCase()} payment` });
      }

      try {
        const reversed = await db.$transaction(async (transaction) => {
          const paymentUpdate = await transaction.payment.updateMany({
            where: { id: paymentId, tenantId, status: 'COMPLETED' },
            data: {
              status: 'REVERSED',
              reversedAt: new Date(),
              reversedByUserId: request.authContext!.userId,
              activeKey: null,
            },
          });

          const invoiceUpdate = await transaction.invoice.updateMany({
            where: { id: payment.invoiceId, tenantId, status: 'PAID' },
            data: { status: 'OPEN', paidAt: null },
          });

          // Both changes succeed together or neither is kept.
          if (paymentUpdate.count !== 1 || invoiceUpdate.count !== 1) {
            throw new ConflictError();
          }

          return transaction.payment.findFirst({
            where: { id: paymentId, tenantId },
            include: paymentInclude,
          });
        });

        return { payment: reversed };
      } catch (error) {
        if (error instanceof ConflictError) {
          return reply.code(409).send({ error: 'Payment changed; reload and try again' });
        }

        throw error;
      }
    },
  );
};
