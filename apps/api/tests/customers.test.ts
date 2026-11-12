import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@hostbilling/database';
import { buildApp } from '../src/app.js';

const tenantId = '00000000-0000-4000-8000-000000000001';
const otherTenantCustomerId = '00000000-0000-4000-8000-000000000099';

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
  customer: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    count: vi.fn(),
    create: vi.fn(),
    updateMany: vi.fn(),
  },
};

const database = databaseMock as unknown as PrismaClient;
const jwtSecret = 'test-secret-with-at-least-32-random-bytes';

const customerPayload = {
  name: 'Jane Doe',
  email: ' JANE@EXAMPLE.COM ',
  phone: '+977-9800000000',
  companyName: 'Example Pvt. Ltd.',
  notes: 'Primary account contact',
};

describe('tenant customers', () => {
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

  it('lists customers with tenant scope and pagination', async () => {
    databaseMock.customer.findMany.mockResolvedValue([]);
    databaseMock.customer.count.mockResolvedValue(0);

    const response = await app.inject({
      method: 'GET',
      url: '/tenant/customers?page=2&pageSize=10',
      headers: headers(),
    });

    expect(response.statusCode).toBe(200);
    expect(databaseMock.customer.findMany).toHaveBeenCalledWith({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
      skip: 10,
      take: 10,
    });
    expect(databaseMock.customer.count).toHaveBeenCalledWith({ where: { tenantId } });
    expect(response.json().pagination).toEqual({
      page: 2,
      pageSize: 10,
      total: 0,
      totalPages: 0,
    });
  });

  it('filters customer search only inside the active tenant', async () => {
    databaseMock.customer.findMany.mockResolvedValue([]);
    databaseMock.customer.count.mockResolvedValue(0);

    const response = await app.inject({
      method: 'GET',
      url: '/tenant/customers?q=jane&status=ACTIVE',
      headers: headers(),
    });

    expect(response.statusCode).toBe(200);
    expect(databaseMock.customer.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          tenantId,
          status: 'ACTIVE',
          OR: [
            { name: { contains: 'jane', mode: 'insensitive' } },
            { email: { contains: 'jane', mode: 'insensitive' } },
            { companyName: { contains: 'jane', mode: 'insensitive' } },
          ],
        },
      }),
    );
  });

  it('returns a customer only when it belongs to the active tenant', async () => {
    databaseMock.customer.findFirst.mockResolvedValue(null);

    const response = await app.inject({
      method: 'GET',
      url: `/tenant/customers/${otherTenantCustomerId}`,
      headers: headers(),
    });

    expect(response.statusCode).toBe(404);
    expect(databaseMock.customer.findFirst).toHaveBeenCalledWith({
      where: { id: otherTenantCustomerId, tenantId },
    });
  });

  it('creates a customer with normalized email and resolved tenant', async () => {
    databaseMock.customer.create.mockResolvedValue({
      id: 'customer-1',
      ...customerPayload,
      email: 'jane@example.com',
      tenantId,
      status: 'ACTIVE',
    });

    const response = await app.inject({
      method: 'POST',
      url: '/tenant/customers',
      headers: headers(),
      payload: customerPayload,
    });

    expect(response.statusCode).toBe(201);
    expect(databaseMock.customer.create).toHaveBeenCalledWith({
      data: {
        name: 'Jane Doe',
        email: 'jane@example.com',
        phone: '+977-9800000000',
        companyName: 'Example Pvt. Ltd.',
        notes: 'Primary account contact',
        status: 'ACTIVE',
        tenantId,
      },
    });
  });

  it('rejects client-supplied tenant IDs', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/tenant/customers',
      headers: headers(),
      payload: { ...customerPayload, tenantId: '00000000-0000-4000-8000-000000000002' },
    });

    expect(response.statusCode).toBe(400);
    expect(databaseMock.customer.create).not.toHaveBeenCalled();
  });

  it('denies customer creation to a BILLING member', async () => {
    databaseMock.tenantMembership.findFirst.mockResolvedValue({
      role: 'BILLING',
      tenant: { id: tenantId, name: 'Example Hosting', slug: 'example-hosting' },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/tenant/customers',
      headers: headers(),
      payload: customerPayload,
    });

    expect(response.statusCode).toBe(403);
    expect(databaseMock.customer.create).not.toHaveBeenCalled();
  });

  it('updates a customer using tenant-scoped conditions', async () => {
    databaseMock.customer.updateMany.mockResolvedValue({ count: 1 });
    databaseMock.customer.findFirst.mockResolvedValue({ id: otherTenantCustomerId, name: 'Jane' });

    const response = await app.inject({
      method: 'PATCH',
      url: `/tenant/customers/${otherTenantCustomerId}`,
      headers: headers(),
      payload: { name: 'Jane Updated' },
    });

    expect(response.statusCode).toBe(200);
    expect(databaseMock.customer.updateMany).toHaveBeenCalledWith({
      where: { id: otherTenantCustomerId, tenantId },
      data: { name: 'Jane Updated' },
    });
    expect(databaseMock.customer.findFirst).toHaveBeenCalledWith({
      where: { id: otherTenantCustomerId, tenantId },
    });
  });

  it('returns 404 when an update targets a customer outside the tenant', async () => {
    databaseMock.customer.updateMany.mockResolvedValue({ count: 0 });

    const response = await app.inject({
      method: 'PATCH',
      url: `/tenant/customers/${otherTenantCustomerId}`,
      headers: headers(),
      payload: { name: 'Not allowed' },
    });

    expect(response.statusCode).toBe(404);
    expect(databaseMock.customer.findFirst).not.toHaveBeenCalled();
  });

  it('rejects empty updates and invalid email addresses', async () => {
    const emptyUpdate = await app.inject({
      method: 'PATCH',
      url: `/tenant/customers/${otherTenantCustomerId}`,
      headers: headers(),
      payload: {},
    });
    const invalidEmail = await app.inject({
      method: 'POST',
      url: '/tenant/customers',
      headers: headers(),
      payload: { ...customerPayload, email: 'not-an-email' },
    });

    expect(emptyUpdate.statusCode).toBe(400);
    expect(invalidEmail.statusCode).toBe(400);
    expect(databaseMock.customer.create).not.toHaveBeenCalled();
    expect(databaseMock.customer.updateMany).not.toHaveBeenCalled();
  });

  it('returns conflict when a tenant already has the customer email', async () => {
    databaseMock.customer.create.mockRejectedValue({ code: 'P2002' });

    const response = await app.inject({
      method: 'POST',
      url: '/tenant/customers',
      headers: headers(),
      payload: customerPayload,
    });

    expect(response.statusCode).toBe(409);
  });
});
