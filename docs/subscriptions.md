# Tenant subscriptions

A subscription connects one customer to one hosting plan inside a single hosting-company tenant. It is the billing record that later milestones (invoices, payments, provisioning) will build on.

Every endpoint requires a valid access token and an active membership selected through the `x-tenant-id` header. The tenant ID comes only from the resolved membership; request bodies cannot select or override it.

## Endpoints

- **GET `/tenant/subscriptions`** — any active tenant member can list subscriptions. Filters: `status`, `customerId`, `page`, `pageSize` (default 25, maximum 100).
- **GET `/tenant/subscriptions/:subscriptionId`** — any active tenant member can read one subscription.
- **POST `/tenant/subscriptions`** — OWNER or ADMIN can create a subscription from `customerId` and `planId`. Set `activate: true` to start billing immediately.
- **POST `/tenant/subscriptions/:subscriptionId/activate`** — OWNER or ADMIN; from `PENDING` or `SUSPENDED`.
- **POST `/tenant/subscriptions/:subscriptionId/suspend`** — OWNER or ADMIN; from `ACTIVE`.
- **POST `/tenant/subscriptions/:subscriptionId/cancel`** — OWNER or ADMIN; from `PENDING`, `ACTIVE`, or `SUSPENDED`.

## Lifecycle

```text
PENDING -> ACTIVE <-> SUSPENDED
   |          |           |
   +----------+-----------+--> CANCELLED (final)
```

An invalid transition returns 409. Cancelled subscriptions cannot be changed. Transitions are guarded by the current status, so two simultaneous requests cannot both succeed.

## Pricing snapshot

When a subscription is created, the plan's price, setup fee, currency, billing interval, and interval count are copied onto it. Later edits to the plan never change what an existing subscriber agreed to pay. All amounts are integer minor units.

## Billing period

The first activation sets `startedAt`, `currentPeriodStart`, and `currentPeriodEnd`. Month arithmetic is done in UTC and clamps to the last day of the target month, so a period starting on 31 January ends on the last day of February. Reactivating a suspended subscription keeps its existing period. Period renewal belongs to the invoicing milestone.

## Rules and isolation

- Only an `ACTIVE` customer can be subscribed, and only to an `ACTIVE` plan.
- Customers and plans are looked up by ID and tenant ID; one from another tenant is reported as not found.
- The database also enforces this: the subscription's customer and plan foreign keys include the tenant ID, so a row can never reference another tenant's customer or plan.
- Customers and plans with subscriptions cannot be hard-deleted.

Invoices, payments, renewals, and HostPanel provisioning are separate milestones.
