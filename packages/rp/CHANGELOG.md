# @atlasauth/rp changelog

## 0.2.0 — 2026-11-03

### Added

- Sign in with Atlas apps (no instance secret key): `touchIfDue` keeps the app's own sign-in alive with the client credentials (`POST {issuer}/oauth2/session/touch`), and `endAppSession(sid)` ends it (`POST {issuer}/oauth2/session/end`, which sends the app a back-channel logout). Both authenticate like the token endpoint and throw a `TypeError` for a public client. With a `secretKey`, nothing changes.
- `sidStore` (`SidStore`, `memorySidStore()`, `sqlSidStore({ query })`), `rp.bindSession(sid, appSessionId, expiresAt)`, `onBackchannelLogout(appSessionIds, claims)` and `rp.backchannelLogout(request)`; `routes.backchannelLogout` lets `handle()` answer it.
- `@atlasauth/rp/testing`: `mockIssuer({ issuer, clientId, alg })`, an offline issuer (discovery, JWKS, token endpoint, session touch/end, ID and logout tokens) for testing your app.

## 0.1.1 — 2026-11-02

Republish of 0.1.0 (that version number could not be published). No code changes.

## 0.1.0 — 2026-11-02

First published release: the `@atlasauth/backend/rp` entry point as its own package, with `jose` as its only dependency.

### Added

- `createRelyingParty()`: `start(request)` / `callback(request)` as `(Request) => Response` handlers (state, nonce and PKCE S256 in one sealed cookie; ID token verified with the algorithm pinned), `requireRecentAuth()`, `touchIfDue()`, `revokeSession()` and `signOut()`.
- `rp.handle(request)`: sign-in, callback and sign-out in one handler, with `onSignedIn`, `onSignInError` and `onSignOut` hooks and configurable `routes`.
- `forwardParams`: extra query parameters (referral, campaign) forwarded from your sign-in URL to `/oauth2/authorize`.
- Back-channel logout (`LogoutTokenVerifier`, `fetchBackchannelLogout`, `expressBackchannelLogout`, `fastifyBackchannelLogoutPlugin`) and webhook verification (`verifyAtlasWebhook`, `verifyAtlasWebhookRequest`) on Web Crypto.
- ESM and CommonJS builds; runs on Node 18+, Deno, Bun and Workers.
