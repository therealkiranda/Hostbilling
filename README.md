# HostBilling

**Open-source hosting commerce and billing platform.**

HostBilling helps hosting companies sell and manage shared web hosting under their own brands. Each installation is designed to include a public storefront, an administration panel, and a customer portal.

> **Project status:** Early development. Interfaces, APIs, database structures, and integrations are not production-ready yet.

## Project goals

- A polished, responsive, white-label hosting storefront.
- Customer registration, checkout, invoices, and service management.
- An administration panel for products, customers, billing, and operations.
- Reliable payment processing through provider adapters.
- Shared-hosting provisioning through a first-class HostPanel integration.
- Clear installation, upgrade, backup, and recovery workflows.
- Strong tenant isolation and secure handling of customer and payment data.

## Initial scope

The first release focuses on **shared web hosting**. Customers use domains they already own; domain registration and registrar integrations are not part of the initial scope.

The architecture is planned as a TypeScript modular monolith with separate web applications and background workers. HostPanel is an integration, not a runtime dependency of the core billing platform.

## Technology foundation

- Node.js 22 and TypeScript
- pnpm workspaces
- Fastify REST API
- PostgreSQL 17
- Prisma ORM 7 with the PostgreSQL driver adapter
- React and Vite for the planned web applications
- Redis and BullMQ for planned background jobs
- Vitest for API tests

## Repository layout

```text
apps/
  api/          HTTP API
  storefront/   Public customer-facing storefront
  admin/        Hosting company administration
  portal/       Customer account and service portal
  worker/       Background jobs and scheduled work
packages/
  database/     PostgreSQL schema, migrations, and Prisma client
infrastructure/ Local and deployment infrastructure
docs/           Product, architecture, and developer documentation
tests/          Cross-application and end-to-end tests
```

Directories will be populated incrementally as each milestone is implemented and tested.

## Local development

Requirements: Node.js 22.14+, pnpm 10+, and Docker with Compose.

```sh
cp .env.example .env
docker compose up -d postgres
pnpm install
pnpm db:validate
pnpm db:generate
pnpm dev:api
```

The API listens on port 4000 by default. PostgreSQL setup and migration commands are documented in [docs/database.md](docs/database.md). Authentication endpoints, JWT configuration, and tenant authorization are documented in [docs/authentication.md](docs/authentication.md).

## Development principles

1. Build in small, reviewable milestones.
2. Test each feature before moving on.
3. Keep financial records auditable and immutable.
4. Enforce tenant isolation at every data-access boundary.
5. Verify payment notifications server-to-server; never trust browser redirects as proof of payment.
6. Make provisioning and payment workflows idempotent and recoverable.
7. Avoid unnecessary dependencies and decorative UI patterns.
8. Document operational requirements, backups, and recovery procedures.

## Contributing

Contribution guidance will be added as the development workflow is established. Please open an issue before starting substantial changes so the scope can be discussed.

## License

HostBilling is licensed under the [Apache License 2.0](LICENSE).
