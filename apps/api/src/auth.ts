import { createHash, randomBytes } from 'node:crypto';
import argon2 from 'argon2';
import type {
  FastifyPluginAsync,
  FastifyReply,
  preHandlerHookHandler,
} from 'fastify';
import type { PrismaClient } from '@hostbilling/database';
import { z } from 'zod';

const ACCESS_TOKEN_TTL = '15m';
const SESSION_TTL_DAYS = 30;

type MembershipRole = 'OWNER' | 'ADMIN' | 'BILLING' | 'SUPPORT';

interface AuthTokenPayload {
  sub: string;
  sid: string;
}

interface AuthContext {
  userId: string;
  sessionId: string;
}

interface TenantContext {
  tenantId: string;
  name: string;
  slug: string;
  role: MembershipRole;
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: AuthTokenPayload;
    user: AuthTokenPayload;
  }
}

declare module 'fastify' {
  interface FastifyRequest {
    authContext: AuthContext | null;
    tenantContext: TenantContext | null;
  }
}

interface AuthPluginOptions {
  db: PrismaClient;
}

const registerSchema = z.object({
  organizationName: z.string().trim().min(2).max(120),
  tenantSlug: z
    .string()
    .trim()
    .toLowerCase()
    .min(3)
    .max(48)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  email: z.string().trim().email().max(254).transform((value) => value.toLowerCase()),
  password: z.string().min(12).max(128),
  name: z.string().trim().min(1).max(120).optional(),
});

const loginSchema = z.object({
  email: z.string().trim().email().max(254).transform((value) => value.toLowerCase()),
  password: z.string().min(1).max(128),
});

const refreshSchema = z.object({
  refreshToken: z.string().min(40).max(200),
});

const sha256 = (value: string): string =>
  createHash('sha256').update(value).digest('hex');

const createRefreshToken = (): string => randomBytes(48).toString('base64url');

const sessionExpiry = (): Date => {
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + SESSION_TTL_DAYS);
  return expiresAt;
};

function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'P2002'
  );
}

async function issueTokens(
  db: PrismaClient,
  reply: FastifyReply,
  userId: string,
  sessionId?: string,
) {
  const refreshToken = createRefreshToken();
  const expiresAt = sessionExpiry();

  const session = sessionId
    ? await db.authSession.update({
        where: { id: sessionId },
        data: {
          tokenHash: sha256(refreshToken),
          expiresAt,
          lastUsedAt: new Date(),
        },
      })
    : await db.authSession.create({
        data: {
          userId,
          tokenHash: sha256(refreshToken),
          expiresAt,
        },
      });

  const accessToken = await reply.jwtSign(
    { sub: userId, sid: session.id },
    { expiresIn: ACCESS_TOKEN_TTL },
  );

  return {
    tokenType: 'Bearer',
    accessToken,
    accessTokenExpiresIn: ACCESS_TOKEN_TTL,
    refreshToken,
    refreshTokenExpiresAt: expiresAt.toISOString(),
  };
}

export function authenticate(db: PrismaClient): preHandlerHookHandler {
  return async (request, reply) => {
    try {
      const payload = await request.jwtVerify<AuthTokenPayload>();

      if (!payload.sub || !payload.sid) {
        return reply.code(401).send({ error: 'Unauthorized' });
      }

      const [session, user] = await Promise.all([
        db.authSession.findFirst({
          where: {
            id: payload.sid,
            userId: payload.sub,
            revokedAt: null,
            expiresAt: { gt: new Date() },
          },
          select: { id: true },
        }),
        db.user.findFirst({
          where: { id: payload.sub, status: 'ACTIVE' },
          select: { id: true },
        }),
      ]);

      if (!session || !user) {
        return reply.code(401).send({ error: 'Unauthorized' });
      }

      request.authContext = {
        userId: user.id,
        sessionId: session.id,
      };
    } catch {
      return reply.code(401).send({ error: 'Unauthorized' });
    }
  };
}

export function requireTenant(db: PrismaClient): preHandlerHookHandler {
  return async (request, reply) => {
    if (!request.authContext) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }

    const tenantId = request.headers['x-tenant-id'];

    if (typeof tenantId !== 'string') {
      return reply.code(400).send({ error: 'A valid x-tenant-id header is required' });
    }

    const membership = await db.tenantMembership.findFirst({
      where: {
        tenantId,
        userId: request.authContext.userId,
        tenant: { is: { status: 'ACTIVE' } },
      },
      include: {
        tenant: {
          select: { id: true, name: true, slug: true },
        },
      },
    });

    if (!membership) {
      return reply.code(403).send({ error: 'You do not have access to this tenant' });
    }

    request.tenantContext = {
      tenantId: membership.tenant.id,
      name: membership.tenant.name,
      slug: membership.tenant.slug,
      role: membership.role,
    };
  };
}

export function requireTenantRole(
  ...allowedRoles: MembershipRole[]
): preHandlerHookHandler {
  return async (request, reply) => {
    if (!request.tenantContext) {
      return reply.code(403).send({ error: 'Tenant context is required' });
    }

    if (!allowedRoles.includes(request.tenantContext.role)) {
      return reply.code(403).send({ error: 'Insufficient tenant permissions' });
    }
  };
}

export const authRoutes: FastifyPluginAsync<AuthPluginOptions> = async (app, { db }) => {
  const authenticateUser = authenticate(db);
  const resolveTenant = requireTenant(db);

  app.post('/auth/register', {
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const parsed = registerSchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.code(400).send({
        error: 'Invalid registration details',
        details: parsed.error.flatten().fieldErrors,
      });
    }

    const input = parsed.data;

    try {
      const created = await db.$transaction(async (transaction) => {
        const user = await transaction.user.create({
          data: {
            email: input.email,
            passwordHash: await argon2.hash(input.password, {
              type: argon2.argon2id,
            }),
            ...(input.name ? { name: input.name } : {}),
          },
          select: { id: true, email: true, name: true },
        });

        const tenant = await transaction.tenant.create({
          data: {
            name: input.organizationName,
            slug: input.tenantSlug,
          },
          select: { id: true, name: true, slug: true },
        });

        const membership = await transaction.tenantMembership.create({
          data: {
            tenantId: tenant.id,
            userId: user.id,
            role: 'OWNER',
          },
          select: { role: true },
        });

        return { user, tenant, role: membership.role };
      });

      const tokens = await issueTokens(db, reply, created.user.id);

      return reply.code(201).send({
        user: created.user,
        tenant: { ...created.tenant, role: created.role },
        tokens,
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        return reply.code(409).send({
          error: 'The email address or tenant slug is already in use',
        });
      }

      throw error;
    }
  });

  app.post('/auth/login', {
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid login details' });
    }

    const user = await db.user.findUnique({
      where: { email: parsed.data.email },
      include: {
        memberships: {
          include: {
            tenant: {
              select: { id: true, name: true, slug: true, status: true },
            },
          },
        },
      },
    });

    if (
      !user ||
      user.status !== 'ACTIVE' ||
      !(await argon2.verify(user.passwordHash, parsed.data.password))
    ) {
      return reply.code(401).send({ error: 'Invalid email or password' });
    }

    const memberships = user.memberships
      .filter((membership) => membership.tenant.status === 'ACTIVE')
      .map((membership) => ({
        id: membership.tenant.id,
        name: membership.tenant.name,
        slug: membership.tenant.slug,
        role: membership.role,
      }));

    const tokens = await issueTokens(db, reply, user.id);

    return reply.send({
      user: { id: user.id, email: user.email, name: user.name },
      tenants: memberships,
      tokens,
    });
  });

  app.post('/auth/refresh', async (request, reply) => {
    const parsed = refreshSchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.code(400).send({ error: 'A valid refresh token is required' });
    }

    const now = new Date();
    const tokenHash = sha256(parsed.data.refreshToken);
    const session = await db.authSession.findUnique({
      where: { tokenHash },
      include: {
        user: {
          select: { id: true, status: true },
        },
      },
    });

    if (
      !session ||
      session.revokedAt ||
      session.expiresAt <= now ||
      session.user.status !== 'ACTIVE'
    ) {
      return reply.code(401).send({ error: 'Invalid or expired refresh token' });
    }

    const nextRefreshToken = createRefreshToken();
    const nextExpiry = sessionExpiry();
    const rotated = await db.authSession.updateMany({
      where: {
        id: session.id,
        tokenHash,
        revokedAt: null,
        expiresAt: { gt: now },
      },
      data: {
        tokenHash: sha256(nextRefreshToken),
        expiresAt: nextExpiry,
        lastUsedAt: now,
      },
    });

    if (rotated.count !== 1) {
      return reply.code(401).send({ error: 'Refresh token has already been used' });
    }

    const accessToken = await reply.jwtSign(
      { sub: session.user.id, sid: session.id },
      { expiresIn: ACCESS_TOKEN_TTL },
    );

    return reply.send({
      tokenType: 'Bearer',
      accessToken,
      accessTokenExpiresIn: ACCESS_TOKEN_TTL,
      refreshToken: nextRefreshToken,
      refreshTokenExpiresAt: nextExpiry.toISOString(),
    });
  });

  app.post('/auth/logout', async (request, reply) => {
    const parsed = refreshSchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.code(400).send({ error: 'A valid refresh token is required' });
    }

    await db.authSession.updateMany({
      where: {
        tokenHash: sha256(parsed.data.refreshToken),
        revokedAt: null,
      },
      data: { revokedAt: new Date() },
    });

    return reply.code(204).send();
  });

  app.get('/auth/me', { preHandler: authenticateUser }, async (request, reply) => {
    const user = await db.user.findUnique({
      where: { id: request.authContext!.userId },
      select: {
        id: true,
        email: true,
        name: true,
        emailVerifiedAt: true,
        memberships: {
          where: { tenant: { is: { status: 'ACTIVE' } } },
          include: {
            tenant: {
              select: { id: true, name: true, slug: true },
            },
          },
        },
      },
    });

    if (!user) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }

    return {
      id: user.id,
      email: user.email,
      name: user.name,
      emailVerifiedAt: user.emailVerifiedAt,
      tenants: user.memberships.map((membership) => ({
        ...membership.tenant,
        role: membership.role,
      })),
    };
  });

  app.get('/auth/tenants', { preHandler: authenticateUser }, async (request) => {
    const memberships = await db.tenantMembership.findMany({
      where: {
        userId: request.authContext!.userId,
        tenant: { is: { status: 'ACTIVE' } },
      },
      include: {
        tenant: {
          select: { id: true, name: true, slug: true },
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    return {
      tenants: memberships.map((membership) => ({
        ...membership.tenant,
        role: membership.role,
      })),
    };
  });

  app.get(
    '/tenant/context',
    { preHandler: [authenticateUser, resolveTenant] },
    async (request) => ({ tenant: request.tenantContext }),
  );
};
