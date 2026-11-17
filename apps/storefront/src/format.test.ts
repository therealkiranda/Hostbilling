import { describe, expect, it } from 'vitest';
import {
  formatCount,
  formatPrice,
  formatPriceParts,
  formatStorage,
  intervalLabel,
  meterRatio,
} from './format';
import { resolveProviderSlug } from './provider';
import { normalizeDomain, validateOrder } from './validation';

describe('formatStorage', () => {
  it('uses the largest sensible unit', () => {
    expect(formatStorage(512)).toBe('512 MB');
    expect(formatStorage(1024)).toBe('1 GB');
    expect(formatStorage(10240)).toBe('10 GB');
    expect(formatStorage(1536)).toBe('1.5 GB');
    expect(formatStorage(1024 * 1024)).toBe('1 TB');
    expect(formatStorage(2.5 * 1024 * 1024)).toBe('2.5 TB');
  });
});

describe('formatCount', () => {
  it('names zero instead of showing it', () => {
    expect(formatCount(0)).toBe('None');
    expect(formatCount(0, 'Not included')).toBe('Not included');
    expect(formatCount(25)).toBe('25');
    expect(formatCount(1200)).toBe('1,200');
  });
});

describe('meterRatio', () => {
  it('scales against the largest plan', () => {
    expect(meterRatio(50, 100)).toBe(0.5);
    expect(meterRatio(100, 100)).toBe(1);
  });

  it('shows a sliver for small non-zero values and nothing for zero', () => {
    expect(meterRatio(1, 1000)).toBe(0.04);
    expect(meterRatio(0, 100)).toBe(0);
    expect(meterRatio(5, 0)).toBe(0);
  });
});

describe('prices', () => {
  it('converts minor units and drops empty decimals', () => {
    expect(formatPriceParts(125000, 'NPR').amount).toBe('1,250');
    expect(formatPriceParts(125050, 'NPR').amount).toBe('1,250.50');
    expect(formatPriceParts(0, 'NPR').amount).toBe('0');
  });

  it('keeps the currency symbol separate', () => {
    expect(formatPriceParts(1999, 'USD')).toEqual({ symbol: '$', amount: '19.99' });
  });

  it('respects currencies without minor units', () => {
    expect(formatPriceParts(500, 'JPY').amount).toBe('500');
  });

  it('falls back safely for an unknown currency code', () => {
    expect(formatPriceParts(1000, 'not a code')).toEqual({ symbol: 'not a code', amount: '10' });
  });

  it('writes a price as one string', () => {
    expect(formatPrice(1999, 'USD')).toBe('$19.99');
    expect(formatPrice(1000, 'xx')).toMatch(/10/);
  });
});

describe('intervalLabel', () => {
  it('describes single and multiple periods', () => {
    expect(intervalLabel('MONTH', 1)).toBe('per month');
    expect(intervalLabel('YEAR', 1)).toBe('per year');
    expect(intervalLabel('MONTH', 3)).toBe('every 3 months');
    expect(intervalLabel('YEAR', 2)).toBe('every 2 years');
  });
});

describe('resolveProviderSlug', () => {
  it('prefers the first path segment, then the default', () => {
    expect(resolveProviderSlug('/example-hosting', undefined)).toBe('example-hosting');
    expect(resolveProviderSlug('/Example-Hosting/extra', 'other')).toBe('example-hosting');
    expect(resolveProviderSlug('/', 'default-shop')).toBe('default-shop');
  });

  it('returns null when there is nothing usable', () => {
    expect(resolveProviderSlug('/', undefined)).toBeNull();
    expect(resolveProviderSlug('/bad_slug', undefined)).toBeNull();
    expect(resolveProviderSlug('/', 'has spaces')).toBeNull();
  });
});

describe('normalizeDomain', () => {
  it('strips the scheme, path, and trailing dot', () => {
    expect(normalizeDomain('  HTTPS://MyStore.com/shop?x=1 ')).toBe('mystore.com');
    expect(normalizeDomain('mystore.com.')).toBe('mystore.com');
    expect(normalizeDomain('shop.mystore.com.np')).toBe('shop.mystore.com.np');
  });
});

describe('validateOrder', () => {
  const valid = {
    name: 'Sita Sharma',
    email: 'sita@example.com',
    phone: '',
    companyName: '',
    domain: 'https://sharma-store.com.np/',
  };

  it('accepts a complete order and optional fields left empty', () => {
    expect(validateOrder(valid)).toEqual({});
    expect(
      validateOrder({ ...valid, phone: '+977 9812345678', companyName: 'Sharma Store' }),
    ).toEqual({});
  });

  it('reports every problem at once', () => {
    expect(
      Object.keys(
        validateOrder({ name: ' ', email: 'nope', phone: 'call me', companyName: '', domain: 'x' }),
      ),
    ).toEqual(['name', 'email', 'phone', 'domain']);
  });
});
