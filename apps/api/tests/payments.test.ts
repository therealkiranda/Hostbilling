import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@hostbilling/database';
import { buildApp } from '../src/app.js';

const tenantId = '00000000-0000-4000-8000-000000000001';
const customerId = '00000000-0000-4000-8000-0000000000c1';
const invoiceId = '00000000-0000-4000-8000-0000000000d1';
const paymentId = '00000000-0000-4000-8000-0000000000e1';
const otherTenantPaymentId = '00000000-0000-4000-8000-000000000099';

const databaseMock = {
  authSession: { findFirst: vi.fn() },
  user: { findFirst: vi.fn() },
  tenantMembership: { findFirst: vi.fn() },
  invoice: { findFirst: vi.fn(), updateMany: vi.fn() },
  payment: {
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

function openInvoice(overrides: Record<string, unknown> = {}) {
  return {
    id: invoiceId,
    customerId,
    status: 'OPEN',
    currency: 'NPR',
    totalMinorUnits: 130000,
    ...overrides,
  };
}

function completedPayment(overrides: Record<string, unknown> = {}) {
  return { id: paymentId, invoiceId, status: 'COMPLETED', ...overrides };
}

function membership(role: string) {
  return {
    role,
    tenant: { id: tenantId, name: 'Example Hosting', slug: 'example-hosting' },
  };
}

describe('tenant payments', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = buildApp({ db: database, jwtSecret });
    await app.ready();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    databaseMock.authSession.findFirst.mockResolvedValue({ id: 'session-1' });
    databaseMock.user.findFirst.mockResolvedValue({ id: 'user-1' });
    databaseMock.tenantMembership.findFirst.mockResolvedValue(membership('OWNER'));
    databaseMock.$transaction.mockImplementation(async (callback) => callback(databaseMock));
    databaseMock.invoice.findFirst.mockResolvedValue(openInvoice());
    databaseMock.invoice.updateMany.mockResolvedValue({ count: 1 });
    databaseMock.payment.create.mockImplementation(async ({ data }) => ({
      id: paymentId,
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

  function record(payload: Record<string, unknown> = { method: 'BANK_TRANSFER' }) {
    return app.inject({
      method: 'POST',
      url: `/tenant/invoices/${invoiceId}/payments`,
      headers: headers(),
      payload,
    });
  }

  function reverse(id = paymentId) {
    return app.inject({
      method: 'POST',
      url: `/tenant/payments/${id}/reverse`,
      headers: headers(),
    });
  }

  it('lists payments scoped to the tenant with filters and pagination', async () => {
    databaseMock.payment.findMany.mockResolvedValue([]);
    databaseMock.payment.count.mockResolvedValue(0);

    const response = await app.inject({
      method: 'GET',
      url: `/tenant/payments?status=COMPLETED&invoiceId=${invoiceId}&page=2&pageSize=10`,
      headers: headers(),
    });

    expect(response.statusCode).toBe(200);
    expect(databaseMock.payment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId, status: 'COMPLETED', invoiceId },
        skip: 10,
        take: 10,
      }),
    );
    expect(databaseMock.payment.count).toHaveBeenCalledWith({
      where: { tenantId, status: 'COMPLETED', invoiceId },
    });
  });

  it('rejects invalid list filters', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/tenant/payments?status=BOGUS',
      headers: headers(),
    });
    expect(response.statusCode).toBe(400);
  });

  it('returns 404 for a payment in another tenant', async () => {
    databaseMock.payment.findFirst.mockResolvedValue(null);

    const response = await app.inject({
      method: 'GET',
      url: `/tenant/payments/${otherTenantPaymentId}`,
      headers: headers(),
    });

    expect(response.statusCode).toBe(404);
    expect(databaseMock.payment.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: otherTenantPaymentId, tenantId } }),
    );
  });

  it('records a full payment, takes the amount from the invoice, and marks it paid', async () => {
    const response = await record({
      method: 'BANK_TRANSFER',
      reference: '  TXN-4821  ',
      note: 'Paid at the branch',
      paidAt: '2026-11-10T08:00:00.000Z',
    });

    expect(response.statusCode).toBe(201);
    expect(databaseMock.invoice.findFirst).toHaveBeenCalledWith({
      where: { id: invoiceId, tenantId },
    });
    expect(databaseMock.invoice.updateMany).toHaveBeenCalledWith({
      where: { id: invoiceId, tenantId, status: 'OPEN' },
      data: { status: 'PAID', paidAt: new Date('2026-11-10T08:00:00.000Z') },
    });
    expect(databaseMock.payment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          tenantId,
          invoiceId,
          customerId,
          method: 'BANK_TRANSFER',
          amountMinorUnits: 130000,
          currency: 'NPR',
          reference: 'TXN-4821',
          note: 'Paid at the branch',
          paidAt: new Date('2026-11-10T08:00:00.000Z'),
          activeKey: invoiceId,
          recordedByUserId: 'user-1',
        },
      }),
    );
  });

  it('defaults the payment date to now', async () => {
    const before = Date.now();
    const response = await record({ method: 'CASH' });

    expect(response.statusCode).toBe(201);
    const { data } = databaseMock.payment.create.mock.calls[0]![0];
    expect(data.paidAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(data.reference).toBeUndefined();
  });

  it('does not accept an amount, currency, tenant, or customer from the request', async () => {
    for (const extra of [
      { amountMinorUnits: 1 },
      { currency: 'USD' },
      { tenantId: 'other' },
      { customerId },
      { status: 'REVERSED' },
    ]) {
      expect((await record({ method: 'CASH', ...extra })).statusCode).toBe(400);
    }
    expect(databaseMock.payment.create).not.toHaveBeenCalled();
  });

  it('rejects unknown methods and future payment dates', async () => {
    expect((await record({ method: 'CRYPTO' })).statusCode).toBe(400);
    expect((await record({})).statusCode).toBe(400);

    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    expect((await record({ method: 'CASH', paidAt: future })).statusCode).toBe(400);
    expect((await record({ method: 'CASH', paidAt: 'yesterday' })).statusCode).toBe(400);
    expect(databaseMock.payment.create).not.toHaveBeenCalled();
  });

  it('only accepts payments for open invoices', async () => {
    for (const status of ['PAID', 'VOID']) {
      databaseMock.invoice.findFirst.mockResolvedValue(openInvoice({ status }));
      expect((await record()).statusCode).toBe(409);
    }
    expect(databaseMock.invoice.updateMany).not.toHaveBeenCalled();
    expect(databaseMock.payment.create).not.toHaveBeenCalled();
  });

  it('returns 404 when the invoice belongs to another tenant', async () => {
    databaseMock.invoice.findFirst.mockResolvedValue(null);

    const response = await record();

    expect(response.statusCode).toBe(404);
    expect(databaseMock.payment.create).not.toHaveBeenCalled();
  });

  it('does not create a payment when the invoice changed concurrently', async () => {
    databaseMock.invoice.updateMany.mockResolvedValue({ count: 0 });

    const response = await record();

    expect(response.statusCode).toBe(409);
    expect(databaseMock.payment.create).not.toHaveBeenCalled();
  });

  it('maps a database uniqueness race to a conflict', async () => {
    databaseMock.payment.create.mockRejectedValue(
      Object.assign(new Error('unique'), { code: 'P2002' }),
    );

    expect((await record()).statusCode).toBe(409);
  });

  it('lets BILLING record payments but not SUPPORT, and only OWNER or ADMIN reverse', async () => {
    databaseMock.tenantMembership.findFirst.mockResolvedValue(membership('BILLING'));
    expect((await record()).statusCode).toBe(201);
    expect((await reverse()).statusCode).toBe(403);

    databaseMock.tenantMembership.findFirst.mockResolvedValue(membership('SUPPORT'));
    expect((await record()).statusCode).toBe(403);
    expect((await reverse()).statusCode).toBe(403);
  });

  it('requires authentication', async () => {
    const response = await app.inject({ method: 'GET', url: '/tenant/payments' });
    expect(response.statusCode).toBe(401);
  });

  it('reverses a payment and reopens its invoice together', async () => {
    databaseMock.payment.findFirst
      .mockResolvedValueOnce(completedPayment())
      .mockResolvedValueOnce(completedPayment({ status: 'REVERSED' }));
    databaseMock.payment.updateMany.mockResolvedValue({ count: 1 });

    const response = await reverse();

    expect(response.statusCode).toBe(200);
    const paymentCall = databaseMock.payment.updateMany.mock.calls[0]![0];
    expect(paymentCall.where).toEqual({ id: paymentId, tenantId, status: 'COMPLETED' });
    expect(paymentCall.data.status).toBe('REVERSED');
    expect(paymentCall.data.reversedAt).toBeInstanceOf(Date);
    expect(paymentCall.data.reversedByUserId).toBe('user-1');
    expect(paymentCall.data.activeKey).toBeNull();
    expect(databaseMock.invoice.updateMany).toHaveBeenCalledWith({
      where: { id: invoiceId, tenantId, status: 'PAID' },
      data: { status: 'OPEN', paidAt: null },
    });
  });

  it('cannot reverse a payment that is already reversed', async () => {
    databaseMock.payment.findFirst.mockResolvedValue(completedPayment({ status: 'REVERSED' }));

    expect((await reverse()).statusCode).toBe(409);
    expect(databaseMock.payment.updateMany).not.toHaveBeenCalled();
  });

  it('returns 404 when reversing a payment from another tenant', async () => {
    databaseMock.payment.findFirst.mockResolvedValue(null);

    expect((await reverse(otherTenantPaymentId)).statusCode).toBe(404);
    expect(databaseMock.payment.updateMany).not.toHaveBeenCalled();
  });

  it('reports a conflict when either side of a reversal changed concurrently', async () => {
    databaseMock.payment.findFirst.mockResolvedValue(completedPayment());

    databaseMock.payment.updateMany.mockResolvedValue({ count: 0 });
    expect((await reverse()).statusCode).toBe(409);

    databaseMock.payment.updateMany.mockResolvedValue({ count: 1 });
    databaseMock.invoice.updateMany.mockResolvedValue({ count: 0 });
    expect((await reverse()).statusCode).toBe(409);
  });
});
