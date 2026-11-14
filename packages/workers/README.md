# @atlasauth/workers

Atlas for Cloudflare Workers, Deno, Bun and any runtime that speaks Web `Request` and `Response`, with no framework. It verifies the session locally against cached keys (no call to Atlas on the hot path), gates routes on a signed-in user and a permission, rate limits, spends metered grant usage, protects an API with Atlas-issued OAuth access tokens and receives signed webhooks.

```ts
import { createAtlas } from '@atlasauth/workers';

// Options can be a function of the Worker's bindings: the verifier is built once per `env`.
const atlas = createAtlas((env: Env) => ({ jwksUrl: env.ATLAS_JWKS_URL, issuer: env.ATLAS_ISSUER }));

export default {
  fetch: atlas.withAuth(
    async (request, { auth, env }) => Response.json({ userId: auth.userId, orgId: auth.orgId }),
    { permission: 'org:billing:read' }, // optional: permission, role, plan, feature, anyPermission, allPermissions
  ),
};
```

`createAtlas` also takes plain options (`{ jwksUrl, issuer }`) for Deno and Bun:

```ts
// Deno
Deno.serve(atlas.withAuth((req, { auth }) => Response.json({ id: auth.userId })));
// Bun
Bun.serve({ fetch: atlas.withAuth((req, { auth }) => Response.json({ id: auth.userId })) });
```

## Reading the session

`atlas.authenticate(request, env?)` returns the auth object: `userId`, `sessionId`, `orgId`, `orgRole`, `claims`, `isSignedIn`, and `has(condition)` / `protect(condition)`. The `Authorization: Bearer` header wins over the `__session` cookie. A token that fails verification is signed out, never an error.

`atlas.requireAuth(request, condition?, env?)` returns the auth object, or a ready 401 (signed out) or 403 (condition unmet) `Response` to return as is.

## Rate limits and grant usage

Build the limiter and the usage gate with `createRateLimiter` and `createUsageGate` from `@atlasauth/backend`, then:

```ts
const limit = atlas.rateLimit(limiter);            // by user, org, machine and address
const spend = atlas.grantUsage({ gate, counter: 'orders' });

const auth = await atlas.authenticate(request, env);
const verdict = await limit(request, auth);
if (verdict instanceof Response) return verdict;   // 429 with Retry-After and RateLimit-* headers
const response = Response.json({ ok: true });
return atlas.withHeaders(response, verdict.headers);
```

The address comes from `cf-connecting-ip`, then `x-forwarded-for`; pass `{ ip: (request) => ... }` when neither is trustworthy for you. A store or usage call that throws is an error, never an allow. `grantUsage` returns 429 when the counter is spent and 403 when the grant is missing or expired.

## Protecting an API with OAuth access tokens

```ts
const access = atlas.requireAccessToken({ issuer, audience: 'https://api.example.com', jwksUrl, requiredScopes: ['orders:read'] });
const result = await access(request);
if (result instanceof Response) return result;     // 401 or 403 with the WWW-Authenticate challenge
// result.claims, result.subject, result.clientId, result.scopes
```

## Webhooks

```ts
export default { fetch: atlas.webhook({ secret: env.ATLAS_WEBHOOK_SECRET, onEvent: async (event) => { /* ... */ } }) };
```

The handler verifies the signature on the raw body (Web Crypto only), rejects stale deliveries, dedupes by event id and answers 500 when `onEvent` throws so Atlas retries.
