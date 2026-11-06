import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@hostbilling/database';
import { buildApp } from '../src/app.js';

const database = {
  authSession: {
    findFirst: vi.fn(),
  },
  user: {
    findFirst: vi.fn(),
  },
  tenantMembership: {
    findFirst: vi.fn(),
  },
} as unknown as PrismaClient;

describe('tenant authentication', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = buildApp({
      db: database,
      jwtSecret: 'test-secret-with-at-least-32-random-bytes',
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
      headers: { 'x-tenant-id': 'tenant-1' },
    });

    expect(response.statusCode).toBe(401);
  });

  it('resolves tenant context only through an active membership', async () => {
    vi.mocked(database.authSession.findFirst).mockResolvedValue({ id: 'session-1' } as never);
    vi.mocked(database.user.findFirst).mockResolvedValue({ id: 'user-1' } as never);
    vi.mocked(database.tenantMembership.findFirst).mockResolvedValue({
      role: 'OWNER',
      tenant: {
        id: 'tenant-1',
        name: 'Example Hosting',
        slug: 'example-hosting',
      },
    } as never);

    const accessToken = app.jwt.sign({
      sub: 'user-1',
      sid: 'session-1',
    });

    const response = await app.inject({
      method: 'GET',
      url: '/tenant/context',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'x-tenant-id': 'tenant-1',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      tenant: {
        tenantId: 'tenant-1',
        name: 'Example Hosting',
        slug: 'example-hosting',
        role: 'OWNER',
      },
    });
    expect(database.tenantMembership.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: 'tenant-1',
          userId: 'user-1',
        }),
      }),
    );
  });

  it('denies a user who is not a member of the requested tenant', async () => {
    vi.mocked(database.authSession.findFirst).mockResolvedValue({ id: 'session-1' } as never);
    vi.mocked(database.user.findFirst).mockResolvedValue({ id: 'user-1' } as never);
    vi.mocked(database.tenantMembership.findFirst).mockResolvedValue(null);

    const accessToken = app.jwt.sign({
      sub: 'user-1',
      sid: 'session-1',
    });

    const response = await app.inject({
      method: 'GET',
      url: '/tenant/context',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'x-tenant-id': 'tenant-not-owned',
      },
    });

    expect(response.statusCode).toBe(403);
  });
});
