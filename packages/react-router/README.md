# @atlasauth/react-router

The React Router adapter for Atlas.

## Rate limits and grant usage

Two gates sit behind your auth, both built on `@atlasauth/backend`: a rate limiter (`createRateLimiter`, fixed window, 429 with `Retry-After` and `RateLimit-*` headers) and a grant usage gate (`createUsageGate`, which consumes a named counter on a machine or agent grant: 429 when the counter is spent, 403 when the grant is missing or expired). Each wrapper takes the limiter or options, or a check you already built with `rateLimitRequest` / `requireGrantUsage`. A limit store or usage call that throws is an error, never an allow.

Build the limiter and the gate once at startup:

```ts
import { createAtlasClient, createRateLimiter, createUsageGate } from '@atlasauth/backend';

const atlas = createAtlasClient({ secretKey: process.env.ATLAS_SECRET_KEY! });
const limiter = createRateLimiter({ policies: [{ name: 'per-user', subject: 'user', limit: 100, windowSeconds: 60 }] });
const gate = createUsageGate({ client: atlas }); // or { mode: 'lease', leaseSize: 20 }
// atlasGrantUsage({ gate, counter: 'orders', amount: 1 }) spends the grant named by the token's grant_id claim.
```

```ts
import { atlasRateLimit, atlasGrantUsage } from '@atlasauth/react-router';

const limit = atlasRateLimit(limiter);
export async function loader(args: LoaderFunctionArgs) {
  const headers = await limit(args); // throws a 429 Response when over
  return data({ ok: true }, { headers });
}
```
`atlasGrantUsage` needs `{ claims: (args) => ... }` returning the verified token claims.
