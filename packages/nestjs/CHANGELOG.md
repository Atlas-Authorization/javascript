# @atlasauth/nestjs changelog

## 0.1.0

First published release.

### Added
- `AtlasModule` (with sync and async registration) providing an injectable `AtlasBackend` via `InjectAtlas()`.
- `AtlasGuard` / `AtlasAuthGuard` that verify the session token locally against the instance's cached JWKS.
- `@Public()` and `@RequirePermission()` route decorators.
- `@AtlasAuth()` and `@CurrentUser()` parameter decorators.
- Works with both the Express and Fastify Nest adapters (`getRequest()`, `extractToken()`).
- Re-exports `AtlasBackend`, `ForbiddenError`, `evaluate`, `hasFromClaims` and related types from `@atlasauth/backend`.
