import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@hostbilling/database';
import { buildApp } from '../src/app.js';

const tenantId = '00000000-0000-4000-8000-000000000001';
const otherTenantPlanId = '00000000-0000-4000-8000-000000000099';

const databaseMock = {
  authSession: { findFirst: vi.fn() },
  user: { findFirst: vi.fn() },
  tenantMembership: { findFirst: vi.fn() },
  hostingPlan: {
    findMany: vi.fn(),
    create: vi.fn(),
    updateMany: vi.fn(),
    findFirst: vi.fn(),
  },
};

const database = databaseMock as unknown as PrismaClient;
const jwtSecret = 'test-secret-with-at-least-32-random-bytes';

const planPayload = {
  slug: 'starter',
  name: 'Starter',
  description: 'Entry-level shared hosting',
  priceMinorUnits: 125000,
  setupFeeMinorUnits: 0,
  currency: 'NPR',
  billingInterval: 'YEAR',
  intervalCount: 1,
  diskQuotaMb: 10240,
  bandwidthQuotaMb: 102400,
  maxDomains: 1,
  maxEmailAccounts: 10,
  maxDatabases: 2,
  maxFtpAccounts: 2,
};

describe('tenant hosting plans', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = buildApp({ db: database, jwtSecret });
    await app.ready();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    databaseMock.authSession.findFirst.mockResolvedValue({ id: 'session-1' });
    databaseMock.user.findFirst.mockResolvedValue({ id: 'user-1' });
    databaseMock.tenantMembership.findFirst.mockResolvedValue({
      role: 'OWNER',
      tenant: { id: tenantId, name: 'Example Hosting', slug: 'example-hosting' },
    });
  });

  afterAll(async () => {
    await app.close();
  });

  function token(): string {
    return app.jwt.sign({ sub: 'user-1', sid: 'session-1' });
  }

  function headers(accessToken = token()) {
    return {
      authorization: `Bearer ${accessToken}`,
      'x-tenant-id': tenantId,
    };
  }

  it('lists only plans scoped to the authenticated tenant', async () => {
    databaseMock.hostingPlan.findMany.mockResolvedValue([]);

    const response = await app.inject({
      method: 'GET',
      url: '/tenant/hosting-plans',
      headers: headers(),
    });

    expect(response.statusCode).toBe(200);
    expect(databaseMock.hostingPlan.findMany).toHaveBeenCalledWith({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
    });
  });

  it('rejects plan creation for a BILLING member', async () => {
    databaseMock.tenantMembership.findFirst.mockResolvedValue({
      role: 'BILLING',
      tenant: { id: tenantId, name: 'Example Hosting', slug: 'example-hosting' },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/tenant/hosting-plans',
      headers: headers(),
      payload: planPayload,
    });

    expect(response.statusCode).toBe(403);
    expect(databaseMock.hostingPlan.create).not.toHaveBeenCalled();
  });

  it('creates a plan using the resolved tenant instead of client input', async () => {
    databaseMock.hostingPlan.create.mockResolvedValue({ id: 'plan-1', ...planPayload });

    const response = await app.inject({
      method: 'POST',
      url: '/tenant/hosting-plans',
      headers: headers(),
      payload: planPayload,
    });

    expect(response.statusCode).toBe(201);
    expect(databaseMock.hostingPlan.create).toHaveBeenCalledWith({
      data: { ...planPayload, status: 'DRAFT', tenantId },
    });
  });

  it('rejects attempts to supply a tenant ID in the request body', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/tenant/hosting-plans',
      headers: headers(),
      payload: { ...planPayload, tenantId: '00000000-0000-4000-8000-000000000002' },
    });

    expect(response.statusCode).toBe(400);
    expect(databaseMock.hostingPlan.create).not.toHaveBeenCalled();
  });

  it('does not update a plan owned by another tenant', async () => {
    databaseMock.hostingPlan.updateMany.mockResolvedValue({ count: 0 });

    const response = await app.inject({
      method: 'PATCH',
      url: `/tenant/hosting-plans/${otherTenantPlanId}`,
      headers: headers(),
      payload: { name: 'Hijacked plan' },
    });

    expect(response.statusCode).toBe(404);
    expect(databaseMock.hostingPlan.updateMany).toHaveBeenCalledWith({
      where: { id: otherTenantPlanId, tenantId },
      data: { name: 'Hijacked plan' },
    });
    expect(databaseMock.hostingPlan.findFirst).not.toHaveBeenCalled();
  });
});
