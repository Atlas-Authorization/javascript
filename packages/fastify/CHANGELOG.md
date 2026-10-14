# @atlasauth/fastify changelog

## 0.2.0

### Changed
- Typed against the real Fastify types: `fastify` (>=4) is now a peer dependency, and `request.atlas` is declared on Fastify's own `FastifyRequest`, so routes need no casts. `atlasPlugin()` returns a `FastifyPluginCallback`; `getAuth()` takes a `FastifyRequest`.
- `requireAuth(request, reply)` is now an async `preHandler` returning `Promise<void>` (previously it returned a `boolean`), so it can be used directly as `{ preHandler: requireAuth }`.

### Removed
- The structural `AtlasFastifyRequest`, `AtlasFastifyReply`, `AtlasFastifyInstance`, `AtlasFastifyPlugin`, `HookDone` and `PluginDone` types (replaced by the Fastify types above).

## 0.1.0

First published release.

### Added
- `atlasPlugin({ jwksUrl, issuer, authorizedParties?, publishableKey?, hookName? })` — verifies the session token from the `__session` cookie or `Authorization: Bearer` header locally against a cached JWKS (no per-request network call) and attaches the result as `request.atlas`. Runs on `preHandler` by default, or `onRequest` (`ALLOWED_HOOKS`). Verification failures resolve to a signed-out state rather than throwing.
- `getAuth(request)` returning `AtlasAuth`: `userId`, `sessionId`, `orgId`, `orgRole`, `claims`, `actor`, `isSignedIn`, plus `has()` and `protect()` using the shared `@atlasauth/authz` conditions.
- `requireAuth()` to reject signed-out requests with `401`.
- `resolveAuth()` and `signedOut()` helpers, and re-exports of `AtlasBackend`, `ForbiddenError`, `evaluate`, `hasFromClaims` and the related types from `@atlasauth/backend`.
