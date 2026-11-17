import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@hostbilling/database';
import { buildApp } from '../src/app.js';

const tenantId = '00000000-0000-4000-8000-000000000001';
const planId = '00000000-0000-4000-8000-0000000000a1';
const customerId = '00000000-0000-4000-8000-0000000000c1';
const subscriptionId = 'abcdef12-0000-4000-8000-0000000000b1';

const databaseMock = {
  tenant: { findFirst: vi.fn() },
  hostingPlan: { findFirst: vi.fn(), findMany: vi.fn() },
  customer: { findFirst: vi.fn(), create: vi.fn() },
  subscription: { findFirst: vi.fn(), create: vi.fn() },
  $transaction: vi.fn(),
};

const database = databaseMock as unknown as PrismaClient;
const jwtSecret = 'test-secret-with-at-least-32-random-bytes';

const activePlan = {
  id: planId,
  name: 'Business',
  status: 'ACTIVE',
  priceMinorUnits: 125000,
  setupFeeMinorUnits: 5000,
  currency: 'NPR',
  billingInterval: 'YEAR',
  intervalCount: 1,
};

const validOrder = {
  planId,
  name: 'Sita Sharma',
  email: 'sita@example.com',
  domain: 'sharma-store.com.np',
};

describe('public storefront', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = buildApp({ db: database, jwtSecret, corsOrigins: [] });
    await app.ready();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    databaseMock.$transaction.mockImplementation(async (callback) => callback(databaseMock));
    databaseMock.tenant.findFirst.mockResolvedValue({
      id: tenantId,
      name: 'Example Hosting',
      slug: 'example-hosting',
    });
    databaseMock.hostingPlan.findFirst.mockResolvedValue(activePlan);
    databaseMock.customer.findFirst.mockResolvedValue(null);
    databaseMock.customer.create.mockResolvedValue({ id: customerId, status: 'ACTIVE' });
    databaseMock.subscription.findFirst.mockResolvedValue(null);
    databaseMock.subscription.create.mockResolvedValue({ id: subscriptionId });
  });

  afterAll(async () => {
    await app.close();
  });

  // Each call comes from a new client address so the per-visitor order limit never
  // interferes. The limit itself is tested separately.
  let visitor = 0;

  function order(payload: Record<string, unknown> = validOrder, slug = 'example-hosting') {
    visitor += 1;
    return app.inject({
      method: 'POST',
      url: `/public/tenants/${slug}/orders`,
      remoteAddress: `10.1.${Math.floor(visitor / 250)}.${(visitor % 250) + 1}`,
      payload,
    });
  }

  describe('plans', () => {
    it('lists only active plans for an active provider, without signing in', async () => {
      databaseMock.hostingPlan.findMany.mockResolvedValue([{ id: planId, name: 'Business' }]);

      const response = await app.inject({
        method: 'GET',
        url: '/public/tenants/example-hosting/plans',
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        tenant: { name: 'Example Hosting', slug: 'example-hosting' },
        plans: [{ id: planId, name: 'Business' }],
      });
      expect(databaseMock.tenant.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { slug: 'example-hosting', status: 'ACTIVE' } }),
      );
      expect(databaseMock.hostingPlan.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { tenantId, status: 'ACTIVE' } }),
      );
    });

    it('selects public plan fields only', async () => {
      databaseMock.hostingPlan.findMany.mockResolvedValue([]);

      await app.inject({ method: 'GET', url: '/public/tenants/example-hosting/plans' });

      const { select } = databaseMock.hostingPlan.findMany.mock.calls[0]![0];
      expect(select).toMatchObject({ name: true, priceMinorUnits: true, diskQuotaMb: true });
      for (const hidden of ['tenantId', 'status', 'createdAt', 'updatedAt', 'tenant']) {
        expect(select).not.toHaveProperty(hidden);
      }
    });

    it('returns 404 for an unknown or inactive provider', async () => {
      databaseMock.tenant.findFirst.mockResolvedValue(null);

      const response = await app.inject({
        method: 'GET',
        url: '/public/tenants/nobody/plans',
      });

      expect(response.statusCode).toBe(404);
      expect(databaseMock.hostingPlan.findMany).not.toHaveBeenCalled();
    });

    it('rejects a malformed provider slug', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/public/tenants/Bad_Slug/plans',
      });

      expect(response.statusCode).toBe(400);
      expect(databaseMock.tenant.findFirst).not.toHaveBeenCalled();
    });
  });

  describe('orders', () => {
    it('creates a customer and a pending subscription with the plan pricing', async () => {
      const response = await order();

      expect(response.statusCode).toBe(201);
      expect(response.json()).toEqual({
        order: {
          reference: 'ABCDEF12',
          status: 'PENDING',
          plan: { name: 'Business' },
          domain: 'sharma-store.com.np',
        },
      });
      expect(databaseMock.hostingPlan.findFirst).toHaveBeenCalledWith({
        where: { id: planId, tenantId, status: 'ACTIVE' },
      });
      expect(databaseMock.customer.create).toHaveBeenCalledWith({
        data: { tenantId, name: 'Sita Sharma', email: 'sita@example.com' },
      });
      expect(databaseMock.subscription.create).toHaveBeenCalledWith({
        data: {
          tenantId,
          customerId,
          planId,
          status: 'PENDING',
          domain: 'sharma-store.com.np',
          priceMinorUnits: 125000,
          setupFeeMinorUnits: 5000,
          currency: 'NPR',
          billingInterval: 'YEAR',
          intervalCount: 1,
        },
        select: { id: true },
      });
    });

    it('normalizes the email and domain and keeps optional details', async () => {
      const response = await order({
        ...validOrder,
        email: '  Sita@Example.COM ',
        domain: ' Sharma-Store.COM.np ',
        phone: '+977 9812345678',
        companyName: ' Sharma Store ',
      });

      expect(response.statusCode).toBe(201);
      expect(databaseMock.customer.findFirst).toHaveBeenCalledWith({
        where: { tenantId, email: 'sita@example.com' },
      });
      expect(databaseMock.customer.create).toHaveBeenCalledWith({
        data: {
          tenantId,
          name: 'Sita Sharma',
          email: 'sita@example.com',
          phone: '+977 9812345678',
          companyName: 'Sharma Store',
        },
      });
      expect(databaseMock.subscription.create.mock.calls[0]![0].data.domain).toBe(
        'sharma-store.com.np',
      );
    });

    it('reuses an existing customer without changing their details', async () => {
      databaseMock.customer.findFirst.mockResolvedValue({ id: customerId, status: 'ACTIVE' });

      const response = await order({ ...validOrder, name: 'Someone Else' });

      expect(response.statusCode).toBe(201);
      expect(databaseMock.customer.create).not.toHaveBeenCalled();
      expect(databaseMock.subscription.create.mock.calls[0]![0].data.customerId).toBe(customerId);
    });

    it('returns the same order when the form is submitted twice', async () => {
      databaseMock.customer.findFirst.mockResolvedValue({ id: customerId, status: 'ACTIVE' });
      databaseMock.subscription.findFirst.mockResolvedValue({ id: subscriptionId });

      const response = await order();

      expect(response.statusCode).toBe(200);
      expect(response.json().order.reference).toBe('ABCDEF12');
      expect(databaseMock.subscription.findFirst).toHaveBeenCalledWith({
        where: {
          tenantId,
          customerId,
          planId,
          domain: 'sharma-store.com.np',
          status: 'PENDING',
        },
        select: { id: true },
      });
      expect(databaseMock.subscription.create).not.toHaveBeenCalled();
    });

    it('does not take orders from inactive customers', async () => {
      databaseMock.customer.findFirst.mockResolvedValue({ id: customerId, status: 'INACTIVE' });

      const response = await order();

      expect(response.statusCode).toBe(422);
      expect(databaseMock.subscription.create).not.toHaveBeenCalled();
    });

    it('returns 404 for an inactive plan or a plan from another provider', async () => {
      databaseMock.hostingPlan.findFirst.mockResolvedValue(null);

      const response = await order();

      expect(response.statusCode).toBe(404);
      expect(databaseMock.customer.create).not.toHaveBeenCalled();
      expect(databaseMock.subscription.create).not.toHaveBeenCalled();
    });

    it('returns 404 for an unknown provider', async () => {
      databaseMock.tenant.findFirst.mockResolvedValue(null);

      const response = await order(validOrder, 'nobody');

      expect(response.statusCode).toBe(404);
      expect(databaseMock.hostingPlan.findFirst).not.toHaveBeenCalled();
    });

    it('rejects invalid details with field errors', async () => {
      const response = await order({
        planId: 'not-a-uuid',
        name: '   ',
        email: 'not-an-email',
        domain: 'localhost',
      });

      expect(response.statusCode).toBe(400);
      expect(Object.keys(response.json().details).sort()).toEqual([
        'domain',
        'email',
        'name',
        'planId',
      ]);
      expect(databaseMock.tenant.findFirst).not.toHaveBeenCalled();
    });

    it('only accepts real domain names', async () => {
      for (const domain of [
        'http://example.com',
        'example.com/path',
        'exa mple.com',
        'example',
        '-example.com',
        'example..com',
        'example.c',
        '192.168.1.1',
        '',
      ]) {
        expect((await order({ ...validOrder, domain })).statusCode).toBe(400);
      }

      for (const domain of ['example.com', 'shop.example.com.np', 'xn--bcher-kva.example']) {
        expect((await order({ ...validOrder, domain })).statusCode).toBe(201);
      }
    });

    it('rejects a missing domain, bad phone numbers, and unknown fields', async () => {
      const withoutDomain = { planId, name: 'Sita Sharma', email: 'sita@example.com' };
      expect((await order(withoutDomain)).statusCode).toBe(400);
      expect((await order({ ...validOrder, phone: 'call me' })).statusCode).toBe(400);

      for (const extra of [
        { tenantId: 'other' },
        { priceMinorUnits: 1 },
        { status: 'ACTIVE' },
        { customerId },
      ]) {
        expect((await order({ ...validOrder, ...extra })).statusCode).toBe(400);
      }
      expect(databaseMock.subscription.create).not.toHaveBeenCalled();
    });

    it('maps a database uniqueness race to a conflict', async () => {
      databaseMock.customer.create.mockRejectedValue(
        Object.assign(new Error('unique'), { code: 'P2002' }),
      );

      expect((await order()).statusCode).toBe(409);
    });

    it('limits how often one visitor can place orders', async () => {
      const limited = buildApp({ db: database, jwtSecret, corsOrigins: [] });
      await limited.ready();

      const statuses: number[] = [];
      for (let attempt = 0; attempt < 11; attempt += 1) {
        const response = await limited.inject({
          method: 'POST',
          url: '/public/tenants/example-hosting/orders',
          payload: validOrder,
        });
        statuses.push(response.statusCode);
      }
      await limited.close();

      expect(statuses.slice(0, 10).every((status) => status === 201 || status === 200)).toBe(true);
      expect(statuses[10]).toBe(429);
    });
  });

  describe('cross-origin access', () => {
    it('allows only the configured origins', async () => {
      const restricted = buildApp({
        db: database,
        jwtSecret,
        corsOrigins: ['https://shop.example.com'],
      });
      await restricted.ready();

      const allowed = await restricted.inject({
        method: 'OPTIONS',
        url: '/public/tenants/example-hosting/orders',
        headers: {
          origin: 'https://shop.example.com',
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'content-type',
        },
      });
      const blocked = await restricted.inject({
        method: 'OPTIONS',
        url: '/public/tenants/example-hosting/orders',
        headers: {
          origin: 'https://evil.example',
          'access-control-request-method': 'POST',
        },
      });
      await restricted.close();

      expect(allowed.headers['access-control-allow-origin']).toBe('https://shop.example.com');
      expect(blocked.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('sends no CORS headers when no origins are configured', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/public/tenants/example-hosting/plans',
        headers: { origin: 'https://shop.example.com' },
      });

      expect(response.headers['access-control-allow-origin']).toBeUndefined();
    });
  });
});
