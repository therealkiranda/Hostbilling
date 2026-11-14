import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@hostbilling/database';
import { buildApp } from '../src/app.js';

const tenantId = '00000000-0000-4000-8000-000000000001';
const customerId = '00000000-0000-4000-8000-0000000000c1';
const subscriptionId = '00000000-0000-4000-8000-0000000000b1';
const otherTenantSubscriptionId = '00000000-0000-4000-8000-000000000099';

const databaseMock = {
  authSession: { findFirst: vi.fn() },
  user: { findFirst: vi.fn() },
  tenantMembership: { findFirst: vi.fn() },
  tenant: { update: vi.fn() },
  subscription: { findFirst: vi.fn(), updateMany: vi.fn() },
  invoice: { findFirst: vi.fn(), create: vi.fn() },
  $transaction: vi.fn(),
};

const database = databaseMock as unknown as PrismaClient;
const jwtSecret = 'test-secret-with-at-least-32-random-bytes';

// A subscription that started on 31 January and is renewing from its first period.
const startedAt = new Date('2026-01-31T00:00:00.000Z');
const firstPeriodEnd = new Date('2026-02-28T00:00:00.000Z');

function activeSubscription(overrides: Record<string, unknown> = {}) {
  return {
    id: subscriptionId,
    customerId,
    status: 'ACTIVE',
    priceMinorUnits: 125000,
    setupFeeMinorUnits: 5000,
    currency: 'NPR',
    billingInterval: 'MONTH',
    intervalCount: 1,
    billedPeriods: 1,
    startedAt,
    currentPeriodStart: startedAt,
    currentPeriodEnd: firstPeriodEnd,
    plan: { name: 'Starter' },
    ...overrides,
  };
}

function membership(role: string) {
  return {
    role,
    tenant: { id: tenantId, name: 'Example Hosting', slug: 'example-hosting' },
  };
}

describe('tenant subscription renewals', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = buildApp({ db: database, jwtSecret });
    await app.ready();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    // Only the clock is faked, so renewal windows are tested against fixed dates.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-02-20T00:00:00.000Z'));

    databaseMock.authSession.findFirst.mockResolvedValue({ id: 'session-1' });
    databaseMock.user.findFirst.mockResolvedValue({ id: 'user-1' });
    databaseMock.tenantMembership.findFirst.mockResolvedValue(membership('OWNER'));
    databaseMock.$transaction.mockImplementation(async (callback) => callback(databaseMock));
    databaseMock.subscription.findFirst
      .mockResolvedValueOnce(activeSubscription())
      .mockResolvedValue({ id: subscriptionId, status: 'ACTIVE' });
    databaseMock.subscription.updateMany.mockResolvedValue({ count: 1 });
    // First lookup is the "current period is paid" check, second is the period-key check.
    databaseMock.invoice.findFirst
      .mockResolvedValueOnce({ id: 'paid-invoice' })
      .mockResolvedValue(null);
    databaseMock.tenant.update.mockResolvedValue({ invoiceCounter: 2 });
    databaseMock.invoice.create.mockImplementation(async ({ data }) => ({
      id: 'invoice-2',
      ...data,
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
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

  function renew(payload?: Record<string, unknown>, id = subscriptionId) {
    return app.inject({
      method: 'POST',
      url: `/tenant/subscriptions/${id}/renew`,
      headers: headers(),
      ...(payload ? { payload } : {}),
    });
  }

  it('advances to the next period and issues its invoice', async () => {
    const response = await renew();

    expect(response.statusCode).toBe(201);
    expect(databaseMock.subscription.findFirst).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ where: { id: subscriptionId, tenantId } }),
    );
    expect(databaseMock.invoice.findFirst).toHaveBeenNthCalledWith(1, {
      where: { tenantId, subscriptionId, periodStart: startedAt, status: 'PAID' },
      select: { id: true },
    });
    expect(databaseMock.subscription.updateMany).toHaveBeenCalledWith({
      where: { id: subscriptionId, tenantId, status: 'ACTIVE', billedPeriods: 1 },
      data: {
        currentPeriodStart: firstPeriodEnd,
        currentPeriodEnd: new Date('2026-03-31T00:00:00.000Z'),
        billedPeriods: { increment: 1 },
      },
    });

    const { data } = databaseMock.invoice.create.mock.calls[0]![0];
    expect(data).toMatchObject({
      tenantId,
      customerId,
      subscriptionId,
      number: 'INV-000002',
      totalMinorUnits: 125000,
      periodStart: firstPeriodEnd,
      periodEnd: new Date('2026-03-31T00:00:00.000Z'),
      periodKey: `${subscriptionId}:${firstPeriodEnd.toISOString()}`,
    });
    // The setup fee is only billed on the first period.
    expect(data.lineItems.create).toHaveLength(1);
  });

  it('measures every period from the original start so month ends do not drift', async () => {
    // 31 January + 2 months is 31 March, not 28 March from chaining off 28 February.
    await renew();

    const { data } = databaseMock.subscription.updateMany.mock.calls[0]![0];
    expect(data.currentPeriodEnd).toEqual(new Date('2026-03-31T00:00:00.000Z'));
  });

  it('refuses to renew before the renewal window opens', async () => {
    vi.setSystemTime(new Date('2026-02-01T00:00:00.000Z'));

    const response = await renew();

    expect(response.statusCode).toBe(409);
    expect(databaseMock.subscription.updateMany).not.toHaveBeenCalled();
    expect(databaseMock.invoice.create).not.toHaveBeenCalled();
  });

  it('refuses to renew while the current period is unpaid', async () => {
    databaseMock.invoice.findFirst.mockReset();
    databaseMock.invoice.findFirst.mockResolvedValue(null);

    const response = await renew();

    expect(response.statusCode).toBe(409);
    expect(databaseMock.subscription.updateMany).not.toHaveBeenCalled();
    expect(databaseMock.invoice.create).not.toHaveBeenCalled();
  });

  it('only renews active subscriptions with a running period', async () => {
    for (const status of ['PENDING', 'SUSPENDED', 'CANCELLED']) {
      databaseMock.subscription.findFirst.mockReset();
      databaseMock.subscription.findFirst.mockResolvedValue(activeSubscription({ status }));
      expect((await renew()).statusCode).toBe(409);
    }

    databaseMock.subscription.findFirst.mockReset();
    databaseMock.subscription.findFirst.mockResolvedValue(
      activeSubscription({ currentPeriodStart: null, currentPeriodEnd: null, startedAt: null }),
    );
    expect((await renew()).statusCode).toBe(409);
    expect(databaseMock.subscription.updateMany).not.toHaveBeenCalled();
  });

  it('returns 404 for a subscription in another tenant', async () => {
    databaseMock.subscription.findFirst.mockReset();
    databaseMock.subscription.findFirst.mockResolvedValue(null);

    const response = await renew(undefined, otherTenantSubscriptionId);

    expect(response.statusCode).toBe(404);
    expect(databaseMock.subscription.updateMany).not.toHaveBeenCalled();
  });

  it('does not accept dates, amounts, or tenant IDs from the request', async () => {
    for (const extra of [
      { currentPeriodEnd: '2030-01-01T00:00:00.000Z' },
      { totalMinorUnits: 1 },
      { tenantId: 'other' },
    ]) {
      expect((await renew(extra)).statusCode).toBe(400);
    }
    expect((await renew({ dueInDays: 91 })).statusCode).toBe(400);
    expect(databaseMock.subscription.updateMany).not.toHaveBeenCalled();
  });

  it('reports a conflict when another renewal advanced the subscription first', async () => {
    databaseMock.subscription.updateMany.mockResolvedValue({ count: 0 });

    expect((await renew()).statusCode).toBe(409);
  });

  it('reports a conflict when the next period already has a live invoice', async () => {
    databaseMock.invoice.findFirst.mockReset();
    databaseMock.invoice.findFirst
      .mockResolvedValueOnce({ id: 'paid-invoice' })
      .mockResolvedValue({ id: 'existing-next-invoice' });

    const response = await renew();

    expect(response.statusCode).toBe(409);
    expect(databaseMock.invoice.create).not.toHaveBeenCalled();
  });

  it('maps a database uniqueness race to a conflict', async () => {
    databaseMock.invoice.create.mockRejectedValue(
      Object.assign(new Error('unique'), { code: 'P2002' }),
    );

    expect((await renew()).statusCode).toBe(409);
  });

  it('refuses totals that do not fit in the database column', async () => {
    databaseMock.subscription.findFirst.mockReset();
    databaseMock.subscription.findFirst.mockResolvedValue(
      activeSubscription({ priceMinorUnits: 2_147_483_647 + 1 }),
    );

    const response = await renew();

    expect(response.statusCode).toBe(422);
    expect(databaseMock.subscription.updateMany).not.toHaveBeenCalled();
  });

  it('lets BILLING renew but not SUPPORT', async () => {
    databaseMock.tenantMembership.findFirst.mockResolvedValue(membership('BILLING'));
    expect((await renew()).statusCode).toBe(201);

    databaseMock.tenantMembership.findFirst.mockResolvedValue(membership('SUPPORT'));
    expect((await renew()).statusCode).toBe(403);
  });

  it('requires authentication', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/tenant/subscriptions/${subscriptionId}/renew`,
    });
    expect(response.statusCode).toBe(401);
  });
});
