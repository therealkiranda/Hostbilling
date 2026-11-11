import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { PrismaClient } from '@hostbilling/database';
import { authenticate, requireTenant, requireTenantRole } from './auth.js';

interface HostingPlanPluginOptions {
  db: PrismaClient;
}

const statusSchema = z.enum(['DRAFT', 'ACTIVE', 'ARCHIVED']);
const billingIntervalSchema = z.enum(['MONTH', 'YEAR']);

const editableFields = {
  slug: z
    .string()
    .trim()
    .min(3)
    .max(64)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().max(5000).nullable(),
  status: statusSchema,
  priceMinorUnits: z.number().int().min(0).max(2_000_000_000),
  setupFeeMinorUnits: z.number().int().min(0).max(2_000_000_000),
  currency: z.string().regex(/^[A-Z]{3}$/),
  billingInterval: billingIntervalSchema,
  intervalCount: z.number().int().min(1).max(12),
  diskQuotaMb: z.number().int().min(1).max(2_000_000_000),
  bandwidthQuotaMb: z.number().int().min(0).max(2_000_000_000),
  maxDomains: z.number().int().min(0).max(1_000_000),
  maxEmailAccounts: z.number().int().min(0).max(1_000_000),
  maxDatabases: z.number().int().min(0).max(1_000_000),
  maxFtpAccounts: z.number().int().min(0).max(1_000_000),
};

const createHostingPlanSchema = z
  .object({
    ...editableFields,
    description: editableFields.description.default(null),
    status: statusSchema.default('DRAFT'),
    setupFeeMinorUnits: editableFields.setupFeeMinorUnits.default(0),
    intervalCount: editableFields.intervalCount.default(1),
    maxDomains: editableFields.maxDomains.default(1),
    maxEmailAccounts: editableFields.maxEmailAccounts.default(0),
    maxDatabases: editableFields.maxDatabases.default(0),
    maxFtpAccounts: editableFields.maxFtpAccounts.default(0),
  })
  .strict();

const updateHostingPlanSchema = z
  .object({
    ...editableFields,
    description: editableFields.description.optional(),
  })
  .partial()
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'At least one field must be provided');

const listHostingPlansSchema = z.object({
  status: statusSchema.optional(),
});

function omitUndefined<T extends object>(
  value: T,
): { [Key in keyof T]?: Exclude<T[Key], undefined> } {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as { [Key in keyof T]?: Exclude<T[Key], undefined> };
}

export const hostingPlanRoutes: FastifyPluginAsync<HostingPlanPluginOptions> = async (
  app,
  { db },
) => {
  const tenantAccess = [authenticate(db), requireTenant(db)];
  const planManagement = [...tenantAccess, requireTenantRole('OWNER', 'ADMIN')];

  app.get('/tenant/hosting-plans', { preHandler: tenantAccess }, async (request, reply) => {
    const parsed = listHostingPlansSchema.safeParse(request.query);

    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid hosting plan filters' });
    }

    const plans = await db.hostingPlan.findMany({
      where: {
        tenantId: request.tenantContext!.tenantId,
        ...(parsed.data.status ? { status: parsed.data.status } : {}),
      },
      orderBy: { createdAt: 'desc' },
    });

    return { plans };
  });

  app.post('/tenant/hosting-plans', { preHandler: planManagement }, async (request, reply) => {
    const parsed = createHostingPlanSchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.code(400).send({
        error: 'Invalid hosting plan details',
        details: parsed.error.flatten().fieldErrors,
      });
    }

    try {
      const plan = await db.hostingPlan.create({
        data: {
          ...parsed.data,
          tenantId: request.tenantContext!.tenantId,
        },
      });

      return reply.code(201).send({ plan });
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'P2002'
      ) {
        return reply.code(409).send({ error: 'A hosting plan with this slug already exists' });
      }

      throw error;
    }
  });

  app.patch(
    '/tenant/hosting-plans/:planId',
    { preHandler: planManagement },
    async (request, reply) => {
      const params = z.object({ planId: z.string().uuid() }).safeParse(request.params);
      const parsed = updateHostingPlanSchema.safeParse(request.body);

      if (!params.success || !parsed.success) {
        return reply.code(400).send({ error: 'Invalid hosting plan update' });
      }

      try {
        const updated = await db.hostingPlan.updateMany({
          where: {
            id: params.data.planId,
            tenantId: request.tenantContext!.tenantId,
          },
          data: omitUndefined(parsed.data),
        });

        if (updated.count !== 1) {
          return reply.code(404).send({ error: 'Hosting plan not found' });
        }

        const plan = await db.hostingPlan.findFirst({
          where: {
            id: params.data.planId,
            tenantId: request.tenantContext!.tenantId,
          },
        });

        return { plan };
      } catch (error) {
        if (
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          error.code === 'P2002'
        ) {
          return reply.code(409).send({ error: 'A hosting plan with this slug already exists' });
        }

        throw error;
      }
    },
  );
};
