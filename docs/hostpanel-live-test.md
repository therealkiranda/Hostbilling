# Testing against a real HostPanel

Two stages. Do stage 1 first; it needs no database and takes a few minutes.

## What you need

1. **A HostPanel (1.0.8 or newer) that is not serving real customers yet.** The test
   creates and removes one real website.
2. **A panel address with a valid certificate**, for example `https://panel.example.com`
   (the panel domain uses port 443). The default `https://SERVER-IP:8443` address usually
   has a self-signed certificate, which the API refuses.
3. **A test domain** such as `hbtest.example.com`. Point its DNS A record at the panel
   server so the certificate step can succeed.
4. **A dedicated API key.** Panel → Billing API → New key, scope `write`. Put the address
   of the machine that runs the test in _Allowed IP addresses_ (find it with
   `curl ifconfig.me` on that machine). The key is shown once. Revoke it afterwards.
5. **A machine with Node 22 and pnpm 10** that can reach the panel: your laptop, a VPS,
   or Termux. Clone the repo and run `pnpm install`.

## Stage 1: panel smoke test

```bash
HOSTPANEL_URL=https://panel.example.com \
HOSTPANEL_KEY=hpk_xxxxxxxx_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx \
SMOKE_DOMAIN=hbtest.example.com \
pnpm panel:smoke
```

It checks, in order: the key, server details, create a website, repeat the create call
(must not make a second site or a new password), look it up, suspend, unsuspend, remove
(waits for the final backup), confirm it is gone, remove the test login. It prints
`PASS` or `FAIL` for each step. Send me the whole output if anything fails.

If a step fails midway, remove `hbtest.example.com` and its login in the panel by hand.

## Stage 2: the whole system

Run the API where it can reach the panel and Postgres (a small VPS is simplest).

1. Create a PostgreSQL database and copy `.env.example` to `.env`. Set `DATABASE_URL`,
   `JWT_SECRET` (long random text) and `SECRETS_KEY` (`openssl rand -base64 32`).
   Keep the same `SECRETS_KEY` from now on.
2. `pnpm db:generate && pnpm db:migrate:deploy`, then `pnpm --filter @hostbilling/api dev`.
3. Register a provider, then use the returned `accessToken` and tenant ID:

```bash
API=http://localhost:4000
curl -s $API/auth/register -H 'content-type: application/json' -d '{
  "organizationName":"Test Hosting","tenantSlug":"test-hosting",
  "email":"you@example.com","password":"a-long-test-password"}'
# save accessToken as TOKEN and tenant.id as TENANT

H=(-H "authorization: Bearer $TOKEN" -H "x-tenant-id: $TENANT" -H 'content-type: application/json')

# connect the panel (checks the key first)
curl -s -X PUT $API/tenant/hostpanel "${H[@]}" -d '{
  "baseUrl":"https://panel.example.com","apiKey":"hpk_..."}'

# a plan
curl -s $API/tenant/hosting-plans "${H[@]}" -d '{
  "slug":"starter","name":"Starter","status":"ACTIVE","priceMinorUnits":50000,
  "currency":"NPR","billingInterval":"MONTH","diskQuotaMb":5000,"bandwidthQuotaMb":50000}'

# an order, as a visitor would place it
curl -s $API/public/tenants/test-hosting/orders -H 'content-type: application/json' -d '{
  "planId":"PLAN_ID","name":"Test Customer","email":"customer@example.com",
  "domain":"hbtest.example.com"}'

# activate it: this creates the website
curl -s $API/tenant/subscriptions "${H[@]}"   # find the subscription id
curl -s -X POST $API/tenant/subscriptions/SUB_ID/activate "${H[@]}"
```

The activation response contains `panel.credentials`: the customer's first login. It
appears only once. Then try `/suspend`, activate again, and `/cancel`, checking the panel
after each.

## Things to watch

- **A cancelled customer who orders again.** HostPanel closes a client's login when
  their last website is removed. Provisioning again with the same login may answer
  `client_disabled` or `client_conflict` (409). HostBilling records the message and
  shows it to staff but cannot yet recover on its own. Tell me if you see it.
- **Key IP restriction.** An `ip_not_allowed` error means the key's allowed list does not
  include the machine running the API.
- **`busy`.** The panel runs one background task at a time. Retry with
  `POST /tenant/subscriptions/SUB_ID/panel-sync`.
- **Port 8443 restricted.** If _Settings → Direct access_ limits 8443, use the panel
  domain (port 443) or allow the API machine there too.
