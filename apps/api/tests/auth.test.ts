import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import argon2 from 'argon2';
import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@hostbilling/database';
import { buildApp } from '../src/app.js';

const databaseMock = {
  authSession: {
    findFirst: vi.fn(),
    create: vi.fn(),
    findUnique: vi.fn(),
    updateMany: vi.fn(),
  },
  user: {
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
  },
  tenant: {
    create: vi.fn(),
  },
  tenantMembership: {
    findFirst: vi.fn(),
    create: vi.fn(),
  },
  $transaction: vi.fn(),
};

const database = databaseMock as unknown as PrismaClient;
const transaction = {
  user: databaseMock.user,
  tenant: databaseMock.tenant,
  tenantMembership: databaseMock.tenantMembership,
};

databaseMock.$transaction.mockImplementation(
  async (callback: (tx: unknown) => Promise<unknown>) => callback(transaction),
);

const jwtSecret = 'test-secret-with-at-least-32-random-bytes';
const tenantId = '00000000-0000-4000-8000-000000000001';

describe('tenant authentication', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = buildApp({
      db: database,
      jwtSecret,
    });
    await app.ready();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await app.close();
  });

  it('rejects requests without an access token', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/tenant/context',
      headers: { 'x-tenant-id': tenantId },
    });

    expect(response.statusCode).toBe(401);
  });

  it('resolves tenant context only through an active membership', async () => {
    databaseMock.authSession.findFirst.mockResolvedValue({ id: 'session-1' });
    databaseMock.user.findFirst.mockResolvedValue({ id: 'user-1' });
    databaseMock.tenantMembership.findFirst.mockResolvedValue({
      role: 'OWNER',
      tenant: {
        id: tenantId,
        name: 'Example Hosting',
        slug: 'example-hosting',
      },
    });

    const accessToken = app.jwt.sign({ sub: 'user-1', sid: 'session-1' });
    const response = await app.inject({
      method: 'GET',
      url: '/tenant/context',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'x-tenant-id': tenantId,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      tenant: {
        tenantId,
        name: 'Example Hosting',
        slug: 'example-hosting',
        role: 'OWNER',
      },
    });
    expect(databaseMock.tenantMembership.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId, userId: 'user-1' }),
      }),
    );
  });

  it('denies a user who is not a member of the requested tenant', async () => {
    databaseMock.authSession.findFirst.mockResolvedValue({ id: 'session-1' });
    databaseMock.user.findFirst.mockResolvedValue({ id: 'user-1' });
    databaseMock.tenantMembership.findFirst.mockResolvedValue(null);

    const accessToken = app.jwt.sign({ sub: 'user-1', sid: 'session-1' });
    const response = await app.inject({
      method: 'GET',
      url: '/tenant/context',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'x-tenant-id': '00000000-0000-4000-8000-000000000002',
      },
    });

    expect(response.statusCode).toBe(403);
  });

  it('registers a user, tenant, OWNER membership, and refresh session', async () => {
    databaseMock.user.create.mockResolvedValue({
      id: 'user-1',
      email: 'owner@example.com',
      name: 'Owner',
    });
    databaseMock.tenant.create.mockResolvedValue({
      id: tenantId,
      name: 'Example Hosting',
      slug: 'example-hosting',
    });
    databaseMock.tenantMembership.create.mockResolvedValue({ role: 'OWNER' });
    databaseMock.authSession.create.mockResolvedValue({ id: 'session-1' });

    const response = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: {
        organizationName: 'Example Hosting',
        tenantSlug: 'example-hosting',
        email: ' OWNER@EXAMPLE.COM ',
        password: 'correct-horse-battery-staple',
        name: 'Owner',
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().user.email).toBe('owner@example.com');
    expect(response.json().tenant.role).toBe('OWNER');
    expect(response.json().tokens.accessToken).toEqual(expect.any(String));
    expect(response.json().tokens.refreshToken).toEqual(expect.any(String));
    expect(databaseMock.user.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          email: 'owner@example.com',
          passwordHash: expect.any(String),
        }),
      }),
    );
    expect(databaseMock.tenantMembership.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { tenantId, userId: 'user-1', role: 'OWNER' },
      }),
    );
    expect(databaseMock.authSession.create).toHaveBeenCalledOnce();
  });

  it('rejects registration with a weak password', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: {
        organizationName: 'Example Hosting',
        tenantSlug: 'example-hosting',
        email: 'owner@example.com',
        password: 'short',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(databaseMock.$transaction).not.toHaveBeenCalled();
  });

  it('authenticates a user and creates a refresh session', async () => {
    const passwordHash = await argon2.hash('correct-horse-battery-staple', {
      type: argon2.argon2id,
    });
    databaseMock.user.findUnique.mockResolvedValue({
      id: 'user-1',
      email: 'owner@example.com',
      name: 'Owner',
      passwordHash,
      status: 'ACTIVE',
      memberships: [
        {
          role: 'OWNER',
          tenant: {
            id: tenantId,
            name: 'Example Hosting',
            slug: 'example-hosting',
            status: 'ACTIVE',
          },
        },
      ],
    });
    databaseMock.authSession.create.mockResolvedValue({ id: 'session-1' });

    const response = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: {
        email: ' OWNER@EXAMPLE.COM ',
        password: 'correct-horse-battery-staple',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().user.id).toBe('user-1');
    expect(response.json().tenants).toHaveLength(1);
    expect(response.json().tokens.refreshToken).toEqual(expect.any(String));
    expect(databaseMock.authSession.create).toHaveBeenCalledOnce();
  });

  it('rejects invalid login credentials without creating a session', async () => {
    databaseMock.user.findUnique.mockResolvedValue(null);

    const response = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: {
        email: 'missing@example.com',
        password: 'incorrect-password',
      },
    });

    expect(response.statusCode).toBe(401);
    expect(databaseMock.authSession.create).not.toHaveBeenCalled();
  });

  it('rotates a valid refresh token and issues a new access token', async () => {
    const oldRefreshToken = 'r'.repeat(48);
    databaseMock.authSession.findUnique.mockResolvedValue({
      id: 'session-1',
      userId: 'user-1',
      tokenHash: 'stored-hash',
      revokedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
      user: { id: 'user-1', status: 'ACTIVE' },
    });
    databaseMock.authSession.updateMany.mockResolvedValue({ count: 1 });

    const response = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      payload: { refreshToken: oldRefreshToken },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().accessToken).toEqual(expect.any(String));
    expect(response.json().refreshToken).toEqual(expect.any(String));
    expect(response.json().refreshToken).not.toBe(oldRefreshToken);
    expect(databaseMock.authSession.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'session-1', revokedAt: null }),
        data: expect.objectContaining({ tokenHash: expect.any(String) }),
      }),
    );
  });

  it('rejects a refresh token when another request has already rotated it', async () => {
    databaseMock.authSession.findUnique.mockResolvedValue({
      id: 'session-1',
      userId: 'user-1',
      tokenHash: 'stored-hash',
      revokedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
      user: { id: 'user-1', status: 'ACTIVE' },
    });
    databaseMock.authSession.updateMany.mockResolvedValue({ count: 0 });

    const response = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      payload: { refreshToken: 'r'.repeat(48) },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().error).toContain('already been used');
  });

  it('revokes a refresh-token session on logout', async () => {
    databaseMock.authSession.updateMany.mockResolvedValue({ count: 1 });

    const response = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      payload: { refreshToken: 'r'.repeat(48) },
    });

    expect(response.statusCode).toBe(204);
    expect(databaseMock.authSession.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tokenHash: expect.any(String),
          revokedAt: null,
        }),
        data: expect.objectContaining({ revokedAt: expect.any(Date) }),
      }),
    );
  });
});
