import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@hostbilling/database';
import { buildApp } from '../src/app.js';
import { decryptSecret, encryptSecret } from '../src/secrets.js';

const tenantId = '00000000-0000-4000-8000-000000000001';
const subscriptionId = '00000000-0000-4000-8000-0000000000b1';
const customerId = '00000000-0000-4000-8000-0000000000c1';
const apiKey = `hpk_12345678_${'a'.repeat(48)}`;
const secretsKey = randomBytes(32);
const jwtSecret = 'test-secret-with-at-least-32-random-bytes';

const databaseMock = {
  authSession: { findFirst: vi.fn() },
  user: { findFirst: vi.fn() },
  tenantMembership: { findFirst: vi.fn() },
  hostPanelConnection: { findFirst: vi.fn(), upsert: vi.fn(), deleteMany: vi.fn() },
  subscription: { findFirst: vi.fn(), updateMany: vi.fn() },
};
const database = databaseMock as unknown as PrismaClient;
const fetchImpl = vi.fn();

const storedConnection = () => ({
  baseUrl: 'https://panel.example.com',
  apiKeyCiphertext: encryptSecret(apiKey, secretsKey),
  defaultType: 'php',
  defaultPhp: null,
  updatedAt: new Date('2026-11-20T00:00:00Z'),
});

const subscription = (overrides: Record<string, unknown> = {}) => ({
  id: subscriptionId,
  tenantId,
  customerId,
  status: 'PENDING',
  panelState: 'NOT_SYNCED',
  startedAt: null,
  billingInterval: 'MONTH',
  intervalCount: 1,
  domain: 'shop.example.com',
  customer: { id: customerId, name: 'Sita', email: 'sita@example.com' },
  plan: { id: 'p', slug: 'starter', name: 'Starter', diskQuotaMb: 5000, bandwidthQuotaMb: 50000 },
  ...overrides,
});

describe('HostPanel connection and sync routes', () => {
  let app: FastifyInstance;
  let role = 'OWNER';

  beforeAll(async () => {
    app = buildApp({
      db: database,
      jwtSecret,
      secretsKey,
      panelClientOptions: {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        resolve: async () => ['203.0.113.10'],
      },
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    role = 'OWNER';
    databaseMock.authSession.findFirst.mockResolvedValue({ id: 'session-1' });
    databaseMock.user.findFirst.mockResolvedValue({ id: 'user-1' });
    databaseMock.tenantMembership.findFirst.mockImplementation(async () => ({
      role,
      tenant: { id: tenantId, name: 'Example Hosting', slug: 'example-hosting' },
    }));
    databaseMock.hostPanelConnection.findFirst.mockResolvedValue(null);
    databaseMock.hostPanelConnection.upsert.mockImplementation(async ({ create }) => ({
      ...create,
      updatedAt: new Date('2026-11-20T00:00:00Z'),
    }));
    databaseMock.subscription.updateMany.mockResolvedValue({ count: 1 });
    fetchImpl.mockImplementation(async () => Response.json({ ok: true }));
  });

  const headers = () => ({
    authorization: `Bearer ${app.jwt.sign({ sub: 'user-1', sid: 'session-1' })}`,
    'x-tenant-id': tenantId,
  });

  const save = (payload: object) =>
    app.inject({ method: 'PUT', url: '/tenant/hostpanel', headers: headers(), payload });

  it('checks the key with the panel, stores it encrypted and never returns it', async () => {
    const response = await save({
      baseUrl: 'https://panel.example.com/',
      apiKey,
      defaultPhp: '8.4',
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain(apiKey);
    expect(response.json().connection).toMatchObject({
      baseUrl: 'https://panel.example.com',
      hasKey: true,
      defaultType: 'php',
      defaultPhp: '8.4',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const stored = databaseMock.hostPanelConnection.upsert.mock.calls[0]![0].create;
    expect(stored.tenantId).toBe(tenantId);
    expect(stored.apiKeyCiphertext).not.toContain(apiKey);
    expect(decryptSecret(stored.apiKeyCiphertext, secretsKey)).toBe(apiKey);
  });

  it('refuses to save a key the panel rejects', async () => {
    fetchImpl.mockImplementation(async () =>
      Response.json({ error: { code: 'unauthorized', message: 'Wrong key' } }, { status: 401 }),
    );

    const response = await save({ baseUrl: 'https://panel.example.com', apiKey });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ error: 'Wrong key', code: 'unauthorized' });
    expect(databaseMock.hostPanelConnection.upsert).not.toHaveBeenCalled();
  });

  it('rejects unsafe addresses, malformed keys and extra fields', async () => {
    expect((await save({ baseUrl: 'http://panel.example.com', apiKey })).statusCode).toBe(422);
    expect((await save({ baseUrl: 'https://192.168.1.10', apiKey })).statusCode).toBe(422);
    expect((await save({ baseUrl: 'https://panel.example.com', apiKey: 'nope' })).statusCode).toBe(
      400,
    );
    expect(
      (await save({ baseUrl: 'https://panel.example.com', apiKey, tenantId })).statusCode,
    ).toBe(400);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('reports that storing keys is unavailable when no secrets key is configured', async () => {
    const bare = buildApp({ db: database, jwtSecret, secretsKey: null });
    await bare.ready();

    const response = await bare.inject({
      method: 'PUT',
      url: '/tenant/hostpanel',
      headers: {
        authorization: `Bearer ${bare.jwt.sign({ sub: 'user-1', sid: 'session-1' })}`,
        'x-tenant-id': tenantId,
      },
      payload: { baseUrl: 'https://panel.example.com', apiKey },
    });
    await bare.close();

    expect(response.statusCode).toBe(503);
  });

  it('lets only owners manage the connection', async () => {
    role = 'ADMIN';

    for (const request of [
      { method: 'GET', url: '/tenant/hostpanel' },
      { method: 'POST', url: '/tenant/hostpanel/test' },
      { method: 'DELETE', url: '/tenant/hostpanel' },
    ] as const) {
      const response = await app.inject({ ...request, headers: headers() });
      expect(response.statusCode).toBe(403);
    }
    expect((await save({ baseUrl: 'https://panel.example.com', apiKey })).statusCode).toBe(403);
  });

  it('shows the saved connection without its key, and removes it by tenant', async () => {
    databaseMock.hostPanelConnection.findFirst.mockResolvedValue(storedConnection());

    const shown = await app.inject({ method: 'GET', url: '/tenant/hostpanel', headers: headers() });
    expect(shown.statusCode).toBe(200);
    expect(shown.body).not.toContain('apiKey');
    expect(shown.body).not.toContain('Ciphertext');
    expect(shown.json().connection).toMatchObject({
      baseUrl: 'https://panel.example.com',
      hasKey: true,
    });

    databaseMock.hostPanelConnection.deleteMany.mockResolvedValue({ count: 1 });
    const removed = await app.inject({
      method: 'DELETE',
      url: '/tenant/hostpanel',
      headers: headers(),
    });
    expect(removed.statusCode).toBe(204);
    expect(databaseMock.hostPanelConnection.deleteMany).toHaveBeenCalledWith({
      where: { tenantId },
    });
  });

  it('tests the saved key', async () => {
    databaseMock.hostPanelConnection.findFirst.mockResolvedValue(storedConnection());

    const ok = await app.inject({
      method: 'POST',
      url: '/tenant/hostpanel/test',
      headers: headers(),
    });
    expect(ok.json()).toEqual({ ok: true });
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${apiKey}`);
  });

  describe('subscription changes', () => {
    beforeEach(() => {
      databaseMock.hostPanelConnection.findFirst.mockResolvedValue(storedConnection());
    });

    it('provisions on activate and returns the one-time credentials', async () => {
      databaseMock.subscription.findFirst
        .mockResolvedValueOnce(subscription())
        .mockResolvedValue(subscription({ status: 'ACTIVE' }));
      fetchImpl.mockImplementation(async () =>
        Response.json(
          { created: true, credentials: { panel: { password: 'once' } } },
          { status: 201 },
        ),
      );

      const response = await app.inject({
        method: 'POST',
        url: `/tenant/subscriptions/${subscriptionId}/activate`,
        headers: headers(),
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().panel).toMatchObject({
        kind: 'synced',
        panelState: 'ACTIVE',
        credentials: { panel: { password: 'once' } },
      });
    });

    it('keeps the activation when the panel fails and reports why', async () => {
      databaseMock.subscription.findFirst
        .mockResolvedValueOnce(subscription())
        .mockResolvedValue(subscription({ status: 'ACTIVE' }));
      fetchImpl.mockImplementation(async () =>
        Response.json(
          { error: { code: 'busy', message: 'Another task is running' } },
          { status: 409 },
        ),
      );

      const response = await app.inject({
        method: 'POST',
        url: `/tenant/subscriptions/${subscriptionId}/activate`,
        headers: headers(),
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().panel).toMatchObject({
        kind: 'failed',
        error: 'Another task is running',
      });
    });

    it('retries through the panel-sync endpoint', async () => {
      databaseMock.subscription.findFirst.mockResolvedValue(subscription({ status: 'ACTIVE' }));
      fetchImpl.mockImplementation(async () =>
        Response.json({ created: true, credentials: null }, { status: 201 }),
      );

      const response = await app.inject({
        method: 'POST',
        url: `/tenant/subscriptions/${subscriptionId}/panel-sync`,
        headers: headers(),
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().panel.kind).toBe('synced');
    });

    it("returns 404 for another tenant's subscription and 409 without a panel", async () => {
      databaseMock.subscription.findFirst.mockResolvedValueOnce(null);
      const missing = await app.inject({
        method: 'POST',
        url: `/tenant/subscriptions/${subscriptionId}/panel-sync`,
        headers: headers(),
      });
      expect(missing.statusCode).toBe(404);

      databaseMock.hostPanelConnection.findFirst.mockResolvedValue(null);
      databaseMock.subscription.findFirst.mockResolvedValue(subscription({ status: 'ACTIVE' }));
      const none = await app.inject({
        method: 'POST',
        url: `/tenant/subscriptions/${subscriptionId}/panel-sync`,
        headers: headers(),
      });
      expect(none.statusCode).toBe(409);
    });
  });
});
