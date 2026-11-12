# Tenant customer management

Customer records belong to one hosting-company tenant. Every endpoint requires a valid access token and an active membership selected through the `x-tenant-id` header. The API derives the tenant ID from the resolved membership; request bodies cannot select or override it.

## Endpoints

| Method | Endpoint | Access | Purpose |
| --- | --- | --- | --- |
| GET | `/tenant/customers` | Any active tenant member | List, search, filter, and paginate customers |
| GET | `/tenant/customers/:customerId` | Any active tenant member | Read one customer belonging to the selected tenant |
| POST | `/tenant/customers` | OWNER or ADMIN | Create a customer |
| PATCH | `/tenant/customers/:customerId` | OWNER or ADMIN | Update a customer belonging to the selected tenant |

All endpoints require:

```http
Authorization: Bearer <access-token>
x-tenant-id: <tenant-uuid>
```

## Customer fields

- `name` — required contact/customer name
- `email` — optional email address, normalized to lowercase
- `phone` — optional phone number
- `companyName` — optional company or organization
- `notes` — optional internal notes
- `status` — `ACTIVE` or `INACTIVE`; new customers default to `ACTIVE`

Email addresses are unique within a tenant when provided. Different tenants may use the same email address. Customers without an email address are allowed.

## List and search

`GET /tenant/customers?q=jane&status=ACTIVE&page=1&pageSize=25`

- `q` searches name, email, and company name (case-insensitive).
- `status` optionally filters by `ACTIVE` or `INACTIVE`.
- `page` defaults to 1.
- `pageSize` defaults to 25 and is capped at 100.

The response includes `customers` and pagination metadata: `page`, `pageSize`, `total`, and `totalPages`.

## Tenant isolation and lifecycle

Every list, read, update, and count query is scoped by the authenticated tenant ID. A customer ID belonging to another tenant returns 404. The tenant ID is never accepted from request bodies. Duplicate email addresses within the same tenant return 409.

Customer records are deactivated using `status: "INACTIVE"`; this milestone does not expose hard deletion. Customer records are the tenant's billing contacts foundation. Services, subscriptions, invoice snapshots, payments, and automated provisioning are separate milestones.
