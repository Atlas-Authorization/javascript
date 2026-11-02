# @atlasauth/rp changelog

## 0.1.0 — 2026-11-02

First published release: the `@atlasauth/backend/rp` entry point as its own package, with `jose` as its only dependency.

### Added

- `createRelyingParty()`: `start(request)` / `callback(request)` as `(Request) => Response` handlers (state, nonce and PKCE S256 in one sealed cookie; ID token verified with the algorithm pinned), `requireRecentAuth()`, `touchIfDue()`, `revokeSession()` and `signOut()`.
- `rp.handle(request)`: sign-in, callback and sign-out in one handler, with `onSignedIn`, `onSignInError` and `onSignOut` hooks and configurable `routes`.
- `forwardParams`: extra query parameters (referral, campaign) forwarded from your sign-in URL to `/oauth2/authorize`.
- Back-channel logout (`LogoutTokenVerifier`, `fetchBackchannelLogout`, `expressBackchannelLogout`, `fastifyBackchannelLogoutPlugin`) and webhook verification (`verifyAtlasWebhook`, `verifyAtlasWebhookRequest`) on Web Crypto.
- ESM and CommonJS builds; runs on Node 18+, Deno, Bun and Workers.
