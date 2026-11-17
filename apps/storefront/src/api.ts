export interface Plan {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  priceMinorUnits: number;
  setupFeeMinorUnits: number;
  currency: string;
  billingInterval: 'MONTH' | 'YEAR';
  intervalCount: number;
  diskQuotaMb: number;
  bandwidthQuotaMb: number;
  maxDomains: number;
  maxEmailAccounts: number;
  maxDatabases: number;
  maxFtpAccounts: number;
}

export interface Provider {
  name: string;
  slug: string;
}

export interface ProviderPlans {
  tenant: Provider;
  plans: Plan[];
}

export interface OrderRequest {
  planId: string;
  name: string;
  email: string;
  phone?: string;
  companyName?: string;
  domain: string;
}

export interface OrderReceipt {
  reference: string;
  status: string;
  plan: { name: string };
  domain: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly fields: string[];

  constructor(status: number, message: string, fields: string[] = []) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.fields = fields;
  }
}

const API_BASE = (import.meta.env.VITE_API_URL ?? '/api').replace(/\/+$/, '');

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { accept: 'application/json', ...init?.headers },
  });

  const body: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const data = (body ?? {}) as { error?: unknown; details?: unknown };
    const message = typeof data.error === 'string' ? data.error : 'Request failed';
    const fields =
      data.details && typeof data.details === 'object' ? Object.keys(data.details) : [];

    throw new ApiError(response.status, message, fields);
  }

  return body as T;
}

export function fetchPlans(slug: string, signal?: AbortSignal): Promise<ProviderPlans> {
  return request<ProviderPlans>(
    `/public/tenants/${encodeURIComponent(slug)}/plans`,
    signal ? { signal } : undefined,
  );
}

export async function placeOrder(slug: string, order: OrderRequest): Promise<OrderReceipt> {
  const { order: receipt } = await request<{ order: OrderReceipt }>(
    `/public/tenants/${encodeURIComponent(slug)}/orders`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(order),
    },
  );

  return receipt;
}
