# @atlasauth/hono changelog

## Unreleased

## 0.6.0 — 2026-10-25

### Added

- `migrationBridge` option and `migrationBridge()`: the Better Auth session bridge for any vendor (`source: 'auth0' | 'clerk' | 'cognito' | …`), reading the vendor's session cookie or token per its preset (or `cookieNames` / `extractToken`).

## 0.5.0 — 2026-10-24

### Added

- `betterAuthBridge` option: during a migration from Better Auth, turns each user's Better Auth session into an Atlas session on their next request (once), clears the old cookie, and sends users who still owe a second factor to sign-in. With `secretKey`, exchanges run server to server at a per-app limit suited to a bulk cutover.

## 0.4.0 — 2026-10-24

### Added

- `requireAccessToken` sets the `DPoP-Nonce` response header (on success and refusal) when the verifier is given `dpopNonces`.

## 0.3.0 — 2026-10-23

### Added

- `requireAccessToken(options)`: middleware gating a route on an Atlas-issued OAuth access token for your API (audience, scopes, DPoP); `c.get('atlasToken')` holds it, failures get the `WWW-Authenticate` challenge. Re-exports `createAccessTokenVerifier`, `protectedResourceMetadata`, `protectedResourceMetadataPath`.

## 0.2.0

### Added
- `getAuth(c)` now also returns `isSignedIn` (`true` exactly when `userId` is set), matching `@atlasauth/express` and `@atlasauth/fastify`.

## 0.1.0

First published release.

### Added
- `atlasMiddleware({ jwksUrl, issuer, authorizedParties?, publishableKey? })` for Hono, including edge and Workers runtimes — verifies the session token from the `__session` cookie or `Authorization: Bearer` header locally against a cached JWKS and stores the result on the context under `ATLAS_CONTEXT_KEY` (`'atlas'`). Verification failures resolve to a signed-out state rather than throwing.
- `getAuth(c)` returning `AtlasAuth`: `userId`, `sessionId`, `orgId`, `orgRole`, `claims`, plus `has()` and `protect()` using the shared `@atlasauth/authz` conditions.
- `resolveAuth()`, `SIGNED_OUT`, `SESSION_COOKIE`, and re-exports of `AtlasBackend`, `ForbiddenError`, `evaluate`, `hasFromClaims` and the related types from `@atlasauth/backend`.
