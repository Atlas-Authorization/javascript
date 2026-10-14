# @atlasauth/hono changelog

## 0.2.0

### Added
- `getAuth(c)` now also returns `isSignedIn` (`true` exactly when `userId` is set), matching `@atlasauth/express` and `@atlasauth/fastify`.

## 0.1.0

First published release.

### Added
- `atlasMiddleware({ jwksUrl, issuer, authorizedParties?, publishableKey? })` for Hono, including edge and Workers runtimes — verifies the session token from the `__session` cookie or `Authorization: Bearer` header locally against a cached JWKS and stores the result on the context under `ATLAS_CONTEXT_KEY` (`'atlas'`). Verification failures resolve to a signed-out state rather than throwing.
- `getAuth(c)` returning `AtlasAuth`: `userId`, `sessionId`, `orgId`, `orgRole`, `claims`, plus `has()` and `protect()` using the shared `@atlasauth/authz` conditions.
- `resolveAuth()`, `SIGNED_OUT`, `SESSION_COOKIE`, and re-exports of `AtlasBackend`, `ForbiddenError`, `evaluate`, `hasFromClaims` and the related types from `@atlasauth/backend`.
