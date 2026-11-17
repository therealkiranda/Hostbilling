import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { createDatabaseClient } from '@hostbilling/database';
import { buildApp } from '../../src/app.js';

// Runs against a real PostgreSQL database with all migrations applied (DATABASE_URL).
// Every other test mocks Prisma; this one proves the SQL, constraints and routes agree.

const db = createDatabaseClient();
let app: FastifyInstance;
let counter = 0;

const nextIp = (): string =>
  `10.${Math.floor(counter / 65_536) % 256}.${Math.floor(counter / 256) % 256}.${counter++ % 256}`;

// Response bodies are checked field by field in the tests below.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ApiBody = Record<string, any>;

async function call(
  method: 'GET' | 'POST',
  url: string,
  options: { token?: string; tenantId?: string; body?: unknown } = {},
) {
  const response = await app.inject({
    method,
    url,
    remoteAddress: nextIp(),
    headers: {
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.tenantId ? { 'x-tenant-id': options.tenantId } : {}),
    },
    ...(options.body !== undefined ? { payload: options.body as object } : {}),
  });
  return { status: response.statusCode, body: response.json() as ApiBody };
}

interface Provider {
  token: string;
  tenantId: string;
  slug: string;
}

async function registerProvider(label: string): Promise<Provider> {
  const slug = `it-${label}-${randomUUID().slice(0, 8)}`;
  const registered = await call('POST', '/auth/register', {
    body: {
      organizationName: `Integration ${label}`,
      tenantSlug: slug,
      email: `${slug}@example.com`,
      password: 'a-long-test-password',
    },
  });
  expect(registered.status).toBe(201);
  return { token: registered.body.tokens.accessToken, tenantId: registered.body.tenant.id, slug };
}

const planBody = (overrides: Record<string, unknown> = {}) => ({
  slug: `starter-${randomUUID().slice(0, 6)}`,
  name: 'Starter',
  status: 'ACTIVE',
  priceMinorUnits: 50_000,
  setupFeeMinorUnits: 10_000,
  currency: 'NPR',
  billingInterval: 'MONTH',
  diskQuotaMb: 5_000,
  bandwidthQuotaMb: 50_000,
  ...overrides,
});

beforeAll(async () => {
  app = buildApp({ db, jwtSecret: 'integration-test-secret-integration-test-secret' });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await db.$disconnect();
});

describe('billing lifecycle against PostgreSQL', () => {
  it('takes an order from the storefront through payment and renewal', async () => {
    const provider = await registerProvider('flow');
    const auth = { token: provider.token, tenantId: provider.tenantId };

    const plan = await call('POST', '/tenant/hosting-plans', { ...auth, body: planBody() });
    expect(plan.status).toBe(201);
    const planId = plan.body.plan.id as string;

    const catalogue = await call('GET', `/public/tenants/${provider.slug}/plans`);
    expect(catalogue.status).toBe(200);
    expect(catalogue.body.plans.map((item: { id: string }) => item.id)).toContain(planId);

    const order = {
      planId,
      name: 'Sita Sharma',
      email: 'sita@example.com',
      domain: 'sita-shop.com.np',
    };
    const placed = await call('POST', `/public/tenants/${provider.slug}/orders`, { body: order });
    expect(placed.status).toBe(201);
    const again = await call('POST', `/public/tenants/${provider.slug}/orders`, { body: order });
    expect(again.status).toBe(200);
    expect(again.body.order.reference).toBe(placed.body.order.reference);

    const pending = await call('GET', '/tenant/subscriptions?status=PENDING', auth);
    expect(pending.status).toBe(200);
    expect(pending.body.subscriptions).toHaveLength(1);
    const subscriptionId = pending.body.subscriptions[0].id as string;
    expect(pending.body.subscriptions[0].domain).toBe('sita-shop.com.np');

    const activated = await call('POST', `/tenant/subscriptions/${subscriptionId}/activate`, auth);
    expect(activated.status).toBe(200);
    expect(activated.body.subscription.status).toBe('ACTIVE');

    const invoice = await call('POST', `/tenant/subscriptions/${subscriptionId}/invoices`, {
      ...auth,
      body: {},
    });
    expect(invoice.status).toBe(201);
    expect(invoice.body.invoice.number).toBe('INV-000001');
    expect(invoice.body.invoice.totalMinorUnits).toBe(60_000);
    const invoiceId = invoice.body.invoice.id as string;

    const duplicate = await call('POST', `/tenant/subscriptions/${subscriptionId}/invoices`, {
      ...auth,
      body: {},
    });
    expect(duplicate.status).toBe(409);

    const payment = await call('POST', `/tenant/invoices/${invoiceId}/payments`, {
      ...auth,
      body: { method: 'CASH' },
    });
    expect(payment.status).toBe(201);
    const paymentId = payment.body.payment.id as string;

    const paid = await call('GET', `/tenant/invoices/${invoiceId}`, auth);
    expect(paid.body.invoice.status).toBe('PAID');

    const second = await call('POST', `/tenant/invoices/${invoiceId}/payments`, {
      ...auth,
      body: { method: 'CASH' },
    });
    expect(second.status).toBe(409);

    // Too early: the period has a month left.
    const early = await call('POST', `/tenant/subscriptions/${subscriptionId}/renew`, {
      ...auth,
      body: {},
    });
    expect(early.status).toBe(409);

    // Move the period end inside the renewal window, as time passing would.
    const current = await db.subscription.findFirstOrThrow({ where: { id: subscriptionId } });
    await db.subscription.update({
      where: { id: subscriptionId },
      data: { currentPeriodEnd: new Date(Date.now() + 3 * 86_400_000) },
    });

    const renewed = await call('POST', `/tenant/subscriptions/${subscriptionId}/renew`, {
      ...auth,
      body: {},
    });
    expect(renewed.status).toBe(201);
    expect(renewed.body.invoice.number).toBe('INV-000002');
    expect(renewed.body.invoice.totalMinorUnits).toBe(50_000);

    const after = await db.subscription.findFirstOrThrow({ where: { id: subscriptionId } });
    expect(after.billedPeriods).toBe(2);
    expect(after.currentPeriodStart!.getTime()).toBeGreaterThan(
      current.currentPeriodStart!.getTime(),
    );

    // Reversing the first payment reopens its invoice and allows a new payment.
    const reversed = await call('POST', `/tenant/payments/${paymentId}/reverse`, {
      ...auth,
      body: {},
    });
    expect(reversed.status).toBe(200);
    const reopened = await call('GET', `/tenant/invoices/${invoiceId}`, auth);
    expect(reopened.body.invoice.status).toBe('OPEN');
    const repaid = await call('POST', `/tenant/invoices/${invoiceId}/payments`, {
      ...auth,
      body: { method: 'BANK_TRANSFER', reference: 'TXN-1' },
    });
    expect(repaid.status).toBe(201);
  });

  it('keeps providers isolated from each other', async () => {
    const first = await registerProvider('iso-a');
    const second = await registerProvider('iso-b');

    const plan = await call('POST', '/tenant/hosting-plans', {
      token: first.token,
      tenantId: first.tenantId,
      body: planBody(),
    });
    expect(plan.status).toBe(201);

    // Provider B's staff cannot see or use provider A's plan, even claiming A's tenant ID.
    const forged = await call('GET', '/tenant/hosting-plans', {
      token: second.token,
      tenantId: first.tenantId,
    });
    expect(forged.status).toBe(403);

    const own = await call('GET', '/tenant/hosting-plans', {
      token: second.token,
      tenantId: second.tenantId,
    });
    expect(own.body.plans).toHaveLength(0);

    const crossOrder = await call('POST', `/public/tenants/${second.slug}/orders`, {
      body: {
        planId: plan.body.plan.id,
        name: 'Ram',
        email: 'ram@example.com',
        domain: 'ram-site.com.np',
      },
    });
    expect(crossOrder.status).toBe(404);
  });
});
