import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@hostbilling/database';
import { buildApp } from '../src/app.js';

const tenantId = '00000000-0000-4000-8000-000000000001';
const customerId = '00000000-0000-4000-8000-0000000000c1';
const planId = '00000000-0000-4000-8000-0000000000a1';
const subscriptionId = '00000000-0000-4000-8000-0000000000b1';
const otherTenantSubscriptionId = '00000000-0000-4000-8000-000000000099';

const databaseMock = {
  authSession: { findFirst: vi.fn() },
  user: { findFirst: vi.fn() },
  tenantMembership: { findFirst: vi.fn() },
  hostingPlan: { findFirst: vi.fn() },
  customer: { findFirst: vi.fn() },
  subscription: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    count: vi.fn(),
    create: vi.fn(),
    updateMany: vi.fn(),
  },
};

const database = databaseMock as unknown as PrismaClient;
const jwtSecret = 'test-secret-with-at-least-32-random-bytes';

const activePlan = {
  id: planId,
  status: 'ACTIVE',
  priceMinorUnits: 125000,
  setupFeeMinorUnits: 5000,
  currency: 'NPR',
  billingInterval: 'YEAR',
  intervalCount: 1,
};

describe('tenant subscriptions', () => {
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
    databaseMock.customer.findFirst.mockResolvedValue({ id: customerId, status: 'ACTIVE' });
    databaseMock.hostingPlan.findFirst.mockResolvedValue(activePlan);
  });

  afterAll(async () => {
    await app.close();
  });

  function headers() {
    return {
      authorization: `Bearer ${app.jwt.sign({ sub: 'user-1', sid: 'session-1' })}`,
      'x-tenant-id': tenantId,
    };
  }

  it('lists subscriptions scoped to the tenant with pagination', async () => {
    databaseMock.subscription.findMany.mockResolvedValue([]);
    databaseMock.subscription.count.mockResolvedValue(0);

    const response = await app.inject({
      method: 'GET',
      url: `/tenant/subscriptions?status=ACTIVE&customerId=${customerId}&page=2&pageSize=10`,
      headers: headers(),
    });

    expect(response.statusCode).toBe(200);
    expect(databaseMock.subscription.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId, status: 'ACTIVE', customerId },
        skip: 10,
        take: 10,
      }),
    );
    expect(databaseMock.subscription.count).toHaveBeenCalledWith({
      where: { tenantId, status: 'ACTIVE', customerId },
    });
  });

  it('rejects invalid list filters', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/tenant/subscriptions?status=BOGUS',
      headers: headers(),
    });

    expect(response.statusCode).toBe(400);
  });

  it('returns 404 for a subscription in another tenant', async () => {
    databaseMock.subscription.findFirst.mockResolvedValue(null);

    const response = await app.inject({
      method: 'GET',
      url: `/tenant/subscriptions/${otherTenantSubscriptionId}`,
      headers: headers(),
    });

    expect(response.statusCode).toBe(404);
    expect(databaseMock.subscription.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: otherTenantSubscriptionId, tenantId } }),
    );
  });

  it('creates a pending subscription with pricing copied from the plan', async () => {
    databaseMock.subscription.create.mockImplementation(async ({ data }) => ({
      id: subscriptionId,
      ...data,
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/tenant/subscriptions',
      headers: headers(),
      payload: { customerId, planId },
    });

    expect(response.statusCode).toBe(201);
    expect(databaseMock.customer.findFirst).toHaveBeenCalledWith({
      where: { id: customerId, tenantId },
    });
    expect(databaseMock.hostingPlan.findFirst).toHaveBeenCalledWith({
      where: { id: planId, tenantId },
    });
    expect(databaseMock.subscription.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tenantId,
          customerId,
          planId,
          status: 'PENDING',
          priceMinorUnits: 125000,
          setupFeeMinorUnits: 5000,
          currency: 'NPR',
          billingInterval: 'YEAR',
          intervalCount: 1,
        }),
      }),
    );
    const data = databaseMock.subscription.create.mock.calls[0]![0].data;
    expect(data.currentPeriodEnd).toBeUndefined();
  });

  it('starts the first billing period when created with activate', async () => {
    databaseMock.subscription.create.mockImplementation(async ({ data }) => ({
      id: subscriptionId,
      ...data,
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/tenant/subscriptions',
      headers: headers(),
      payload: { customerId, planId, activate: true },
    });

    expect(response.statusCode).toBe(201);
    const data = databaseMock.subscription.create.mock.calls[0]![0].data;
    expect(data.status).toBe('ACTIVE');
    expect(data.currentPeriodEnd.getTime()).toBeGreaterThan(data.currentPeriodStart.getTime());
  });

  it('does not accept a tenant ID or pricing from the request body', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/tenant/subscriptions',
      headers: headers(),
      payload: { customerId, planId, tenantId: 'other', priceMinorUnits: 1 },
    });

    expect(response.statusCode).toBe(400);
    expect(databaseMock.subscription.create).not.toHaveBeenCalled();
  });

  it('returns 404 when the customer or plan belongs to another tenant', async () => {
    databaseMock.customer.findFirst.mockResolvedValue(null);
    const missingCustomer = await app.inject({
      method: 'POST',
      url: '/tenant/subscriptions',
      headers: headers(),
      payload: { customerId, planId },
    });
    expect(missingCustomer.statusCode).toBe(404);

    databaseMock.customer.findFirst.mockResolvedValue({ id: customerId, status: 'ACTIVE' });
    databaseMock.hostingPlan.findFirst.mockResolvedValue(null);
    const missingPlan = await app.inject({
      method: 'POST',
      url: '/tenant/subscriptions',
      headers: headers(),
      payload: { customerId, planId },
    });
    expect(missingPlan.statusCode).toBe(404);
    expect(databaseMock.subscription.create).not.toHaveBeenCalled();
  });

  it('refuses inactive customers and non-active plans', async () => {
    databaseMock.customer.findFirst.mockResolvedValue({ id: customerId, status: 'INACTIVE' });
    const inactiveCustomer = await app.inject({
      method: 'POST',
      url: '/tenant/subscriptions',
      headers: headers(),
      payload: { customerId, planId },
    });
    expect(inactiveCustomer.statusCode).toBe(409);

    databaseMock.customer.findFirst.mockResolvedValue({ id: customerId, status: 'ACTIVE' });
    databaseMock.hostingPlan.findFirst.mockResolvedValue({ ...activePlan, status: 'DRAFT' });
    const draftPlan = await app.inject({
      method: 'POST',
      url: '/tenant/subscriptions',
      headers: headers(),
      payload: { customerId, planId },
    });
    expect(draftPlan.statusCode).toBe(409);
    expect(databaseMock.subscription.create).not.toHaveBeenCalled();
  });

  it('only lets OWNER or ADMIN manage subscriptions', async () => {
    databaseMock.tenantMembership.findFirst.mockResolvedValue({
      role: 'SUPPORT',
      tenant: { id: tenantId, name: 'Example Hosting', slug: 'example-hosting' },
    });

    const create = await app.inject({
      method: 'POST',
      url: '/tenant/subscriptions',
      headers: headers(),
      payload: { customerId, planId },
    });
    const suspend = await app.inject({
      method: 'POST',
      url: `/tenant/subscriptions/${subscriptionId}/suspend`,
      headers: headers(),
    });

    expect(create.statusCode).toBe(403);
    expect(suspend.statusCode).toBe(403);
  });

  it('requires authentication', async () => {
    const response = await app.inject({ method: 'GET', url: '/tenant/subscriptions' });
    expect(response.statusCode).toBe(401);
  });

  it('activates a pending subscription and starts its first period', async () => {
    databaseMock.subscription.findFirst
      .mockResolvedValueOnce({
        id: subscriptionId,
        status: 'PENDING',
        startedAt: null,
        billingInterval: 'MONTH',
        intervalCount: 1,
      })
      .mockResolvedValueOnce({ id: subscriptionId, status: 'ACTIVE' });
    databaseMock.subscription.updateMany.mockResolvedValue({ count: 1 });

    const response = await app.inject({
      method: 'POST',
      url: `/tenant/subscriptions/${subscriptionId}/activate`,
      headers: headers(),
    });

    expect(response.statusCode).toBe(200);
    const call = databaseMock.subscription.updateMany.mock.calls[0]![0];
    expect(call.where).toEqual({ id: subscriptionId, tenantId, status: 'PENDING' });
    expect(call.data.status).toBe('ACTIVE');
    expect(call.data.currentPeriodEnd.getTime()).toBeGreaterThan(
      call.data.currentPeriodStart.getTime(),
    );
  });

  it('keeps the existing billing period when reactivating a suspended subscription', async () => {
    databaseMock.subscription.findFirst
      .mockResolvedValueOnce({
        id: subscriptionId,
        status: 'SUSPENDED',
        startedAt: new Date('2026-01-01T00:00:00.000Z'),
        billingInterval: 'MONTH',
        intervalCount: 1,
      })
      .mockResolvedValueOnce({ id: subscriptionId, status: 'ACTIVE' });
    databaseMock.subscription.updateMany.mockResolvedValue({ count: 1 });

    const response = await app.inject({
      method: 'POST',
      url: `/tenant/subscriptions/${subscriptionId}/activate`,
      headers: headers(),
    });

    expect(response.statusCode).toBe(200);
    const data = databaseMock.subscription.updateMany.mock.calls[0]![0].data;
    expect(data).toEqual({ status: 'ACTIVE', suspendedAt: null });
  });

  it('suspends and cancels with timestamps', async () => {
    databaseMock.subscription.updateMany.mockResolvedValue({ count: 1 });

    databaseMock.subscription.findFirst
      .mockResolvedValueOnce({ id: subscriptionId, status: 'ACTIVE', startedAt: new Date() })
      .mockResolvedValueOnce({ id: subscriptionId, status: 'SUSPENDED' });
    const suspend = await app.inject({
      method: 'POST',
      url: `/tenant/subscriptions/${subscriptionId}/suspend`,
      headers: headers(),
    });
    expect(suspend.statusCode).toBe(200);
    expect(databaseMock.subscription.updateMany.mock.calls[0]![0].data.suspendedAt).toBeInstanceOf(
      Date,
    );

    databaseMock.subscription.findFirst
      .mockResolvedValueOnce({ id: subscriptionId, status: 'SUSPENDED', startedAt: new Date() })
      .mockResolvedValueOnce({ id: subscriptionId, status: 'CANCELLED' });
    const cancel = await app.inject({
      method: 'POST',
      url: `/tenant/subscriptions/${subscriptionId}/cancel`,
      headers: headers(),
    });
    expect(cancel.statusCode).toBe(200);
    expect(databaseMock.subscription.updateMany.mock.calls[1]![0].data.cancelledAt).toBeInstanceOf(
      Date,
    );
  });

  it('rejects invalid transitions and cancelled subscriptions stay cancelled', async () => {
    databaseMock.subscription.findFirst.mockResolvedValue({
      id: subscriptionId,
      status: 'CANCELLED',
      startedAt: new Date(),
    });

    for (const action of ['activate', 'suspend', 'cancel']) {
      const response = await app.inject({
        method: 'POST',
        url: `/tenant/subscriptions/${subscriptionId}/${action}`,
        headers: headers(),
      });
      expect(response.statusCode).toBe(409);
    }
    expect(databaseMock.subscription.updateMany).not.toHaveBeenCalled();
  });

  it('returns 404 when transitioning a subscription from another tenant', async () => {
    databaseMock.subscription.findFirst.mockResolvedValue(null);

    const response = await app.inject({
      method: 'POST',
      url: `/tenant/subscriptions/${otherTenantSubscriptionId}/cancel`,
      headers: headers(),
    });

    expect(response.statusCode).toBe(404);
    expect(databaseMock.subscription.updateMany).not.toHaveBeenCalled();
  });

  it('reports a conflict when the status changed concurrently', async () => {
    databaseMock.subscription.findFirst.mockResolvedValue({
      id: subscriptionId,
      status: 'ACTIVE',
      startedAt: new Date(),
    });
    databaseMock.subscription.updateMany.mockResolvedValue({ count: 0 });

    const response = await app.inject({
      method: 'POST',
      url: `/tenant/subscriptions/${subscriptionId}/suspend`,
      headers: headers(),
    });

    expect(response.statusCode).toBe(409);
  });
});
