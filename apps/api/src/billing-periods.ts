export type BillingIntervalUnit = 'MONTH' | 'YEAR';

/**
 * Returns the instant one billing interval after `start`, in UTC.
 *
 * Month arithmetic clamps to the last day of the target month, so 31 January plus
 * one month is the last day of February instead of an early-March date.
 */
export function addBillingInterval(
  start: Date,
  interval: BillingIntervalUnit,
  count: number,
): Date {
  if (!Number.isInteger(count) || count < 1) {
    throw new RangeError('Billing interval count must be a positive integer.');
  }

  const months = (interval === 'YEAR' ? 12 : 1) * count;
  const totalMonths = start.getUTCFullYear() * 12 + start.getUTCMonth() + months;
  const year = Math.floor(totalMonths / 12);
  const month = totalMonths % 12;
  const lastDayOfTargetMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();

  return new Date(
    Date.UTC(
      year,
      month,
      Math.min(start.getUTCDate(), lastDayOfTargetMonth),
      start.getUTCHours(),
      start.getUTCMinutes(),
      start.getUTCSeconds(),
      start.getUTCMilliseconds(),
    ),
  );
}
