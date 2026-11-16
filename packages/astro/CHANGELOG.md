# @atlasauth/astro changelog

## 0.3.1

- `ATLAS_PREVIOUS_ISSUERS` accepts spaces as well as commas.

## 0.3.0

- Plan feature gate wrapper.

## 0.2.0

- New `atlasRateLimit` and `atlasGrantUsage` helpers: enforce Atlas rate-limit policies and metered grant usage (consume/refund with idempotency) in your routes. Requires `@atlasauth/backend` 0.51.0 or later.

## 0.1.2 — 2026-11-14

- Takes `@atlasauth/backend` as a peer dependency (`>=0.49.0 <1.0.0`) instead of pinning one exact version, so an app has a single copy of it.

## 0.1.1 — 2026-11-06

### Added
- `previousIssuers` option (or comma-separated `ATLAS_PREVIOUS_ISSUERS`) so the middleware keeps accepting tokens from a former issuer during a sign-in host change. Absent means only `issuer` is accepted.

## 0.1.0

First published release.

### Added
- `atlasMiddleware()` Astro server middleware that verifies the session token locally against the instance's cached JWKS (no network call per request).
- `getAuth(context)` returns an `AtlasAuth` object with `userId`, `sessionId`, `orgId`, `orgRole`, `claims`, `isSignedIn`, `actor`, and `has()` / `protect()` authorization helpers.
- `resolveAuth()` and `signedOut()` helpers for custom resolution flows.
- `atlasAstro()` integration factory for `astro.config`.
- Re-exports `AtlasBackend`, `ForbiddenError`, `evaluate`, `hasFromClaims` and the related types from `@atlasauth/backend`.
