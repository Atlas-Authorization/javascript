# @atlasauth/tanstack-react-start changelog

## 0.1.1
- Picks up `@atlasauth/react` 0.6.0 / `@atlasauth/js` 0.7.0: popup sign-in completes when the opener page
  sends `Cross-Origin-Opener-Policy: same-origin`; a tab opened after a failed sign-out stays signed out
  (sign-out tombstones shared across tabs); the default focus ring keeps 3:1 contrast. No API changes.

## 0.1.0

First published release.

### Added
- `getAuth()` resolves the verified session for a TanStack Start request, verified locally against the instance's cached JWKS.
- `fetchAtlasAuth()` for reading auth inside server functions.
- `createAtlasHandler()` request middleware that injects `atlasAuth` into the request context.
- `configFromEnv()`, `resolveAuth()` and `signedOut()` helpers.
- Re-exports `@atlasauth/react` components and hooks, plus `AtlasBackend`, `ForbiddenError`, `evaluate` and `hasFromClaims` from `@atlasauth/backend`.
