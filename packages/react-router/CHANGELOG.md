# @atlasauth/react-router changelog

## 0.1.1
- Picks up `@atlasauth/react` 0.6.0 / `@atlasauth/js` 0.7.0: popup sign-in completes when the opener page
  sends `Cross-Origin-Opener-Policy: same-origin`; a tab opened after a failed sign-out stays signed out
  (sign-out tombstones shared across tabs); the default focus ring keeps 3:1 contrast. No API changes.

## 0.1.0

First published release.

### Added
- `getAuth()` for React Router v7 / Remix loaders and actions, verifying the session locally against the instance's cached JWKS.
- `rootAuthLoader()` wraps the root loader and attaches auth state for hydration.
- `configFromEnv()` reads `ATLAS_JWKS_URL`, `ATLAS_ISSUER`, `ATLAS_AUTHORIZED_PARTIES` and `ATLAS_PUBLISHABLE_KEY`.
- `resolveAuth()` and `signedOut()` helpers.
- Re-exports `@atlasauth/react` components and hooks, plus `AtlasBackend`, `ForbiddenError`, `evaluate` and `hasFromClaims` from `@atlasauth/backend`.
