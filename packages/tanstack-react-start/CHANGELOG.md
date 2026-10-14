# @atlasauth/tanstack-react-start changelog

## 0.1.0

First published release.

### Added
- `getAuth()` resolves the verified session for a TanStack Start request, verified locally against the instance's cached JWKS.
- `fetchAtlasAuth()` for reading auth inside server functions.
- `createAtlasHandler()` request middleware that injects `atlasAuth` into the request context.
- `configFromEnv()`, `resolveAuth()` and `signedOut()` helpers.
- Re-exports `@atlasauth/react` components and hooks, plus `AtlasBackend`, `ForbiddenError`, `evaluate` and `hasFromClaims` from `@atlasauth/backend`.
