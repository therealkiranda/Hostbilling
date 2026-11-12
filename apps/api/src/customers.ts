import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { PrismaClient } from '@hostbilling/database';
import { authenticate, requireTenant, requireTenantRole } from './auth.js';

interface CustomerPluginOptions {
  db: PrismaClient;
}

const statusSchema = z.enum(['ACTIVE', 'INACTIVE']);
const optionalText = (max: number) => z.string().trim().max(max).nullable();

const customerFields = {
  name: z.string().trim().min(2).max(120),
  email: z
    .string()
    .trim()
    .email()
    .max(254)
    .transform((value) => value.toLowerCase())
    .nullable(),
  phone: optionalText(40),
  companyName: optionalText(160),
  notes: optionalText(2000),
  status: statusSchema,
};

const createCustomerSchema = z
  .object({
    ...customerFields,
    email: customerFields.email.optional().default(null),
    phone: customerFields.phone.optional().default(null),
    companyName: customerFields.companyName.optional().default(null),
    notes: customerFields.notes.optional().default(null),
    status: statusSchema.default('ACTIVE'),
  })
  .strict();

const updateCustomerSchema = z
  .object({
    ...customerFields,
    email: customerFields.email.optional(),
  })
  .partial()
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'At least one field must be provided');

const listCustomersSchema = z.object({
  q: z.string().trim().max(120).optional(),
  status: statusSchema.optional(),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

function omitUndefined<T extends object>(
  value: T,
): { [Key in keyof T]?: Exclude<T[Key], undefined> } {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as {
    [Key in keyof T]?: Exclude<T[Key], undefined>;
  };
}

function isUniqueConstraintError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';
}

export const customerRoutes: FastifyPluginAsync<CustomerPluginOptions> = async (app, { db }) => {
  const tenantAccess = [authenticate(db), requireTenant(db)];
  const customerManagement = [...tenantAccess, requireTenantRole('OWNER', 'ADMIN')];

  app.get('/tenant/customers', { preHandler: tenantAccess }, async (request, reply) => {
    const parsed = listCustomersSchema.safeParse(request.query);

    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid customer filters' });
    }

    const { q, status, page, pageSize } = parsed.data;
    const tenantId = request.tenantContext!.tenantId;
    const where = {
      tenantId,
      ...(status ? { status } : {}),
      ...(q
        ? {
            OR: [
              { name: { contains: q, mode: 'insensitive' as const } },
              { email: { contains: q, mode: 'insensitive' as const } },
              { companyName: { contains: q, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    };

    const [customers, total] = await Promise.all([
      db.customer.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      db.customer.count({ where }),
    ]);

    return {
      customers,
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.ceil(total / pageSize),
      },
    };
  });

  app.get('/tenant/customers/:customerId', { preHandler: tenantAccess }, async (request, reply) => {
    const params = z.object({ customerId: z.string().uuid() }).safeParse(request.params);

    if (!params.success) {
      return reply.code(400).send({ error: 'Invalid customer ID' });
    }

    const customer = await db.customer.findFirst({
      where: {
        id: params.data.customerId,
        tenantId: request.tenantContext!.tenantId,
      },
    });

    if (!customer) {
      return reply.code(404).send({ error: 'Customer not found' });
    }

    return { customer };
  });

  app.post('/tenant/customers', { preHandler: customerManagement }, async (request, reply) => {
    const parsed = createCustomerSchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.code(400).send({
        error: 'Invalid customer details',
        details: parsed.error.flatten().fieldErrors,
      });
    }

    try {
      const customer = await db.customer.create({
        data: {
          ...parsed.data,
          tenantId: request.tenantContext!.tenantId,
        },
      });

      return reply.code(201).send({ customer });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        return reply.code(409).send({ error: 'A customer with this email already exists' });
      }

      throw error;
    }
  });

  app.patch(
    '/tenant/customers/:customerId',
    { preHandler: customerManagement },
    async (request, reply) => {
      const params = z.object({ customerId: z.string().uuid() }).safeParse(request.params);
      const parsed = updateCustomerSchema.safeParse(request.body);

      if (!params.success || !parsed.success) {
        return reply.code(400).send({ error: 'Invalid customer update' });
      }

      try {
        const updated = await db.customer.updateMany({
          where: {
            id: params.data.customerId,
            tenantId: request.tenantContext!.tenantId,
          },
          data: omitUndefined(parsed.data),
        });

        if (updated.count !== 1) {
          return reply.code(404).send({ error: 'Customer not found' });
        }

        const customer = await db.customer.findFirst({
          where: {
            id: params.data.customerId,
            tenantId: request.tenantContext!.tenantId,
          },
        });

        return { customer };
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          return reply.code(409).send({ error: 'A customer with this email already exists' });
        }

        throw error;
      }
    },
  );
};
