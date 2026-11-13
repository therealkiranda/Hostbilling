import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { PrismaClient } from '@hostbilling/database';
import { authenticate, requireTenant, requireTenantRole } from './auth.js';
import { addBillingInterval } from './billing-periods.js';

interface SubscriptionPluginOptions {
  db: PrismaClient;
}

const statusSchema = z.enum(['PENDING', 'ACTIVE', 'SUSPENDED', 'CANCELLED']);
type SubscriptionStatusValue = z.infer<typeof statusSchema>;

const createSubscriptionSchema = z
  .object({
    customerId: z.string().uuid(),
    planId: z.string().uuid(),
    activate: z.boolean().default(false),
  })
  .strict();

const listSubscriptionsSchema = z.object({
  status: statusSchema.optional(),
  customerId: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

const subscriptionParamsSchema = z.object({ subscriptionId: z.string().uuid() });

const subscriptionInclude = {
  customer: { select: { id: true, name: true, email: true } },
  plan: { select: { id: true, slug: true, name: true } },
} as const;

type TransitionAction = 'activate' | 'suspend' | 'cancel';

const transitions: Record<
  TransitionAction,
  { from: readonly SubscriptionStatusValue[]; verb: string }
> = {
  activate: { from: ['PENDING', 'SUSPENDED'], verb: 'activate' },
  suspend: { from: ['ACTIVE'], verb: 'suspend' },
  cancel: { from: ['PENDING', 'ACTIVE', 'SUSPENDED'], verb: 'cancel' },
};

interface ExistingSubscription {
  status: SubscriptionStatusValue;
  startedAt: Date | null;
  billingInterval: 'MONTH' | 'YEAR';
  intervalCount: number;
}

function transitionData(action: TransitionAction, existing: ExistingSubscription, now: Date) {
  switch (action) {
    case 'activate':
      // The first activation starts the first billing period. Reactivating a suspended
      // subscription keeps its existing period so billing history is not rewritten.
      return existing.startedAt
        ? { status: 'ACTIVE' as const, suspendedAt: null }
        : {
            status: 'ACTIVE' as const,
            suspendedAt: null,
            startedAt: now,
            currentPeriodStart: now,
            currentPeriodEnd: addBillingInterval(
              now,
              existing.billingInterval,
              existing.intervalCount,
            ),
          };
    case 'suspend':
      return { status: 'SUSPENDED' as const, suspendedAt: now };
    case 'cancel':
      return { status: 'CANCELLED' as const, cancelledAt: now };
  }
}

export const subscriptionRoutes: FastifyPluginAsync<SubscriptionPluginOptions> = async (
  app,
  { db },
) => {
  const tenantAccess = [authenticate(db), requireTenant(db)];
  const subscriptionManagement = [...tenantAccess, requireTenantRole('OWNER', 'ADMIN')];

  app.get('/tenant/subscriptions', { preHandler: tenantAccess }, async (request, reply) => {
    const parsed = listSubscriptionsSchema.safeParse(request.query);

    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid subscription filters' });
    }

    const { status, customerId, page, pageSize } = parsed.data;
    const where = {
      tenantId: request.tenantContext!.tenantId,
      ...(status ? { status } : {}),
      ...(customerId ? { customerId } : {}),
    };

    const [subscriptions, total] = await Promise.all([
      db.subscription.findMany({
        where,
        include: subscriptionInclude,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      db.subscription.count({ where }),
    ]);

    return {
      subscriptions,
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.ceil(total / pageSize),
      },
    };
  });

  app.get(
    '/tenant/subscriptions/:subscriptionId',
    { preHandler: tenantAccess },
    async (request, reply) => {
      const params = subscriptionParamsSchema.safeParse(request.params);

      if (!params.success) {
        return reply.code(400).send({ error: 'Invalid subscription ID' });
      }

      const subscription = await db.subscription.findFirst({
        where: {
          id: params.data.subscriptionId,
          tenantId: request.tenantContext!.tenantId,
        },
        include: subscriptionInclude,
      });

      if (!subscription) {
        return reply.code(404).send({ error: 'Subscription not found' });
      }

      return { subscription };
    },
  );

  app.post(
    '/tenant/subscriptions',
    { preHandler: subscriptionManagement },
    async (request, reply) => {
      const parsed = createSubscriptionSchema.safeParse(request.body);

      if (!parsed.success) {
        return reply.code(400).send({
          error: 'Invalid subscription details',
          details: parsed.error.flatten().fieldErrors,
        });
      }

      const tenantId = request.tenantContext!.tenantId;
      const { customerId, planId, activate } = parsed.data;

      const [customer, plan] = await Promise.all([
        db.customer.findFirst({ where: { id: customerId, tenantId } }),
        db.hostingPlan.findFirst({ where: { id: planId, tenantId } }),
      ]);

      if (!customer) {
        return reply.code(404).send({ error: 'Customer not found' });
      }

      if (!plan) {
        return reply.code(404).send({ error: 'Hosting plan not found' });
      }

      if (customer.status !== 'ACTIVE') {
        return reply.code(409).send({ error: 'Customer is inactive' });
      }

      if (plan.status !== 'ACTIVE') {
        return reply.code(409).send({ error: 'Hosting plan is not active' });
      }

      const now = new Date();

      // Pricing is copied from the plan so later plan edits never change what an
      // existing subscriber agreed to pay.
      const subscription = await db.subscription.create({
        data: {
          tenantId,
          customerId: customer.id,
          planId: plan.id,
          priceMinorUnits: plan.priceMinorUnits,
          setupFeeMinorUnits: plan.setupFeeMinorUnits,
          currency: plan.currency,
          billingInterval: plan.billingInterval,
          intervalCount: plan.intervalCount,
          ...(activate
            ? {
                status: 'ACTIVE' as const,
                startedAt: now,
                currentPeriodStart: now,
                currentPeriodEnd: addBillingInterval(now, plan.billingInterval, plan.intervalCount),
              }
            : { status: 'PENDING' as const }),
        },
        include: subscriptionInclude,
      });

      return reply.code(201).send({ subscription });
    },
  );

  for (const action of Object.keys(transitions) as TransitionAction[]) {
    const { from, verb } = transitions[action];

    app.post(
      `/tenant/subscriptions/:subscriptionId/${action}`,
      { preHandler: subscriptionManagement },
      async (request, reply) => {
        const params = subscriptionParamsSchema.safeParse(request.params);

        if (!params.success) {
          return reply.code(400).send({ error: 'Invalid subscription ID' });
        }

        const tenantId = request.tenantContext!.tenantId;
        const { subscriptionId } = params.data;

        const existing = await db.subscription.findFirst({
          where: { id: subscriptionId, tenantId },
        });

        if (!existing) {
          return reply.code(404).send({ error: 'Subscription not found' });
        }

        if (!from.includes(existing.status)) {
          return reply.code(409).send({
            error: `Cannot ${verb} a ${existing.status.toLowerCase()} subscription`,
          });
        }

        // The status guard makes the transition safe against concurrent changes.
        const updated = await db.subscription.updateMany({
          where: { id: subscriptionId, tenantId, status: existing.status },
          data: transitionData(action, existing, new Date()),
        });

        if (updated.count !== 1) {
          return reply.code(409).send({ error: 'Subscription changed; reload and try again' });
        }

        const subscription = await db.subscription.findFirst({
          where: { id: subscriptionId, tenantId },
          include: subscriptionInclude,
        });

        return { subscription };
      },
    );
  }
};
