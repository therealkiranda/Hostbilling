# Storefront

The storefront is the public website where a hosting company's customers compare plans and place an order. It lives in `apps/storefront` (React and Vite) and talks to two public API endpoints that need no sign-in.

## Public API

- **GET `/public/tenants/:tenantSlug/plans`** — the provider's name and its `ACTIVE` plans, cheapest first. A visitor only receives the fields needed to compare plans (name, description, price, setup fee, currency, billing period, and resource limits). Draft and archived plans, tenant IDs, and timestamps are never returned. An unknown or inactive provider returns 404.
- **POST `/public/tenants/:tenantSlug/orders`** — places an order for one plan.

### Placing an order

The body accepts `planId`, `name`, `email`, `domain`, and optionally `phone` and `companyName`. Unknown fields are rejected, so a visitor cannot set a tenant, price, or status. The email and domain are trimmed and lowercased, and the domain must be a real host name without a scheme or path.

An order creates a `PENDING` subscription. The plan's price, setup fee, currency, and billing period are copied onto it, and the requested domain is stored in `Subscription.domain`. Nothing is billed or provisioned. Staff review the order, activate the subscription, and issue the first invoice.

- If a customer with that email already exists in the tenant, they are reused and their saved details are **not** changed. A public form can never rewrite a customer record.
- Submitting the same order twice (same customer, plan, and domain while still pending) returns the existing order with status 200 instead of creating a duplicate.
- An inactive customer cannot order and receives 422.
- Orders are limited to 10 per minute per client address, on top of the API's general limit.

The response contains an `order.reference`, which is the first eight characters of the subscription ID in capitals. Staff can use it to find the order, and the customer sees it on the confirmation.

## Cross-origin access

Browsers can call the API from another domain only if that domain is listed in `CORS_ORIGINS` (comma separated). Leaving it empty sends no CORS headers. In development the storefront avoids the issue by calling `/api`, which Vite forwards to the API.

## Running it

```sh
pnpm dev:api          # API on http://localhost:4000
pnpm dev:storefront   # storefront on http://localhost:5173
```

Open `http://localhost:5173/<provider-slug>`. The first part of the address selects the provider. To use one provider for the whole site, set `VITE_TENANT_SLUG` at build time. Set `VITE_API_URL` at build time when the API is on a different domain (and add the storefront's address to `CORS_ORIGINS`).

```sh
pnpm test:storefront   # unit tests for formatting and validation
pnpm build:storefront  # type-check and production build in apps/storefront/dist
```

The production build is static files, so it can be hosted on any static host.

## Design

Plans are shown as a spec sheet instead of a row of cards. Each resource (disk space, data transfer, domains, email accounts, databases, FTP accounts) has a segmented level meter scaled against the largest plan for that resource, so the difference between plans is visible at a glance. The value is always written next to the meter. The meters fill in once when the page loads, and not at all when the visitor prefers reduced motion.

- With four plans or fewer, wide screens show the side-by-side sheet. Narrow screens, and providers with more than four plans, show one panel per plan.
- Type is Archivo, self-hosted through `@fontsource-variable/archivo`. Its width axis is used for the extra-wide headline and the condensed plan names.
- Colours are defined as variables at the top of `src/styles.css`. Crimson is used only for the order buttons.
- The order form is a native `<dialog>`, which traps focus and closes on Escape. Fields have visible labels, errors are written next to the field and linked with `aria-describedby`, and the first invalid field receives focus.
- Loading, empty, not-found, and failed-request states each say what happened and what to do.

## Not included yet

Order confirmation emails, a customer portal to track an order, payment gateways, a Nepali-language version, and per-provider logos and colours are separate milestones.
