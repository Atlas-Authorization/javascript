# @atlasauth/astro changelog

## 0.1.0

First published release.

### Added
- `atlasMiddleware()` Astro server middleware that verifies the session token locally against the instance's cached JWKS (no network call per request).
- `getAuth(context)` returns an `AtlasAuth` object with `userId`, `sessionId`, `orgId`, `orgRole`, `claims`, `isSignedIn`, `actor`, and `has()` / `protect()` authorization helpers.
- `resolveAuth()` and `signedOut()` helpers for custom resolution flows.
- `atlasAstro()` integration factory for `astro.config`.
- Re-exports `AtlasBackend`, `ForbiddenError`, `evaluate`, `hasFromClaims` and the related types from `@atlasauth/backend`.
