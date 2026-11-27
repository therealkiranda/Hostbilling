import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export type FetchLike = typeof fetch;

/** An error from HostPanel (or from reaching it) with a message that is safe to show staff. */
export class HostPanelError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number | null = null,
  ) {
    super(message);
  }
}

export interface PanelConnection {
  baseUrl: string;
  apiKey: string;
}

export interface ClientOptions {
  fetchImpl?: FetchLike;
  /** Resolves a hostname to addresses. Replaceable in tests. */
  resolve?: (hostname: string) => Promise<string[]>;
  /** Allow private and loopback addresses. For development only. */
  allowPrivateHosts?: boolean;
  timeoutMs?: number;
}

function isPrivateAddress(address: string): boolean {
  const value = address.toLowerCase();

  if (isIP(value) === 6) {
    // Only global unicast (2000::/3) is accepted. That rules out loopback, unique-local,
    // link-local and IPv4-mapped forms however they are written. 6to4 (2002::/16) embeds an
    // IPv4 address, so it is refused as well.
    const first = Number.parseInt(value.split(':')[0] || '0', 16);
    return !(first >= 0x2000 && first <= 0x3fff) || first === 0x2002;
  }

  const parts = value.split('.').map(Number);
  const [a = 0, b = 0] = parts;

  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    a >= 224
  );
}

/**
 * The provider chooses this URL and our server calls it, so it must never reach internal
 * services. Only https URLs to public addresses are accepted.
 */
export async function validatePanelUrl(
  value: string,
  options: ClientOptions = {},
): Promise<string> {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new HostPanelError('The panel address is not a valid URL', 'invalid_url');
  }

  if (url.protocol !== 'https:' && !(options.allowPrivateHosts && url.protocol === 'http:')) {
    throw new HostPanelError('The panel address must start with https://', 'invalid_url');
  }

  if (url.username || url.password || url.search || url.hash || url.pathname.replace(/\/+$/, '')) {
    throw new HostPanelError(
      'Enter only the panel address, for example https://panel.example.com',
      'invalid_url',
    );
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, '');

  if (!options.allowPrivateHosts) {
    const resolve =
      options.resolve ??
      (async (name) => (await lookup(name, { all: true })).map((entry) => entry.address));
    let addresses: string[];

    try {
      addresses = isIP(hostname) ? [hostname] : await resolve(hostname);
    } catch {
      throw new HostPanelError('The panel address could not be resolved', 'unreachable');
    }

    if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
      throw new HostPanelError('The panel address must point to a public server', 'invalid_url');
    }
  }

  return `${url.protocol}//${url.host}`;
}

export class HostPanelClient {
  constructor(
    private readonly connection: PanelConnection,
    private readonly options: ClientOptions = {},
  ) {}

  private async request(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<{ status: number; data: Record<string, unknown> }> {
    // Checked on every call so a hostname that later points at a private address is refused.
    const baseUrl = await validatePanelUrl(this.connection.baseUrl, this.options);
    const fetchImpl = this.options.fetchImpl ?? fetch;

    let response: Response;

    try {
      response = await fetchImpl(`${baseUrl}/api/v1${path}`, {
        method,
        redirect: 'error',
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 20_000),
        headers: {
          authorization: `Bearer ${this.connection.apiKey}`,
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new HostPanelError('The panel could not be reached', 'unreachable');
    }

    const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;

    if (!response.ok) {
      const error = (data.error ?? {}) as { code?: unknown; message?: unknown };
      const code = typeof error.code === 'string' ? error.code : 'panel_error';
      const message =
        typeof error.message === 'string'
          ? error.message.slice(0, 200)
          : `Panel returned ${response.status}`;
      throw new HostPanelError(message, code, response.status);
    }

    return { status: response.status, data };
  }

  async ping(): Promise<void> {
    await this.request('GET', '/ping');
  }

  async serverInfo(): Promise<Record<string, unknown>> {
    return (await this.request('GET', '/server')).data;
  }

  async service(domain: string): Promise<Record<string, unknown>> {
    return (await this.request('GET', `/services/${encodeURIComponent(domain)}`)).data;
  }

  async currentTask(): Promise<{ running: boolean; label: string | null }> {
    const { data } = await this.request('GET', '/tasks/current');
    return {
      running: data.running === true,
      label: typeof data.label === 'string' ? data.label : null,
    };
  }

  /** Removes a client login that has no websites left. */
  async deleteClient(username: string): Promise<void> {
    await this.request('DELETE', `/clients/${encodeURIComponent(username)}`);
  }

  async provision(input: {
    domain: string;
    username: string;
    email: string;
    externalId: string;
    type: string;
    php?: string;
    plan?: string;
    limits: { diskMb: number; bandwidthMb: number };
  }): Promise<{ created: boolean; credentials: unknown }> {
    const { status, data } = await this.request('POST', '/services', input);
    return { created: status === 201, credentials: data.credentials ?? null };
  }

  async suspend(domain: string, reason?: string): Promise<void> {
    await this.request(
      'POST',
      `/services/${encodeURIComponent(domain)}/suspend`,
      reason ? { reason } : {},
    );
  }

  async unsuspend(domain: string): Promise<void> {
    await this.request('POST', `/services/${encodeURIComponent(domain)}/unsuspend`, {});
  }

  /** Starts termination. HostPanel takes a final backup first (202) unless told to skip it. */
  async terminate(domain: string): Promise<void> {
    await this.request('DELETE', `/services/${encodeURIComponent(domain)}`);
  }
}
