# Database foundation

HostBilling uses PostgreSQL with Prisma ORM 7. The database code lives in
`packages/database`; API, worker, and other workspace packages should use this
package rather than creating their own Prisma clients.

## Local PostgreSQL

Copy the example environment file and start PostgreSQL:

```sh
cp .env.example .env
docker compose up -d postgres
```

Change `POSTGRES_PASSWORD` and the password in `DATABASE_URL` together before
using this setup beyond a local development machine. The Compose service binds
to loopback only and persists data in the `hostbilling-postgres-data` volume.

## Install and generate

From the repository root:

```sh
pnpm install
pnpm db:validate
pnpm db:generate
```

Generated Prisma Client code is written to
`packages/database/src/generated/prisma` and is intentionally not committed.

## Migrations

Create a migration during development:

```sh
pnpm db:migrate:dev -- --name describe_change
```

Apply committed migrations in a deployment:

```sh
pnpm db:migrate:deploy
```

Inspect migration state:

```sh
pnpm --filter @hostbilling/database db:migrate:status
```

Never run `prisma migrate dev` against production. Production deployments
should apply reviewed migration files with `migrate deploy`. Do not reset a
database containing data to resolve migration drift; inspect and reconcile the
migration history first.

## Initial data model

The first migration deliberately establishes only the identity and tenant
boundary:

- `Tenant`: one hosting business/account using this HostBilling installation.
- `User`: a login identity, globally unique by email.
- `TenantMembership`: the user's role within a tenant.

A user may belong to more than one tenant. Every tenant-owned business record
added in later milestones must carry a tenant foreign key, and every query
path must scope reads and writes to the authenticated tenant. The database
schema alone does not provide row-level tenant isolation.

Store email addresses in normalized lowercase form in application code before
creating or looking up users. Passwords must be hashed with a suitable password
hashing algorithm; `passwordHash` must never contain plaintext credentials.

The initial schema intentionally does not include products, services, invoices,
payments, or provisioning records. Those domain models will be introduced in
separate, reviewable milestones.
