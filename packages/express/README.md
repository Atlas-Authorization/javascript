# @atlasauth/express

The Express adapter for Atlas.

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
import { atlasMiddleware, atlasRateLimit, atlasGrantUsage, requireAccessToken } from '@atlasauth/express';

app.use(atlasMiddleware({ jwksUrl, issuer }));
app.use(atlasRateLimit(limiter));            // per user / org / machine / address
app.post('/orders', requireAccessToken(opts), atlasGrantUsage({ gate, counter: 'orders' }), handler);
```
The claims come from `req.atlasToken` (machine or agent token), then `req.atlas`. Pass `{ claims: (req) => ... }` to read them elsewhere.
