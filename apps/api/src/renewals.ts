import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { PrismaClient } from '@hostbilling/database';
import { authenticate, requireTenant, requireTenantRole } from './auth.js';
import { addBillingInterval } from './billing-periods.js';
import {
  MAX_MINOR_UNITS,
  buildInvoiceLines,
  createPeriodInvoice,
  isUniqueConstraintError,
} from './invoice-issuing.js';

interface RenewalPluginOptions {
  db: PrismaClient;
}

// A subscription can be renewed this many days before its current period ends.
export const RENEWAL_WINDOW_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

const renewSchema = z
  .object({
    dueInDays: z.number().int().min(0).max(90).default(7),
  })
  .strict();

const subscriptionParamsSchema = z.object({ subscriptionId: z.string().uuid() });

const subscriptionInclude = {
  customer: { select: { id: true, name: true, email: true } },
  plan: { select: { id: true, slug: true, name: true } },
} as const;

class ConflictError extends Error {}

export const renewalRoutes: FastifyPluginAsync<RenewalPluginOptions> = async (app, { db }) => {
  const renewalAccess = [
    authenticate(db),
    requireTenant(db),
    requireTenantRole('OWNER', 'ADMIN', 'BILLING'),
  ];

  // Renewing moves the subscription to its next billing period and issues that period's
  // invoice. Nothing in the request chooses the dates or amounts.
  app.post(
    '/tenant/subscriptions/:subscriptionId/renew',
    { preHandler: renewalAccess },
    async (request, reply) => {
      const params = subscriptionParamsSchema.safeParse(request.params);

      if (!params.success) {
        return reply.code(400).send({ error: 'Invalid subscription ID' });
      }

      const parsed = renewSchema.safeParse(request.body ?? {});

      if (!parsed.success) {
        return reply.code(400).send({
          error: 'Invalid renewal details',
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

      if (
        subscription.status !== 'ACTIVE' ||
        !currentPeriodStart ||
        !currentPeriodEnd ||
        !startedAt
      ) {
        return reply.code(409).send({ error: 'Only active subscriptions can be renewed' });
      }

      const now = Date.now();

      if (now < currentPeriodEnd.getTime() - RENEWAL_WINDOW_DAYS * DAY_MS) {
        return reply.code(409).send({
          error: `Subscriptions can be renewed ${RENEWAL_WINDOW_DAYS} days before the period ends`,
        });
      }

      // The current period must be settled before the next one is billed.
      const paidInvoice = await db.invoice.findFirst({
        where: {
          tenantId,
          subscriptionId: subscription.id,
          periodStart: currentPeriodStart,
          status: 'PAID',
        },
        select: { id: true },
      });

      if (!paidInvoice) {
        return reply.code(409).send({ error: 'The current billing period has not been paid' });
      }

      // Every period is measured from the original start date. Chaining from the previous
      // end date would let a 31 January start drift to the 28th for good after February.
      const nextPeriodStart = currentPeriodEnd;
      const nextPeriodEnd = addBillingInterval(
        startedAt,
        subscription.billingInterval,
        subscription.intervalCount * (subscription.billedPeriods + 1),
      );

      const { total } = buildInvoiceLines(subscription, nextPeriodStart, nextPeriodEnd);

      if (total > MAX_MINOR_UNITS) {
        return reply.code(422).send({ error: 'Invoice total is too large' });
      }

      try {
        const result = await db.$transaction(async (transaction) => {
          // Matching on billedPeriods means two simultaneous renewals cannot both advance.
          const advanced = await transaction.subscription.updateMany({
            where: {
              id: subscription.id,
              tenantId,
              status: 'ACTIVE',
              billedPeriods: subscription.billedPeriods,
            },
            data: {
              currentPeriodStart: nextPeriodStart,
              currentPeriodEnd: nextPeriodEnd,
              billedPeriods: { increment: 1 },
            },
          });

          const invoice = await createPeriodInvoice(transaction, {
            tenantId,
            subscription,
            periodStart: nextPeriodStart,
            periodEnd: nextPeriodEnd,
            dueInDays: parsed.data.dueInDays,
          });

          // The period change and its invoice are kept together or not at all.
          if (advanced.count !== 1 || !invoice) {
            throw new ConflictError();
          }

          const renewed = await transaction.subscription.findFirst({
            where: { id: subscription.id, tenantId },
            include: subscriptionInclude,
          });

          return { subscription: renewed, invoice };
        });

        return reply.code(201).send(result);
      } catch (error) {
        if (error instanceof ConflictError || isUniqueConstraintError(error)) {
          return reply.code(409).send({ error: 'Subscription changed; reload and try again' });
        }

        throw error;
      }
    },
  );
};
