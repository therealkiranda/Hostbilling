# Tenant hosting plans

Hosting plans belong to a single hosting-company tenant. Every endpoint requires a valid access token and an active membership selected through the `x-tenant-id` header. The API derives the tenant ID from the resolved membership; request bodies cannot select or override it.

## Endpoints

| Method | Endpoint | Access | Purpose |
| --- | --- | --- | --- |
| GET | `/tenant/hosting-plans` | Any active tenant member | List plans; optional `?status=DRAFT`, `ACTIVE`, or `ARCHIVED` filter |
| POST | `/tenant/hosting-plans` | OWNER, ADMIN | Create a plan |
| PATCH | `/tenant/hosting-plans/:planId` | OWNER, ADMIN | Update a plan belonging to the selected tenant |

## Plan fields

- `slug`, `name`, optional `description`
- `status`: DRAFT, ACTIVE, ARCHIVED (new plans default to DRAFT)
- `priceMinorUnits`, `setupFeeMinorUnits`, and three-letter uppercase ISO currency code
- `billingInterval`: MONTH or YEAR, with `intervalCount`
- Resource limits: `diskQuotaMb`, `bandwidthQuotaMb`, `maxDomains`, `maxEmailAccounts`, `maxDatabases`, and `maxFtpAccounts`

All monetary amounts are integer minor units to avoid floating-point currency errors. For example, NPR 1,250.00 is represented as 125000 with currency `NPR`.

The plan slug is unique within a tenant, not globally. List and update queries always include the authenticated tenant ID. An ID belonging to another tenant is reported as not found.

## Example create request

```http
POST /tenant/hosting-plans
Authorization: Bearer <access-token>
x-tenant-id: <tenant-uuid>
Content-Type: application/json
```

```json
{
  "slug": "starter",
  "name": "Starter",
  "description": "Entry-level shared hosting",
  "priceMinorUnits": 125000,
  "setupFeeMinorUnits": 0,
  "currency": "NPR",
  "billingInterval": "YEAR",
  "intervalCount": 1,
  "diskQuotaMb": 10240,
  "bandwidthQuotaMb": 102400,
  "maxDomains": 1,
  "maxEmailAccounts": 10,
  "maxDatabases": 2,
  "maxFtpAccounts": 2
}
```

New plans are drafts. A future storefront milestone will expose only active plans through public, read-only tenant storefront routes. Provisioning, subscriptions, invoice snapshots, and payment collection are separate milestones.
