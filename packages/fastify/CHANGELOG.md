# @atlasauth/fastify changelog

## Unreleased

## 0.6.0 — 2026-10-25

### Added

- `migrationBridge` option and `migrationBridgeHook()`: the Better Auth session bridge for any vendor (`source: 'auth0' | 'clerk' | 'cognito' | …`), reading the vendor's session cookie or token per its preset (or `cookieNames` / `extractToken`).

## 0.5.0 — 2026-10-24

### Added

- `betterAuthBridge` option: during a migration from Better Auth, turns each user's Better Auth session into an Atlas session on their next request (once), clears the old cookie, and sends users who still owe a second factor to sign-in. With `secretKey`, exchanges run server to server at a per-app limit suited to a bulk cutover.

## 0.4.0 — 2026-10-24

### Added

- `requireAccessToken` sets the `DPoP-Nonce` response header (on success and refusal) when the verifier is given `dpopNonces`.

## 0.3.0 — 2026-10-23

### Added

- `requireAccessToken(options)`: a `preHandler` gating a route on an Atlas-issued OAuth access token for your API (audience, scopes, DPoP); sets `request.atlasToken`, answers failures with the `WWW-Authenticate` challenge. Re-exports `createAccessTokenVerifier`, `protectedResourceMetadata`, `protectedResourceMetadataPath`.

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
