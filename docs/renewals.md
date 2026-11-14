# Subscription renewals

Renewing moves an active subscription to its next billing period and issues that period's invoice. Every endpoint requires a valid access token and an active membership selected through the `x-tenant-id` header. The tenant ID comes only from the resolved membership.

## Endpoint

- **POST `/tenant/subscriptions/:subscriptionId/renew`** — OWNER, ADMIN, or BILLING can renew a subscription. The optional body field `dueInDays` (0 to 90, default 7) sets the due date of the new invoice. Unknown fields are rejected, so a request cannot choose dates, amounts, or a tenant.

A successful renewal returns 201 with the updated `subscription` and the new `invoice`.

## When a subscription can be renewed

All of these must be true, otherwise the request returns 409:

- The subscription is `ACTIVE` and has a running billing period.
- The current period ends within the next 14 days, or has already ended. Renewing earlier is refused.
- The invoice for the current period exists and is `PAID`. A voided or unpaid current period blocks renewal.

Because the new period is invoiced in advance, a renewal can move `currentPeriodStart` a few days into the future while the customer is still using the old period.

## How the new period is calculated

The new period starts where the current one ends. Its end is measured from the subscription's original start date, not from the previous end date. `Subscription.billedPeriods` counts the periods billed so far, and the end of period _n_ is the start date plus _n_ billing intervals.

This matters for month ends. A subscription that started on 31 January ends its first period on 28 February, and its second on 31 March. Chaining each period from the previous end date would drift it to the 28th permanently.

## What the invoice contains

The invoice is built from the subscription's pricing snapshot, using the same code as `POST /tenant/subscriptions/:subscriptionId/invoices`. It has one line for the recurring charge. The setup fee is never repeated, because it is billed on the first period only.

## Safety

- The period change and its invoice are created in one transaction. If either fails, neither is kept.
- The period change only applies if `billedPeriods` still has the value that was read, so two simultaneous renewals cannot both advance the subscription. The loser receives 409.
- One live invoice per period still applies: a second invoice for the same period is refused.
- A total that does not fit in a 32-bit integer is refused with 422 before anything changes.

## Not included yet

Renewal is triggered by an API call. A scheduled worker that renews subscriptions automatically, overdue reminders, and automatic suspension for unpaid invoices are separate milestones.
