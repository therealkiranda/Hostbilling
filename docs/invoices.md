# Tenant invoices

An invoice is the immutable bill for one billing period of one subscription. Every endpoint requires a valid access token and an active membership selected through the `x-tenant-id` header. The tenant ID comes only from the resolved membership.

## Endpoints

- **GET `/tenant/invoices`** — any active tenant member can list invoices. Filters: `status`, `customerId`, `subscriptionId`, `page`, `pageSize` (default 25, maximum 100).
- **GET `/tenant/invoices/:invoiceId`** — any active tenant member can read an invoice with its line items.
- **POST `/tenant/subscriptions/:subscriptionId/invoices`** — OWNER, ADMIN, or BILLING can generate the invoice for the subscription's current billing period. The optional body field `dueInDays` (0 to 90, default 7) sets the due date.
- **POST `/tenant/invoices/:invoiceId/void`** — OWNER, ADMIN, or BILLING can void an open invoice.

## How an invoice is built

The server builds the invoice from the subscription's pricing snapshot. The request body cannot set amounts, currency, customer, or tenant, and unknown fields are rejected.

- One line item for the recurring plan charge, labelled with the plan name and period dates.
- A second line item for the one-time setup fee, only on the invoice for the subscription's first period.
- `subtotalMinorUnits` and `totalMinorUnits` are integer minor units. There is no tax or discount yet, so they are equal.

Only `ACTIVE` subscriptions can be invoiced. A total that does not fit in a 32-bit integer is refused with 422.

## Numbering

Each tenant has its own sequence: `INV-000001`, `INV-000002`, and so on. The counter is incremented atomically inside the same transaction that creates the invoice, so concurrent requests never share a number, and a number is unique per tenant. A failed transaction rolls the counter back, so an invoice that was never created never consumes a number.

## One live invoice per period

A period can have only one non-void invoice. A second request for the same period returns 409, including when two requests race, because the database enforces it with a unique key. Voiding an invoice releases the period so a corrected invoice can be generated.

## Immutability

Invoices have no update endpoint. The only permitted change is `OPEN` to `VOID`, guarded by the current status so concurrent requests cannot both succeed. Voided invoices keep their number and line items for the audit trail. Recording a payment sets `PAID`, and reversing that payment returns the invoice to `OPEN`; see [payments](payments.md). A paid invoice cannot be voided.

## Isolation

Invoices reference their customer and subscription through foreign keys that include the tenant ID, so a row can never point at another tenant's records. Invoices and line items are not hard-deletable.

Payments are covered in [payments](payments.md) and period renewal in [renewals](renewals.md). Tax, emails, and HostPanel provisioning are separate milestones.
