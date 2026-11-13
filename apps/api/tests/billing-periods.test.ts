import { describe, expect, it } from 'vitest';
import { addBillingInterval } from '../src/billing-periods.js';

describe('addBillingInterval', () => {
  it('adds whole months', () => {
    const result = addBillingInterval(new Date('2026-01-15T10:00:00.000Z'), 'MONTH', 1);
    expect(result.toISOString()).toBe('2026-02-15T10:00:00.000Z');
  });

  it('clamps to the last day of a shorter month', () => {
    expect(addBillingInterval(new Date('2026-01-31T00:00:00.000Z'), 'MONTH', 1).toISOString()).toBe(
      '2026-02-28T00:00:00.000Z',
    );
    expect(addBillingInterval(new Date('2028-01-31T00:00:00.000Z'), 'MONTH', 1).toISOString()).toBe(
      '2028-02-29T00:00:00.000Z',
    );
  });

  it('rolls across year boundaries', () => {
    const result = addBillingInterval(new Date('2026-11-30T00:00:00.000Z'), 'MONTH', 3);
    expect(result.toISOString()).toBe('2027-02-28T00:00:00.000Z');
  });

  it('adds years and clamps a leap day', () => {
    expect(addBillingInterval(new Date('2028-02-29T00:00:00.000Z'), 'YEAR', 1).toISOString()).toBe(
      '2029-02-28T00:00:00.000Z',
    );
    expect(addBillingInterval(new Date('2026-06-01T00:00:00.000Z'), 'YEAR', 2).toISOString()).toBe(
      '2028-06-01T00:00:00.000Z',
    );
  });

  it('rejects non-positive or fractional counts', () => {
    expect(() => addBillingInterval(new Date(), 'MONTH', 0)).toThrow(RangeError);
    expect(() => addBillingInterval(new Date(), 'MONTH', 1.5)).toThrow(RangeError);
  });
});
