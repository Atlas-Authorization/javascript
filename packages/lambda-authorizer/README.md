# @atlasauth/lambda-authorizer

An API Gateway Lambda authorizer for Atlas. It verifies the token a request carries against your instance's cached key set (no call to Atlas per request) and answers with an IAM policy. Works with REST APIs (TOKEN and REQUEST authorizers) and HTTP APIs (payload format 2.0).

```ts
import { createLambdaAuthorizer } from '@atlasauth/lambda-authorizer';

// Create it once, outside the handler: the key set and result cache live for the warm container.
export const handler = createLambdaAuthorizer({
  session: {
    issuer: process.env.ATLAS_ISSUER!,
    authorizedParties: ['https://app.example.com'],
  },
  // Also accept OAuth access tokens for your API:
  accessToken: { issuer: process.env.ATLAS_ISSUER!, audience: 'https://api.example.com', requiredScopes: ['orders:read'] },
});
```

Your backend receives `userId`, `sessionId`, `orgId`, `orgRole`, `clientId`, `scopes` and `tokenKind` in `requestContext.authorizer` (REST) or `requestContext.authorizer.lambda` (HTTP API).

## Behaviour

- Token: `Authorization: Bearer <jwt>` first, then the `__session` cookie (REQUEST authorizers). Session tokens are tried first, then access tokens if configured; the two are never confused.
- Verification: signature against the cached key set, issuer, expiry with 5 seconds of clock skew, and `authorizedParties` (set it; it stops a token issued to one of your apps being replayed against another).
- Fail closed: anything that is not a verified token is refused. REST throws `Unauthorized` (401). HTTP APIs return a Deny policy, or `{ isAuthorized: false }` with `httpApiResponse: 'simple'` (403). A verified token that lacks a required scope or fails `condition` gets a Deny policy (403).
- `policyScope`: `method` (default) allows the exact method ARN; use `stage` when API Gateway caches the authorizer result across several routes.
- `cacheTtlSeconds` (default 30) reuses a verified result inside the warm container, never past the token's expiry. Refusals are not cached. Set `0` to verify every request.
- DPoP-bound tokens are not supported here (an authorizer does not see the request proof); they are refused.
