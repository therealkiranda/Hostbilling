# Tenant payments

A payment records money received against one invoice. Every endpoint requires a valid access token and an active membership selected through the `x-tenant-id` header. The tenant ID comes only from the resolved membership.

## Endpoints

- **GET `/tenant/payments`** — any active tenant member can list payments. Filters: `status`, `invoiceId`, `customerId`, `page`, `pageSize` (default 25, maximum 100).
- **GET `/tenant/payments/:paymentId`** — any active tenant member can read one payment.
- **POST `/tenant/invoices/:invoiceId/payments`** — OWNER, ADMIN, or BILLING can record a payment for an open invoice.
- **POST `/tenant/payments/:paymentId/reverse`** — OWNER or ADMIN can reverse a completed payment.

## Recording a payment

The request body accepts:

- `method` (required): `BANK_TRANSFER`, `CASH`, `MOBILE_WALLET`, or `OTHER`.
- `reference` (optional): a transaction or receipt reference, up to 200 characters.
- `note` (optional): up to 1000 characters.
- `paidAt` (optional): an ISO 8601 timestamp for when the money arrived. It defaults to now and cannot be in the future (a five-minute clock tolerance applies).

The amount and currency are always taken from the invoice. Unknown fields, including an amount, currency, customer, tenant, or status, are rejected. This milestone records full payments only, so a request can never under-settle or over-settle an invoice.

Recording a payment marks the invoice `PAID` and sets its `paidAt`. The invoice update and the payment record happen in one transaction. The invoice update only applies while the invoice is `OPEN`, so two simultaneous payments cannot both succeed. Only open invoices accept payments; paid and void invoices return 409.

Each payment stores the user who recorded it.

## Reversing a payment

Payments are never edited or deleted. If a payment was recorded in error, reversing it:

- marks the payment `REVERSED` and stores the time and the user who reversed it,
- returns the invoice to `OPEN` and clears its `paidAt`,
- keeps the payment record for the audit trail.

Both changes succeed together or neither is kept. After a reversal, the correct payment can be recorded against the invoice. A reversed payment cannot be reversed again.

## One live payment per invoice

Each payment has an `activeKey` equal to its invoice ID while it is `COMPLETED`, and null once reversed. A unique key on the tenant and `activeKey` lets the database guarantee at most one completed payment per invoice, even if two requests race.

## Isolation

Payments reference their invoice and customer through foreign keys that include the tenant ID, so a row can never point at another tenant's records. Payments are not hard-deletable. Invoices and customers from another tenant are reported as not found.

Partial payments, refunds, online gateways (eSewa, Khalti), receipts, and renewals are separate milestones.
