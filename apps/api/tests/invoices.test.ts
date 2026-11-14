import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@hostbilling/database';
import { buildApp } from '../src/app.js';
import { formatInvoiceNumber } from '../src/invoices.js';

const tenantId = '00000000-0000-4000-8000-000000000001';
const customerId = '00000000-0000-4000-8000-0000000000c1';
const subscriptionId = '00000000-0000-4000-8000-0000000000b1';
const invoiceId = '00000000-0000-4000-8000-0000000000d1';
const otherTenantInvoiceId = '00000000-0000-4000-8000-000000000099';

const databaseMock = {
  authSession: { findFirst: vi.fn() },
  user: { findFirst: vi.fn() },
  tenantMembership: { findFirst: vi.fn() },
  tenant: { update: vi.fn() },
  subscription: { findFirst: vi.fn() },
  invoice: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    count: vi.fn(),
    create: vi.fn(),
    updateMany: vi.fn(),
  },
  $transaction: vi.fn(),
};

const database = databaseMock as unknown as PrismaClient;
const jwtSecret = 'test-secret-with-at-least-32-random-bytes';

const periodStart = new Date('2026-11-13T00:00:00.000Z');
const periodEnd = new Date('2027-11-13T00:00:00.000Z');

function activeSubscription(overrides: Record<string, unknown> = {}) {
  return {
    id: subscriptionId,
    customerId,
    status: 'ACTIVE',
    priceMinorUnits: 125000,
    setupFeeMinorUnits: 5000,
    currency: 'NPR',
    startedAt: periodStart,
    currentPeriodStart: periodStart,
    currentPeriodEnd: periodEnd,
    plan: { name: 'Starter' },
    ...overrides,
  };
}

describe('tenant invoices', () => {
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
    databaseMock.$transaction.mockImplementation(async (callback) => callback(databaseMock));
    databaseMock.subscription.findFirst.mockResolvedValue(activeSubscription());
    databaseMock.invoice.findFirst.mockResolvedValue(null);
    databaseMock.tenant.update.mockResolvedValue({ invoiceCounter: 7 });
    databaseMock.invoice.create.mockImplementation(async ({ data }) => ({
      id: invoiceId,
      ...data,
    }));
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

  function generate(payload?: Record<string, unknown>) {
    return app.inject({
      method: 'POST',
      url: `/tenant/subscriptions/${subscriptionId}/invoices`,
      headers: headers(),
      ...(payload ? { payload } : {}),
    });
  }

  it('formats sequential invoice numbers', () => {
    expect(formatInvoiceNumber(7)).toBe('INV-000007');
    expect(formatInvoiceNumber(1234567)).toBe('INV-1234567');
  });

  it('lists invoices scoped to the tenant with filters and pagination', async () => {
    databaseMock.invoice.findMany.mockResolvedValue([]);
    databaseMock.invoice.count.mockResolvedValue(0);

    const response = await app.inject({
      method: 'GET',
      url: `/tenant/invoices?status=OPEN&customerId=${customerId}&page=3&pageSize=5`,
      headers: headers(),
    });

    expect(response.statusCode).toBe(200);
    expect(databaseMock.invoice.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId, status: 'OPEN', customerId },
        skip: 10,
        take: 5,
      }),
    );
    expect(databaseMock.invoice.count).toHaveBeenCalledWith({
      where: { tenantId, status: 'OPEN', customerId },
    });
  });

  it('rejects invalid list filters', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/tenant/invoices?status=BOGUS',
      headers: headers(),
    });
    expect(response.statusCode).toBe(400);
  });

  it('returns 404 for an invoice in another tenant', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/tenant/invoices/${otherTenantInvoiceId}`,
      headers: headers(),
    });

    expect(response.statusCode).toBe(404);
    expect(databaseMock.invoice.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: otherTenantInvoiceId, tenantId } }),
    );
  });

  it('generates an invoice with the recurring charge and first-period setup fee', async () => {
    const response = await generate();

    expect(response.statusCode).toBe(201);
    expect(databaseMock.tenant.update).toHaveBeenCalledWith({
      where: { id: tenantId },
      data: { invoiceCounter: { increment: 1 } },
      select: { invoiceCounter: true },
    });

    const { data } = databaseMock.invoice.create.mock.calls[0]![0];
    expect(data).toMatchObject({
      tenantId,
      customerId,
      subscriptionId,
      number: 'INV-000007',
      currency: 'NPR',
      subtotalMinorUnits: 130000,
      totalMinorUnits: 130000,
      periodStart,
      periodEnd,
      periodKey: `${subscriptionId}:${periodStart.toISOString()}`,
    });
    expect(data.lineItems.create).toHaveLength(2);
    expect(data.lineItems.create[0]).toMatchObject({
      tenantId,
      description: 'Starter hosting (2026-11-13 to 2027-11-13)',
      amountMinorUnits: 125000,
    });
    expect(data.lineItems.create[1]).toMatchObject({
      description: 'Starter setup fee',
      amountMinorUnits: 5000,
    });
    expect(data.dueAt.getTime() - data.issuedAt.getTime()).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it('leaves the setup fee off invoices for later periods', async () => {
    databaseMock.subscription.findFirst.mockResolvedValue(
      activeSubscription({
        currentPeriodStart: periodEnd,
        currentPeriodEnd: new Date('2028-11-13T00:00:00.000Z'),
      }),
    );

    const response = await generate({ dueInDays: 14 });

    expect(response.statusCode).toBe(201);
    const { data } = databaseMock.invoice.create.mock.calls[0]![0];
    expect(data.totalMinorUnits).toBe(125000);
    expect(data.lineItems.create).toHaveLength(1);
    expect(data.dueAt.getTime() - data.issuedAt.getTime()).toBe(14 * 24 * 60 * 60 * 1000);
  });

  it('ignores amounts, tenant IDs, and unknown fields in the request body', async () => {
    const response = await generate({ totalMinorUnits: 1, tenantId: 'other' });

    expect(response.statusCode).toBe(400);
    expect(databaseMock.invoice.create).not.toHaveBeenCalled();
  });

  it('rejects out-of-range due dates', async () => {
    expect((await generate({ dueInDays: 91 })).statusCode).toBe(400);
    expect((await generate({ dueInDays: -1 })).statusCode).toBe(400);
  });

  it('refuses to invoice a period that already has a live invoice', async () => {
    databaseMock.invoice.findFirst.mockResolvedValue({ id: invoiceId });

    const response = await generate();

    expect(response.statusCode).toBe(409);
    expect(databaseMock.tenant.update).not.toHaveBeenCalled();
    expect(databaseMock.invoice.create).not.toHaveBeenCalled();
  });

  it('maps a database uniqueness race to a conflict', async () => {
    databaseMock.invoice.create.mockRejectedValue(
      Object.assign(new Error('unique'), { code: 'P2002' }),
    );

    const response = await generate();

    expect(response.statusCode).toBe(409);
  });

  it('only invoices active subscriptions', async () => {
    for (const status of ['PENDING', 'SUSPENDED', 'CANCELLED']) {
      databaseMock.subscription.findFirst.mockResolvedValue(activeSubscription({ status }));
      expect((await generate()).statusCode).toBe(409);
    }

    databaseMock.subscription.findFirst.mockResolvedValue(
      activeSubscription({ currentPeriodStart: null, currentPeriodEnd: null }),
    );
    expect((await generate()).statusCode).toBe(409);
    expect(databaseMock.invoice.create).not.toHaveBeenCalled();
  });

  it('returns 404 when the subscription belongs to another tenant', async () => {
    databaseMock.subscription.findFirst.mockResolvedValue(null);

    const response = await generate();

    expect(response.statusCode).toBe(404);
    expect(databaseMock.subscription.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: subscriptionId, tenantId } }),
    );
  });

  it('refuses totals that do not fit in the database column', async () => {
    databaseMock.subscription.findFirst.mockResolvedValue(
      activeSubscription({ priceMinorUnits: 2_000_000_000, setupFeeMinorUnits: 2_000_000_000 }),
    );

    const response = await generate();

    expect(response.statusCode).toBe(422);
    expect(databaseMock.invoice.create).not.toHaveBeenCalled();
  });

  it('allows BILLING members to generate invoices but not SUPPORT', async () => {
    databaseMock.tenantMembership.findFirst.mockResolvedValue({
      role: 'BILLING',
      tenant: { id: tenantId, name: 'Example Hosting', slug: 'example-hosting' },
    });
    expect((await generate()).statusCode).toBe(201);

    databaseMock.tenantMembership.findFirst.mockResolvedValue({
      role: 'SUPPORT',
      tenant: { id: tenantId, name: 'Example Hosting', slug: 'example-hosting' },
    });
    expect((await generate()).statusCode).toBe(403);
  });

  it('requires authentication', async () => {
    const response = await app.inject({ method: 'GET', url: '/tenant/invoices' });
    expect(response.statusCode).toBe(401);
  });

  it('voids an open invoice and releases its period key', async () => {
    databaseMock.invoice.findFirst
      .mockResolvedValueOnce({ status: 'OPEN' })
      .mockResolvedValueOnce({ id: invoiceId, status: 'VOID' });
    databaseMock.invoice.updateMany.mockResolvedValue({ count: 1 });

    const response = await app.inject({
      method: 'POST',
      url: `/tenant/invoices/${invoiceId}/void`,
      headers: headers(),
    });

    expect(response.statusCode).toBe(200);
    const call = databaseMock.invoice.updateMany.mock.calls[0]![0];
    expect(call.where).toEqual({ id: invoiceId, tenantId, status: 'OPEN' });
    expect(call.data.status).toBe('VOID');
    expect(call.data.voidedAt).toBeInstanceOf(Date);
    expect(call.data.periodKey).toBeNull();
  });

  it('cannot void paid or already voided invoices', async () => {
    for (const status of ['PAID', 'VOID']) {
      databaseMock.invoice.findFirst.mockResolvedValueOnce({ status });
      const response = await app.inject({
        method: 'POST',
        url: `/tenant/invoices/${invoiceId}/void`,
        headers: headers(),
      });
      expect(response.statusCode).toBe(409);
    }
    expect(databaseMock.invoice.updateMany).not.toHaveBeenCalled();
  });

  it('returns 404 when voiding an invoice from another tenant', async () => {
    databaseMock.invoice.findFirst.mockResolvedValue(null);

    const response = await app.inject({
      method: 'POST',
      url: `/tenant/invoices/${otherTenantInvoiceId}/void`,
      headers: headers(),
    });

    expect(response.statusCode).toBe(404);
    expect(databaseMock.invoice.updateMany).not.toHaveBeenCalled();
  });

  it('reports a conflict when the invoice changed during voiding', async () => {
    databaseMock.invoice.findFirst.mockResolvedValue({ status: 'OPEN' });
    databaseMock.invoice.updateMany.mockResolvedValue({ count: 0 });

    const response = await app.inject({
      method: 'POST',
      url: `/tenant/invoices/${invoiceId}/void`,
      headers: headers(),
    });

    expect(response.statusCode).toBe(409);
  });
});
