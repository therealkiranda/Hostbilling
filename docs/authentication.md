# Authentication and tenant authorization

The API uses short-lived JWT access tokens and opaque rotating refresh tokens.

## Configuration

Set a unique signing secret of at least 32 random bytes in the API environment:

```bash
openssl rand -base64 48
```

Set the result as `JWT_SECRET`. Never commit a real secret or reuse the example value.

## Endpoints

| Method | Endpoint | Purpose |
| --- | --- | --- |
| POST | `/auth/register` | Create a user, tenant, OWNER membership, and session |
| POST | `/auth/login` | Authenticate and return the user's active tenant memberships |
| POST | `/auth/refresh` | Rotate a refresh token and issue a new access token |
| POST | `/auth/logout` | Revoke the refresh-token session |
| GET | `/auth/me` | Return the authenticated user and active memberships |
| GET | `/auth/tenants` | List the authenticated user's active tenants |
| GET | `/tenant/context` | Resolve the requested tenant from an active membership |

Registration expects `organizationName`, `tenantSlug`, `email`, and `password`. The optional `name` field is the user's display name. Passwords must contain at least 12 characters. Email addresses are trimmed and lowercased before storage.

Login returns the user's active tenant memberships. A client selects the tenant for a request by sending its ID in the `x-tenant-id` header:

```http
Authorization: Bearer <access-token>
x-tenant-id: <tenant-uuid>
```

The API never treats the tenant header as authorization. Every tenant-scoped route must run both `authenticate(db)` and `requireTenant(db)`. The latter resolves the membership using the authenticated user ID and requested tenant ID, and rejects missing or suspended tenants. Use `requireTenantRole('OWNER', 'ADMIN')` (or the appropriate role set) after tenant resolution for role-restricted operations.

## Session security

- Passwords are hashed with Argon2id; plaintext passwords are never stored.
- Access tokens expire after 15 minutes.
- Refresh tokens are cryptographically random, stored only as SHA-256 hashes, and expire after 30 days.
- Refresh tokens rotate on every refresh. The database update is conditional on the previous token hash, so concurrent refresh attempts cannot both succeed.
- Each authenticated request checks that its session is still active and unexpired. Logging out revokes that session immediately, including its outstanding access tokens.
- Registration and login are rate-limited to five requests per minute per client IP. The API also has a global rate limit.

Clients must keep refresh tokens in secure platform storage and must not place them in URLs or logs. This initial milestone returns refresh tokens in the JSON response; browser clients should use a secure same-site HttpOnly cookie transport before exposing authentication to untrusted browser environments.

## Current scope

Email verification, password reset, invitation flows, MFA, organization switching UI, and session-management UI are not included yet. Email verification is not currently required to authenticate. Tenant isolation is enforced at the API request boundary; new tenant-owned database queries must always use the resolved tenant context rather than a client-supplied tenant ID alone.
