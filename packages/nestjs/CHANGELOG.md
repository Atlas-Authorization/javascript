# @atlasauth/nestjs changelog

## 0.4.0

- **behaviour:** Cookie isolation: with `session.cookieIsolation` on, the server helpers read and write the instance's suffixed cookie names, derived from the publishable key with no configuration.
- Requires @atlasauth/backend 0.67.0.

## 0.3.0

- `AtlasStepUpGuard` and `AtlasLimitsModule.register({ stepUp })`; `AtlasFeatureGuard` for plan features.

## 0.2.0

- New `atlasRateLimit` and `atlasGrantUsage` helpers: enforce Atlas rate-limit policies and metered grant usage (consume/refund with idempotency) in your routes. Requires `@atlasauth/backend` 0.51.0 or later.

## 0.1.1 — 2026-11-14

- Takes `@atlasauth/backend` as a peer dependency (`>=0.49.0 <1.0.0`) instead of pinning one exact version, so an app has a single copy of it.

## 0.1.0

First published release.

### Added
- `AtlasModule` (with sync and async registration) providing an injectable `AtlasBackend` via `InjectAtlas()`.
- `AtlasGuard` / `AtlasAuthGuard` that verify the session token locally against the instance's cached JWKS.
- `@Public()` and `@RequirePermission()` route decorators.
- `@AtlasAuth()` and `@CurrentUser()` parameter decorators.
- Works with both the Express and Fastify Nest adapters (`getRequest()`, `extractToken()`).
- Re-exports `AtlasBackend`, `ForbiddenError`, `evaluate`, `hasFromClaims` and related types from `@atlasauth/backend`.
