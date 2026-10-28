# @atlasauth/express changelog

## Unreleased

## 0.6.0 — 2026-10-25

### Added

- `migrationBridge` option and `migrationBridge()` middleware: the Better Auth session bridge for any vendor (`source: 'auth0' | 'clerk' | 'cognito' | …`), reading the vendor's session cookie or token per its preset (or `cookieNames` / `extractToken`).

## 0.5.0 — 2026-10-24

### Added

- `betterAuthBridge` option: during a migration from Better Auth, turns each user's Better Auth session into an Atlas session on their next request (once), clears the old cookie, and sends users who still owe a second factor to sign-in. With `secretKey`, exchanges run server to server at a per-app limit suited to a bulk cutover.

## 0.4.0 — 2026-10-24

### Added

- `requireAccessToken` sets the `DPoP-Nonce` response header (on success and refusal) when the verifier is given `dpopNonces`.

## 0.3.0 — 2026-10-23

### Added

- `requireAccessToken(options)`: middleware gating a route on an Atlas-issued OAuth access token for your API (audience, scopes, DPoP); sets `req.atlasToken`, answers failures with the `WWW-Authenticate` challenge. Re-exports `createAccessTokenVerifier`, `protectedResourceMetadata`, `protectedResourceMetadataPath`.

## 0.2.0

### Changed
- Typed against the real Express types: `express` (>=4) is now a peer dependency, and `req.atlas` is declared on Express's own `Request`, so handlers need no casts. `getAuth()` takes an Express `Request`, and `atlasMiddleware()` / `requireAuth()` return an Express `RequestHandler`.
- `Request`, `Response`, `NextFunction` and `RequestHandler` are now re-exported from `express`.

### Removed
- The structural `AtlasExpressRequest` and `AtlasExpressResponse` types, and the package's own `NextFunction` / `RequestHandler` definitions (replaced by the Express types above).

## 0.1.0

First published release.

### Added
- `atlasMiddleware({ jwksUrl, issuer, authorizedParties?, publishableKey? })` — verifies the session token from the `__session` cookie or `Authorization: Bearer` header locally against a cached JWKS (no per-request network call) and attaches the result as `req.atlas`. Verification failures resolve to a signed-out state rather than throwing.
- `getAuth(req)` returning `AtlasAuth`: `userId`, `sessionId`, `orgId`, `orgRole`, `claims`, `actor`, `isSignedIn`, plus `has()` and `protect()` using the shared `@atlasauth/authz` conditions.
- `requireAuth(options?)` middleware that responds `401` with `UNAUTHENTICATED` for signed-out requests; works after `atlasMiddleware()` or standalone.
- `resolveAuth()` and `signedOut()` helpers, and re-exports of `AtlasBackend`, `ForbiddenError`, `evaluate`, `hasFromClaims` and the related types from `@atlasauth/backend`.
