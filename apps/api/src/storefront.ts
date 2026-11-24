import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { PrismaClient } from '@hostbilling/database';
import { hostnamePattern } from './hostname.js';
import { isUniqueConstraintError } from './invoice-issuing.js';

interface StorefrontPluginOptions {
  db: PrismaClient;
}

const tenantParamsSchema = z.object({
  tenantSlug: z
    .string()
    .min(1)
    .max(63)
    .regex(/^[a-z0-9-]+$/),
});

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((value) => (value ? value : undefined));

const orderSchema = z
  .object({
    planId: z.string().uuid(),
    name: z.string().trim().min(1).max(120),
    email: z.string().trim().toLowerCase().email().max(254),
    phone: z
      .string()
      .trim()
      .regex(/^\+?[0-9][0-9\s\-()]{5,19}$/)
      .optional(),
    companyName: optionalText(120),
    domain: z.string().trim().toLowerCase().regex(hostnamePattern),
  })
  .strict();

// Only fields a visitor needs to compare plans. Nothing about the tenant's internals.
const publicPlanSelect = {
  id: true,
  slug: true,
  name: true,
  description: true,
  priceMinorUnits: true,
  setupFeeMinorUnits: true,
  currency: true,
  billingInterval: true,
  intervalCount: true,
  diskQuotaMb: true,
  bandwidthQuotaMb: true,
  maxDomains: true,
  maxEmailAccounts: true,
  maxDatabases: true,
  maxFtpAccounts: true,
} as const;

const orderReference = (subscriptionId: string): string => subscriptionId.slice(0, 8).toUpperCase();

export const storefrontRoutes: FastifyPluginAsync<StorefrontPluginOptions> = async (
  app,
  { db },
) => {
  app.get('/public/tenants/:tenantSlug/plans', async (request, reply) => {
    const params = tenantParamsSchema.safeParse(request.params);

    if (!params.success) {
      return reply.code(400).send({ error: 'Invalid provider' });
    }

    const tenant = await db.tenant.findFirst({
      where: { slug: params.data.tenantSlug, status: 'ACTIVE' },
      select: { id: true, name: true, slug: true },
    });

    if (!tenant) {
      return reply.code(404).send({ error: 'Provider not found' });
    }

    const plans = await db.hostingPlan.findMany({
      where: { tenantId: tenant.id, status: 'ACTIVE' },
      select: publicPlanSelect,
      orderBy: [{ priceMinorUnits: 'asc' }, { name: 'asc' }],
    });

    return { tenant: { name: tenant.name, slug: tenant.slug }, plans };
  });

  // A visitor can only ask for a plan. The order is stored as a pending subscription that
  // the provider's staff review and activate, so nothing is billed or provisioned yet.
  app.post(
    '/public/tenants/:tenantSlug/orders',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const params = tenantParamsSchema.safeParse(request.params);

      if (!params.success) {
        return reply.code(400).send({ error: 'Invalid provider' });
      }

      const parsed = orderSchema.safeParse(request.body);

      if (!parsed.success) {
        return reply.code(400).send({
          error: 'Invalid order details',
          details: parsed.error.flatten().fieldErrors,
        });
      }

      const tenant = await db.tenant.findFirst({
        where: { slug: params.data.tenantSlug, status: 'ACTIVE' },
        select: { id: true },
      });

      if (!tenant) {
        return reply.code(404).send({ error: 'Provider not found' });
      }

      const tenantId = tenant.id;
      const { planId, name, email, phone, companyName, domain } = parsed.data;

      const plan = await db.hostingPlan.findFirst({
        where: { id: planId, tenantId, status: 'ACTIVE' },
      });

      if (!plan) {
        return reply.code(404).send({ error: 'Plan not found' });
      }

      try {
        const result = await db.$transaction(async (transaction) => {
          // An existing customer is reused as-is. A public form never rewrites their details.
          const existingCustomer = await transaction.customer.findFirst({
            where: { tenantId, email },
          });

          const customer =
            existingCustomer ??
            (await transaction.customer.create({
              data: {
                tenantId,
                name,
                email,
                ...(phone ? { phone } : {}),
                ...(companyName ? { companyName } : {}),
              },
            }));

          if (customer.status !== 'ACTIVE') {
            return { kind: 'blocked' } as const;
          }

          // Submitting the form twice returns the same order instead of creating a second.
          const duplicate = await transaction.subscription.findFirst({
            where: {
              tenantId,
              customerId: customer.id,
              planId: plan.id,
              domain,
              status: 'PENDING',
            },
            select: { id: true },
          });

          if (duplicate) {
            return { kind: 'existing', id: duplicate.id } as const;
          }

          const subscription = await transaction.subscription.create({
            data: {
              tenantId,
              customerId: customer.id,
              planId: plan.id,
              status: 'PENDING',
              domain,
              priceMinorUnits: plan.priceMinorUnits,
              setupFeeMinorUnits: plan.setupFeeMinorUnits,
              currency: plan.currency,
              billingInterval: plan.billingInterval,
              intervalCount: plan.intervalCount,
            },
            select: { id: true },
          });

          return { kind: 'created', id: subscription.id } as const;
        });

        if (result.kind === 'blocked') {
          return reply
            .code(422)
            .send({ error: 'This order could not be placed. Contact the provider to continue.' });
        }

        return reply.code(result.kind === 'created' ? 201 : 200).send({
          order: {
            reference: orderReference(result.id),
            status: 'PENDING',
            plan: { name: plan.name },
            domain,
          },
        });
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          return reply
            .code(409)
            .send({ error: 'Your order is already being processed. Try again.' });
        }

        throw error;
      }
    },
  );
};
