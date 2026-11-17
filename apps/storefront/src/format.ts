const MB_PER_GB = 1024;
const MB_PER_TB = 1024 * 1024;

const trimmed = (value: number): string => String(Math.round(value * 10) / 10);

/** Formats a storage or transfer quota given in megabytes. */
export function formatStorage(megabytes: number): string {
  if (megabytes >= MB_PER_TB) {
    return `${trimmed(megabytes / MB_PER_TB)} TB`;
  }

  if (megabytes >= MB_PER_GB) {
    return `${trimmed(megabytes / MB_PER_GB)} GB`;
  }

  return `${megabytes} MB`;
}

/** Formats a count, showing a word instead of zero. */
export function formatCount(value: number, zeroLabel = 'None'): string {
  return value === 0 ? zeroLabel : value.toLocaleString('en');
}

/** How much of a meter to fill, as a fraction. Any non-zero value shows at least a sliver. */
export function meterRatio(value: number, max: number): number {
  if (value <= 0 || max <= 0) {
    return 0;
  }

  return Math.min(1, Math.max(value / max, 0.04));
}

export interface PriceParts {
  symbol: string;
  amount: string;
}

function fractionDigits(currency: string): number {
  return (
    new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions()
      .maximumFractionDigits ?? 2
  );
}

/** Splits a price in minor units into a currency symbol and a number, for display. */
export function formatPriceParts(minorUnits: number, currency: string): PriceParts {
  try {
    const digits = fractionDigits(currency);
    const value = minorUnits / 10 ** digits;
    const parts = new Intl.NumberFormat('en', {
      style: 'currency',
      currency,
      currencyDisplay: 'narrowSymbol',
      minimumFractionDigits: Number.isInteger(value) ? 0 : digits,
      maximumFractionDigits: digits,
    }).formatToParts(value);

    return {
      symbol: parts
        .filter((part) => part.type === 'currency')
        .map((part) => part.value)
        .join(''),
      amount: parts
        .filter((part) => part.type !== 'currency' && part.type !== 'literal')
        .map((part) => part.value)
        .join(''),
    };
  } catch {
    return { symbol: currency, amount: String(minorUnits / 100) };
  }
}

/** A price as one string, for sentences. */
export function formatPrice(minorUnits: number, currency: string): string {
  const { symbol, amount } = formatPriceParts(minorUnits, currency);
  // A non-breaking space keeps "Rs 1,400" together when a sentence wraps.
  return /[A-Za-z]$/.test(symbol) ? `${symbol}\u00A0${amount}` : `${symbol}${amount}`;
}

/** The billing period in plain words, such as "per month" or "every 3 months". */
export function intervalLabel(interval: 'MONTH' | 'YEAR', count: number): string {
  const unit = interval === 'YEAR' ? 'year' : 'month';
  return count === 1 ? `per ${unit}` : `every ${count} ${unit}s`;
}
