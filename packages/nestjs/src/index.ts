/**
 * `@atlasauth/nestjs` — the framework-native NestJS integration for Atlas, the
 * server-side twin of `@atlasauth/express` and `@atlasauth/fastify`.
 *
 * It wraps `@atlasauth/backend`'s LOCAL session verification (§7.3 — the session
 * JWT is verified against the instance's in-process-cached JWKS, with no Atlas
 * call on the request path) in Nest's own primitives: a dynamic module that
 * provides a configured verifier, a `CanActivate` guard that authenticates the
 * request and attaches the result to `request.atlas`, a `@Public()` skip-marker,
 * `@CurrentUser()` / `@AtlasAuth()` param decorators, and an `AtlasAuthGuard`
 * that enforces a `@RequirePermission(...)` condition. It reads the request
 * generically, so it works behind both the Express and the Fastify adapters.
 */

export { ATLAS_BACKEND, IS_PUBLIC_KEY, REQUIRE_PERMISSION_KEY } from './constants';
export {
  AtlasModule,
  InjectAtlas,
  type AtlasModuleOptions,
  type AtlasModuleAsyncOptions,
} from './module';
export { AtlasGuard, AtlasAuthGuard, type AtlasVerifier } from './guards';
export {
  Public,
  RequirePermission,
  AtlasAuth,
  CurrentUser,
  atlasAuthFactory,
  currentUserFactory,
} from './decorators';
export { extractToken, getRequest, type AtlasRequest } from './request';

// Re-export the shared authorization primitives and the backend verifier, so an
// integrator imports everything they need for server-side auth from
// `@atlasauth/nestjs` alone — the same `has`/`protect` contract the React
// `<Protect>`, the Next.js `auth()`, and the Express/Fastify adapters evaluate.
export {
  AtlasBackend,
  ForbiddenError,
  evaluate,
  hasFromClaims,
  type ProtectCondition,
  type ProtectOutcome,
  type ProtectReason,
  type SessionClaims,
  type AuthorizedSession,
  type VerifyResult,
  type AtlasBackendOptions,
} from '@atlasauth/backend';
