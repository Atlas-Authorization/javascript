# @atlasauth/hono changelog

## 0.11.0

- The auth state from `getAuth(c)` gains `status` (`signed_in`, `signed_out`, `session_expired`, `token_invalid`) and `reason`. `session_expired` means the short-lived session token lapsed but the refresh cookie or sign-in hint is present: renew, do not sign out. Needs `@atlasauth/backend` 0.62.0.

## 0.10.0

- `atlasStepUp` route guard and a plan feature gate wrapper.

## 0.9.0

- New `atlasRateLimit` and `atlasGrantUsage` helpers: enforce Atlas rate-limit policies and metered grant usage (consume/refund with idempotency) in your routes. Requires `@atlasauth/backend` 0.51.0 or later.

## 0.8.0 — 2026-11-12

- `revocation` and `csrf` options, `getCsrfToken`, `getInitialState`; `requireFeature` / `requirePlan` pass-through.

## 0.7.0 — 2026-11-06

### Added
- `previousIssuers` option, passed through to the verifier, so a sign-in host change does not sign users out: tokens from a listed former issuer are accepted alongside `issuer`. Absent means only `issuer` is accepted.

## 0.8.1 — 2026-11-14

- Takes `@atlasauth/backend` as a peer dependency (`>=0.49.0 <1.0.0`) instead of pinning one exact version, so an app has a single copy of it.

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
