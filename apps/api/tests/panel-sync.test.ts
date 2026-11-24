import { randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@hostbilling/database';
import { panelPlanLabel, panelUsername, syncSubscriptionToPanel } from '../src/panel-sync.js';
import { encryptSecret } from '../src/secrets.js';

const tenantId = '00000000-0000-4000-8000-000000000001';
const subscriptionId = '00000000-0000-4000-8000-0000000000b1';
const customerId = '11111111-2222-4333-8444-555555555555';
const key = randomBytes(32);

const databaseMock = {
  hostPanelConnection: { findFirst: vi.fn() },
  subscription: { findFirst: vi.fn(), updateMany: vi.fn() },
};
const database = databaseMock as unknown as PrismaClient;

const fetchImpl = vi.fn();
const deps = {
  secretsKey: key,
  clientOptions: {
    fetchImpl: fetchImpl as unknown as typeof fetch,
    resolve: async () => ['203.0.113.10'],
  },
};

const subscription = (overrides: Record<string, unknown> = {}) => ({
  id: subscriptionId,
  tenantId,
  customerId,
  status: 'ACTIVE',
  panelState: 'NOT_SYNCED',
  domain: 'shop.example.com',
  customer: { email: 'sita@example.com' },
  plan: { name: 'Starter', diskQuotaMb: 5000, bandwidthQuotaMb: 50000 },
  ...overrides,
});

const calls = () =>
  fetchImpl.mock.calls.map(
    ([url, init]) => `${(init as RequestInit).method} ${new URL(url as string).pathname}`,
  );

const savedStates = () =>
  databaseMock.subscription.updateMany.mock.calls.map(
    ([args]) => (args as { data: { panelState: string; panelError: string | null } }).data,
  );

describe('panel sync', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    databaseMock.hostPanelConnection.findFirst.mockResolvedValue({
      baseUrl: 'https://panel.example.com',
      apiKeyCiphertext: encryptSecret('hpk_12345678_' + 'a'.repeat(48), key),
      defaultType: 'php',
      defaultPhp: '8.4',
    });
    databaseMock.subscription.findFirst.mockResolvedValue(subscription());
    databaseMock.subscription.updateMany.mockResolvedValue({ count: 1 });
    fetchImpl.mockImplementation(async () =>
      Response.json(
        { created: true, credentials: { panel: { password: 'once' } } },
        { status: 201 },
      ),
    );
  });

  it('does nothing when the provider has not connected a panel', async () => {
    databaseMock.hostPanelConnection.findFirst.mockResolvedValue(null);

    await expect(
      syncSubscriptionToPanel(database, deps, tenantId, subscriptionId),
    ).resolves.toEqual({
      kind: 'not-configured',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('provisions an active subscription with its plan limits and returns credentials once', async () => {
    const outcome = await syncSubscriptionToPanel(database, deps, tenantId, subscriptionId);

    expect(outcome).toEqual({
      kind: 'synced',
      panelState: 'ACTIVE',
      credentials: { panel: { password: 'once' } },
    });
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      domain: 'shop.example.com',
      username: panelUsername(customerId),
      email: 'sita@example.com',
      externalId: subscriptionId,
      type: 'php',
      php: '8.4',
      plan: 'Starter',
      limits: { diskMb: 5000, bandwidthMb: 50000 },
    });
    expect(savedStates()).toEqual([
      expect.objectContaining({ panelState: 'ACTIVE', panelError: null }),
    ]);
    // Credentials are returned to the caller but never written to the database.
    expect(JSON.stringify(databaseMock.subscription.updateMany.mock.calls)).not.toContain('once');
  });

  it('treats a replayed provision as success without credentials', async () => {
    fetchImpl.mockImplementation(async () => Response.json({ created: false, credentials: null }));

    await expect(
      syncSubscriptionToPanel(database, deps, tenantId, subscriptionId),
    ).resolves.toMatchObject({
      kind: 'synced',
      credentials: null,
    });
  });

  it('records the panel error and keeps the state when provisioning fails', async () => {
    fetchImpl.mockImplementation(async () =>
      Response.json(
        { error: { code: 'domain_exists', message: 'Domain already used' } },
        { status: 409 },
      ),
    );

    await expect(
      syncSubscriptionToPanel(database, deps, tenantId, subscriptionId),
    ).resolves.toEqual({
      kind: 'failed',
      error: 'Domain already used',
      panelState: 'NOT_SYNCED',
    });
    expect(savedStates()).toEqual([
      expect.objectContaining({ panelState: 'NOT_SYNCED', panelError: 'Domain already used' }),
    ]);
  });

  it('does not contact the panel when the subscription has no domain or the customer no email', async () => {
    databaseMock.subscription.findFirst.mockResolvedValueOnce(subscription({ domain: null }));
    await expect(
      syncSubscriptionToPanel(database, deps, tenantId, subscriptionId),
    ).resolves.toMatchObject({
      kind: 'failed',
      error: expect.stringContaining('no domain'),
    });

    databaseMock.subscription.findFirst.mockResolvedValueOnce(
      subscription({ customer: { email: null } }),
    );
    await expect(
      syncSubscriptionToPanel(database, deps, tenantId, subscriptionId),
    ).resolves.toMatchObject({
      kind: 'failed',
      error: expect.stringContaining('no email'),
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('waits for activation: pending subscriptions are skipped', async () => {
    databaseMock.subscription.findFirst.mockResolvedValue(subscription({ status: 'PENDING' }));

    await expect(
      syncSubscriptionToPanel(database, deps, tenantId, subscriptionId),
    ).resolves.toMatchObject({
      kind: 'skipped',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('suspends a provisioned site and unsuspends it again', async () => {
    fetchImpl.mockImplementation(async () => Response.json({}));

    databaseMock.subscription.findFirst.mockResolvedValue(
      subscription({ status: 'SUSPENDED', panelState: 'ACTIVE' }),
    );
    await syncSubscriptionToPanel(database, deps, tenantId, subscriptionId);
    expect(calls()).toEqual(['POST /api/v1/services/shop.example.com/suspend']);

    fetchImpl.mockClear();
    databaseMock.subscription.findFirst.mockResolvedValue(
      subscription({ status: 'ACTIVE', panelState: 'SUSPENDED' }),
    );
    await syncSubscriptionToPanel(database, deps, tenantId, subscriptionId);
    expect(calls()).toEqual(['POST /api/v1/services/shop.example.com/unsuspend']);
  });

  it('makes no call when the panel already matches', async () => {
    databaseMock.subscription.findFirst.mockResolvedValue(subscription({ panelState: 'ACTIVE' }));

    await expect(
      syncSubscriptionToPanel(database, deps, tenantId, subscriptionId),
    ).resolves.toMatchObject({
      kind: 'synced',
      panelState: 'ACTIVE',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('provisions then suspends when a never-synced subscription is already suspended', async () => {
    fetchImpl.mockImplementation(async (url: string) =>
      String(url).endsWith('/services')
        ? Response.json({ credentials: null }, { status: 201 })
        : Response.json({}),
    );
    databaseMock.subscription.findFirst.mockResolvedValue(subscription({ status: 'SUSPENDED' }));

    await expect(
      syncSubscriptionToPanel(database, deps, tenantId, subscriptionId),
    ).resolves.toMatchObject({
      panelState: 'SUSPENDED',
    });
    expect(calls()).toEqual([
      'POST /api/v1/services',
      'POST /api/v1/services/shop.example.com/suspend',
    ]);
    // The provisioning step is saved before the suspend is attempted.
    expect(savedStates().map((state) => state.panelState)).toEqual(['ACTIVE', 'SUSPENDED']);
  });

  it('keeps a completed step when a later step fails', async () => {
    fetchImpl.mockImplementation(async (url: string) =>
      String(url).endsWith('/services')
        ? Response.json({ credentials: null }, { status: 201 })
        : Response.json(
            { error: { code: 'busy', message: 'Another task is running' } },
            { status: 409 },
          ),
    );
    databaseMock.subscription.findFirst.mockResolvedValue(subscription({ status: 'SUSPENDED' }));

    await expect(
      syncSubscriptionToPanel(database, deps, tenantId, subscriptionId),
    ).resolves.toEqual({
      kind: 'failed',
      error: 'Another task is running',
      panelState: 'ACTIVE',
    });
  });

  it('terminates a cancelled site, and a site already gone counts as done', async () => {
    databaseMock.subscription.findFirst.mockResolvedValue(
      subscription({ status: 'CANCELLED', panelState: 'ACTIVE' }),
    );
    fetchImpl.mockImplementation(async () => Response.json({}, { status: 202 }));
    await expect(
      syncSubscriptionToPanel(database, deps, tenantId, subscriptionId),
    ).resolves.toMatchObject({
      panelState: 'TERMINATED',
    });
    expect(calls()).toEqual(['DELETE /api/v1/services/shop.example.com']);

    fetchImpl.mockImplementation(async () =>
      Response.json({ error: { code: 'not_found', message: 'No such service' } }, { status: 404 }),
    );
    await expect(
      syncSubscriptionToPanel(database, deps, tenantId, subscriptionId),
    ).resolves.toMatchObject({
      kind: 'synced',
      panelState: 'TERMINATED',
    });
  });

  it('skips cancelled subscriptions that never had a website', async () => {
    databaseMock.subscription.findFirst.mockResolvedValue(subscription({ status: 'CANCELLED' }));

    await expect(
      syncSubscriptionToPanel(database, deps, tenantId, subscriptionId),
    ).resolves.toMatchObject({
      kind: 'skipped',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('records a clear error when the secrets key is missing or the saved key is unreadable', async () => {
    await expect(
      syncSubscriptionToPanel(database, { ...deps, secretsKey: null }, tenantId, subscriptionId),
    ).resolves.toMatchObject({ kind: 'failed', error: expect.stringContaining('SECRETS_KEY') });

    await expect(
      syncSubscriptionToPanel(
        database,
        { ...deps, secretsKey: randomBytes(32) },
        tenantId,
        subscriptionId,
      ),
    ).resolves.toMatchObject({ kind: 'failed', error: expect.stringContaining('decrypted') });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('scopes every lookup to the tenant', async () => {
    await syncSubscriptionToPanel(database, deps, tenantId, subscriptionId);

    expect(databaseMock.hostPanelConnection.findFirst).toHaveBeenCalledWith({
      where: { tenantId },
    });
    expect(databaseMock.subscription.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: subscriptionId, tenantId } }),
    );
    expect(databaseMock.subscription.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: subscriptionId, tenantId } }),
    );
  });
});

describe('panel naming', () => {
  it('derives a valid, stable login name from the customer', () => {
    expect(panelUsername(customerId)).toBe('c111111112222');
    expect(panelUsername(customerId)).toMatch(/^[A-Za-z][A-Za-z0-9_.-]{2,31}$/);
  });

  it('cleans plan names to what the panel accepts', () => {
    expect(panelPlanLabel('Starter')).toBe('Starter');
    expect(panelPlanLabel('  ★ Business+ (Pro)  ')).toBe('Business Pro');
    expect(panelPlanLabel('★★★')).toBeUndefined();
    expect(panelPlanLabel('x'.repeat(100))).toHaveLength(64);
  });
});
