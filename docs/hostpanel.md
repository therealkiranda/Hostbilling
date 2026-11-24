# HostPanel connection

HostBilling creates, suspends and removes customers' websites by calling the
provider's own HostPanel (`/api/v1`). Each provider connects their own panel;
nothing is shared between providers.

## Connecting a panel

Only a provider **owner** can manage the connection, because the key can create
and delete websites.

| Method and path               | What it does                                                                                                                                                       |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `PUT /tenant/hostpanel`       | Save `{ baseUrl, apiKey, defaultType?, defaultPhp? }`. The key is checked against the panel (`GET /api/v1/ping`) first; a wrong key is a 422 and nothing is saved. |
| `GET /tenant/hostpanel`       | Shows the address and settings. The key is never returned, only `hasKey: true`.                                                                                    |
| `POST /tenant/hostpanel/test` | Checks that the saved key still works.                                                                                                                             |
| `DELETE /tenant/hostpanel`    | Disconnects. Existing websites are left alone.                                                                                                                     |

Keys are encrypted at rest with AES-256-GCM using `SECRETS_KEY`
(`openssl rand -base64 32`). Without `SECRETS_KEY` the server refuses to store
keys (503). If the key is lost or changed, providers must save their
connection again.

### Address rules (server-side request safety)

The server makes requests to an address the provider typed, so the address is
restricted: `https://` only, origin only (no path, query or credentials), and it
must resolve to public addresses. Loopback, private, link-local and IPv4-mapped
IPv6 addresses are refused, and the check runs again before every call.
Redirects are never followed. For local development only, set
`HOSTPANEL_ALLOW_PRIVATE_HOSTS=true` to allow `http://` and private addresses.

Known limit: a hostname that changes its DNS answer between our check and the
connection (DNS rebinding) is not fully excluded. Connecting through a pinned
address is a possible later hardening.

## What syncs when

The panel is made to match the subscription status:

| Subscription becomes  | Panel action                                                                                                                           |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `ACTIVE` (first time) | `POST /services` with the domain, a login derived from the customer, the plan's disk and bandwidth, and `externalId` = subscription ID |
| `SUSPENDED`           | `POST /services/:domain/suspend`                                                                                                       |
| `ACTIVE` again        | `POST /services/:domain/unsuspend`                                                                                                     |
| `CANCELLED`           | `DELETE /services/:domain` (HostPanel takes a final backup first)                                                                      |

- Nothing is created for `PENDING` orders.
- Customers share one panel login: the username is `c` plus the first 12 hex
  characters of the customer ID.
- The subscription needs a `domain` (storefront orders have one; staff-created
  subscriptions accept an optional `domain`) and the customer needs an email.
- Provider with no connected panel: nothing changes, and responses have no
  `panel` field.

### Results and retries

The status change is saved first and is never undone by a panel problem. The
response then includes `panel`:

```json
{ "kind": "synced", "panelState": "ACTIVE", "credentials": { "...": "shown once" } }
{ "kind": "failed", "panelState": "NOT_SYNCED", "error": "Another task is running" }
{ "kind": "skipped", "reason": "..." }
```

- **Credentials** (the first login for the customer) appear only in the response
  to the call that created the website. HostBilling never stores them. Staff
  must pass them on to the customer immediately.
- On failure the subscription keeps `panelState` at the last completed step and
  stores `panelError` (up to 500 characters). Fix the cause, then
  `POST /tenant/subscriptions/:id/panel-sync` (owner or admin) to retry. Every step
  is safe to repeat. The same endpoint provisions subscriptions that were
  activated before a panel was connected.
- `Subscription.panelState`: `NOT_SYNCED`, `ACTIVE`, `SUSPENDED`, `TERMINATED`,
  with `panelSyncedAt` and `panelError`.

## Not built yet

- Plan changes (upgrade or downgrade) are not pushed to the panel.
- Failed syncs are retried by hand; there is no background retry worker.
- No email delivers the first login to the customer.
- Existing websites on the panel are not imported.
