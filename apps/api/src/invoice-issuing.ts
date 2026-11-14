import type { PrismaClient } from '@hostbilling/database';

export const MAX_MINOR_UNITS = 2_147_483_647;

export const invoiceInclude = {
  lineItems: { orderBy: { createdAt: 'asc' } },
  customer: { select: { id: true, name: true, email: true } },
} as const;

const formatDate = (value: Date): string => value.toISOString().slice(0, 10);

export function formatInvoiceNumber(sequence: number): string {
  return `INV-${String(sequence).padStart(6, '0')}`;
}

export function isUniqueConstraintError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';
}

export interface BillableSubscription {
  id: string;
  customerId: string;
  currency: string;
  priceMinorUnits: number;
  setupFeeMinorUnits: number;
  startedAt: Date | null;
  plan: { name: string };
}

/**
 * Builds the invoice lines for one billing period from the subscription's own pricing
 * snapshot. The one-time setup fee is billed on the first period only.
 */
export function buildInvoiceLines(
  subscription: BillableSubscription,
  periodStart: Date,
  periodEnd: Date,
) {
  const periodLabel = `${formatDate(periodStart)} to ${formatDate(periodEnd)}`;
  const lineItems = [
    {
      description: `${subscription.plan.name} hosting (${periodLabel})`,
      quantity: 1,
      unitAmountMinorUnits: subscription.priceMinorUnits,
      amountMinorUnits: subscription.priceMinorUnits,
    },
  ];

  if (
    subscription.setupFeeMinorUnits > 0 &&
    subscription.startedAt &&
    subscription.startedAt.getTime() === periodStart.getTime()
  ) {
    lineItems.push({
      description: `${subscription.plan.name} setup fee`,
      quantity: 1,
      unitAmountMinorUnits: subscription.setupFeeMinorUnits,
      amountMinorUnits: subscription.setupFeeMinorUnits,
    });
  }

  const total = lineItems.reduce((sum, item) => sum + item.amountMinorUnits, 0);

  return { lineItems, total };
}

interface CreateInvoiceInput {
  tenantId: string;
  subscription: BillableSubscription;
  periodStart: Date;
  periodEnd: Date;
  dueInDays: number;
}

/**
 * Creates the invoice for a subscription period inside the caller's transaction.
 * Returns null when the period already has a live invoice. Voiding an invoice clears its
 * period key, so a voided period can be invoiced again.
 */
export async function createPeriodInvoice(
  transaction: Pick<PrismaClient, 'invoice' | 'tenant'>,
  { tenantId, subscription, periodStart, periodEnd, dueInDays }: CreateInvoiceInput,
) {
  const { lineItems, total } = buildInvoiceLines(subscription, periodStart, periodEnd);
  const issuedAt = new Date();
  const dueAt = new Date(issuedAt.getTime() + dueInDays * 24 * 60 * 60 * 1000);
  const periodKey = `${subscription.id}:${periodStart.toISOString()}`;

  const existing = await transaction.invoice.findFirst({
    where: { tenantId, periodKey },
    select: { id: true },
  });

  if (existing) {
    return null;
  }

  // The increment is atomic, so concurrent requests never share a number.
  const { invoiceCounter } = await transaction.tenant.update({
    where: { id: tenantId },
    data: { invoiceCounter: { increment: 1 } },
    select: { invoiceCounter: true },
  });

  return transaction.invoice.create({
    data: {
      tenantId,
      customerId: subscription.customerId,
      subscriptionId: subscription.id,
      number: formatInvoiceNumber(invoiceCounter),
      currency: subscription.currency,
      subtotalMinorUnits: total,
      totalMinorUnits: total,
      issuedAt,
      dueAt,
      periodStart,
      periodEnd,
      periodKey,
      lineItems: { create: lineItems.map((item) => ({ ...item, tenantId })) },
    },
    include: invoiceInclude,
  });
}
