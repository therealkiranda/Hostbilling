import { describe, expect, it, vi } from 'vitest';
import { HostPanelClient, HostPanelError, validatePanelUrl } from '../src/hostpanel-client.js';

const publicResolve = async () => ['203.0.113.10'];

describe('panel address validation', () => {
  it('accepts a public https address and keeps only the origin', async () => {
    await expect(
      validatePanelUrl('https://panel.example.com/', { resolve: publicResolve }),
    ).resolves.toBe('https://panel.example.com');
    await expect(
      validatePanelUrl('https://panel.example.com:8443', { resolve: publicResolve }),
    ).resolves.toBe('https://panel.example.com:8443');
  });

  it.each([
    ['plain http', 'http://panel.example.com'],
    ['credentials in the URL', 'https://user:pass@panel.example.com'],
    ['a path', 'https://panel.example.com/admin'],
    ['a query string', 'https://panel.example.com/?a=1'],
    ['not a URL', 'panel.example.com'],
  ])('rejects %s', async (_label, value) => {
    await expect(validatePanelUrl(value, { resolve: publicResolve })).rejects.toBeInstanceOf(
      HostPanelError,
    );
  });

  it.each([
    'https://127.0.0.1',
    'https://10.0.0.5',
    'https://172.16.4.4',
    'https://192.168.1.1',
    'https://169.254.169.254',
    'https://[::1]',
    'https://[fd00::1]',
    'https://[::ffff:127.0.0.1]',
  ])('refuses the internal address %s', async (value) => {
    await expect(validatePanelUrl(value, { resolve: publicResolve })).rejects.toThrow(/public/);
  });

  it('refuses a hostname that resolves to a private address', async () => {
    await expect(
      validatePanelUrl('https://sneaky.example.com', { resolve: async () => ['10.1.2.3'] }),
    ).rejects.toThrow(/public/);
    await expect(
      validatePanelUrl('https://mixed.example.com', {
        resolve: async () => ['203.0.113.10', '127.0.0.1'],
      }),
    ).rejects.toThrow(/public/);
  });

  it('allows private addresses only when explicitly enabled', async () => {
    await expect(
      validatePanelUrl('http://127.0.0.1:8443', { allowPrivateHosts: true }),
    ).resolves.toBe('http://127.0.0.1:8443');
  });
});

describe('HostPanel client', () => {
  const connection = { baseUrl: 'https://panel.example.com', apiKey: 'hpk_test' };

  it('sends the key as a bearer token and does not follow redirects', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ ok: true }));
    await new HostPanelClient(connection, { fetchImpl, resolve: publicResolve }).ping();

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://panel.example.com/api/v1/ping');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer hpk_test');
    expect(init.redirect).toBe('error');
  });

  it('turns panel errors into readable errors with the panel code', async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json(
        { error: { code: 'domain_exists', message: 'A website with that domain already exists' } },
        { status: 409 },
      ),
    );
    const client = new HostPanelClient(connection, { fetchImpl, resolve: publicResolve });

    await expect(client.suspend('shop.example.com')).rejects.toMatchObject({
      code: 'domain_exists',
      status: 409,
      message: 'A website with that domain already exists',
    });
  });

  it('reports an unreachable panel without leaking details', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('connect ECONNREFUSED 203.0.113.10:443');
    });
    const client = new HostPanelClient(connection, { fetchImpl, resolve: publicResolve });

    await expect(client.ping()).rejects.toMatchObject({
      code: 'unreachable',
      message: 'The panel could not be reached',
    });
  });

  it('re-checks the address on every call', async () => {
    const fetchImpl = vi.fn(async () => Response.json({}));
    const client = new HostPanelClient(connection, {
      fetchImpl,
      resolve: async () => ['192.168.0.9'],
    });

    await expect(client.ping()).rejects.toThrow(/public/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('marks a 201 as created and a replay as not created', async () => {
    const created = vi.fn(async () =>
      Response.json({ credentials: { panel: {} } }, { status: 201 }),
    );
    const replay = vi.fn(async () => Response.json({ credentials: null }, { status: 200 }));
    const input = {
      domain: 'shop.example.com',
      username: 'c1',
      email: 'a@example.com',
      externalId: 'x',
      type: 'php',
      limits: { diskMb: 1, bandwidthMb: 1 },
    };

    expect(
      (
        await new HostPanelClient(connection, {
          fetchImpl: created,
          resolve: publicResolve,
        }).provision(input)
      ).created,
    ).toBe(true);
    expect(
      (
        await new HostPanelClient(connection, {
          fetchImpl: replay,
          resolve: publicResolve,
        }).provision(input)
      ).created,
    ).toBe(false);
  });
});
