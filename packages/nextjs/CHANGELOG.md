# @atlasauth/nextjs changelog

## 0.3.0
### Added
- **`getAtlasInitialState(options?)`** in `@atlasauth/nextjs/server` → `Promise<AtlasInitialState>`: the instance's
  public sign-in data for `<AtlasProvider initialState>`, so the sign-in panel is styled and has its social buttons in
  the server HTML. Cached in Next's data cache for `revalidate` seconds (default 60; `false` disables caching). Reads
  `ATLAS_PUBLISHABLE_KEY` / `NEXT_PUBLIC_ATLAS_PUBLISHABLE_KEY` and `ATLAS_FRONTEND_API` /
  `NEXT_PUBLIC_ATLAS_FRONTEND_API`, or `{ publishableKey, frontendApi }`. Never throws; gives up after `timeoutMs`
  (default 1500).
- New type `AtlasInitialState`.

## 0.2.0

### Added
- **Next.js 16 `proxy.ts` support.** `atlasProxy(options)` returns `(request) => Promise<Response | null>`. It resolves to a `Response` when Atlas must act (the sign-in redirect, the cross-property handshake, or a JSON 401 for `/api/*`) and to `null` to let the rest of the proxy run. It takes the same options and makes the same decisions as `atlasMiddleware`. It uses only Web-standard APIs, so it runs on both the Node.js runtime (the Next 16 default) and the Edge runtime.
- `withAtlasHeaders(request, response, auth?)` forwards the verified session to the app as request headers: `x-atlas-auth-status`, `x-atlas-user-id`, `x-atlas-session-id`, `x-atlas-org-id` and `x-atlas-org-role`. It works on a `NextResponse.next()` or a rewrite produced by any later step, such as next-intl, and merges with request-header overrides already set. It always drops `x-atlas-*` headers sent by the client.
- `readAtlasHeaders(headers)` returns the forwarded session as a `ForwardedAuth` (`{ signedIn, userId, sessionId, orgId, orgRole }`). `proxyAuth(request)` returns the `AuthState` the proxy resolved for a request. `ATLAS_AUTH_HEADERS` names the header constants.
- New types: `AtlasProxy`, `ProxyRequest`, `HeaderCarryingResponse`, `ForwardedAuth`.
- **Locale-prefixed routes.** Route patterns accept whole-segment `:name` parameters (`/:locale/dashboard(.*)`). The new `MiddlewareConfig` fields `locales` and `defaultLocale` restrict a `:locale` segment to the listed locales and fill in a `signInUrl` such as `/:locale/sign-in` from the request. New exports: `localizeSignInUrl` and the `PatternOptions` type. `matchesPattern`, `matchesAny` and `createRouteMatcher` take an optional `PatternOptions` argument.
- `createAtlasDecider(options)` exposes the runtime-neutral decision engine behind both `atlasMiddleware` and `atlasProxy`. It resolves to an `AtlasDecision` (`continue`, `redirect` with cookies, or `unauthorized`). New types: `AtlasDecision`, `AtlasCookie`. New constant: `UNAUTHENTICATED_BODY`.
- A package README.

### Changed
- `atlasMiddleware` / `authMiddleware` now render the shared decision engine. Their behaviour and signature are unchanged.
- Patterns without a `:name` segment keep their exact previous meaning.

## 0.1.4

### Added
- New `@atlasauth/nextjs/server` entry with pre-bound, zero-argument `auth()` and `currentUser()`. They read the ambient request through `next/headers` and their config from `ATLAS_JWKS_URL` / `ATLAS_ISSUER` (or the `NEXT_PUBLIC_` forms). The base entry still doesn't need `next` installed.
- `atlasClient()`: a configured `@atlasauth/backend` client built from `ATLAS_SECRET_KEY` (and `ATLAS_API_URL`, if set).
- `configFromEnv()`, `backendConfigFromEnv()`, `buildEdgeRequest()`, and the `ServerAuth`, `CookieStoreLike` and `HeaderStoreLike` types.

## 0.1.3

### Added
- `createRouteMatcher(patterns)`. It returns a predicate over a `NextRequest`, a `{ nextUrl }` / `{ url }` object, or a path string, using the same `(.*)` pattern engine as the middleware.

## 0.1.2

### Added
- The middleware honours the durable signed-in hint (`__atlas_uat`, or the same-origin `__atlas_rt` cookie). A signed-in user whose short-lived `__session` has lapsed between refreshes is let through instead of being redirected to sign-in. Exported as `hasSignedInHint(request)`.
- `authMiddleware`, an alias of `atlasMiddleware`.
- `createCurrentUserHelper(options)` returns `currentUser(request)`. It gives a `CurrentUser` (`id`, `orgId`, `orgRole`, `email`, `name`, `firstName`, `lastName`), read from the verified session claims without a network call.

## 0.1.1

First release published under the `@atlasauth` scope.

### Added
- `atlasMiddleware(options)`: verifies the session JWT locally (JWKS cached in-process), protects routes by default (`publicRoutes` / `protectedRoutes`, where protected wins), returns a 401 JSON response for `/api/*`, skips static assets, and validates `redirect_url` (`safeRedirect`).
- `createAuthHelper(options)` returns `auth(request)`, with `has(condition)` and `protect(condition)` over the full permission/role condition set shared with the other Atlas SDKs.
- Cross-property SSO: `handshake: true` (with `publishableKey`, and optionally `fapiOrigin`) bounces a signed-out visitor through the Atlas handshake once, PKCE-bound and loop-guarded. A cross-domain return redeems the nonce and sets first-party `__session` / `__atlas_rt` cookies.
- Exports: `resolveAuth`, `SIGNED_OUT`, `decideRoute`, `matchesPattern`, `matchesAny`, `isStaticAsset`, `DEFAULT_SIGN_IN_URL`, and the `AuthState`, `EdgeRequest`, `EdgeResponse`, `EdgeRedirect`, `EdgeCookies`, `MiddlewareConfig` and `RouteDecision` types.
