# @atlasauth/chrome-extension changelog

## 0.4.0 — 2026-10-28

- Reports device posture to Atlas (self-reported; never marks a device trusted)

## 0.3.1
- **Fixed:** depends on `@atlasauth/react` `^0.9.0` instead of one exact version. With an exact pin, an app that also
  installed a newer `@atlasauth/react` got two copies, and hooks from one couldn't see the other's
  `<AtlasProvider>` ("Atlas hooks must be used inside <AtlasProvider>").

## 0.3.0

### Changed
- **`AtlasClient.signOut(options?: SignOutOptions)` now resolves `Promise<SignOutResult>`** (`{ revoked: boolean;
  activeSessionId?: string }`) instead of `Promise<void>`; existing `await client.signOut()` call sites keep working. The
  revoke is no longer fire-and-forget: it is sent with the token being dropped, retried once, then re-tried in the
  background (still authenticated as that token after `chrome.storage` was cleared). `{ strict: true }` rejects with
  `SignOutError` (`code: 'SIGN_OUT_REVOKE_FAILED'`, `sessionId`, `status`) after the local sign-out. A token without a
  `sid` claim no longer skips the revoke (`GET /v1/client` finds the session). `activeSessionId` (a server-promoted
  session) is reported but not adopted: the bearer revoke returns no credential for it.
- **A signed-out session is never re-adopted by any extension surface.** Its id is recorded (a tombstone, via
  `SignOutGuard` from `@atlasauth/js`) in `chrome.storage.local` before the revoke, and re-read before every decision, so
  a popup, options page, content script or service worker that booted before the sign-out neither sends a stored token of
  that session (it is removed and its revoke re-tried in the background) nor writes back a token its in-flight refresh
  rotated for it (`syncSessionToken`, `persistingBearerFetch`). The tombstone is dropped once a revoke is confirmed.
- `AtlasClient.store` is now the guarded store (refuses a signed-out session's token on read and write).
- `@atlasauth/chrome-extension/react` `<AtlasProvider>`: `signOut` is `@atlasauth/react`'s (`Promise<SignOutResult>`,
  strict `SignOutError`); revoking the stored token's session now also tombstones it in `chrome.storage.local` and drops
  the token for every surface, and a stored token of a signed-out session is never sent nor written back.

### Added
- `ExtensionSignOutGuard` (with `ExtensionSignOutGuardOptions`): the shared-`chrome.storage` sign-out guard —
  `guard`, `bearerRequest(token)`, `isSignedOut(sid)`, `guardStore(store)`, `remember(sid, token)`, `droppedToken(sid)`.
- `CreateAtlasClientOptions.tombstoneStore?: TombstoneStore` and `CreateAtlasClientOptions.signOutRetryDelaysMs?: number[]`;
  `ChromeAtlasProviderProps.tombstoneStore?: TombstoneStore`.
- `createChromeTombstoneStore(area?)` and `StorageCache.tombstoneStore()`.
- `persistingBearerFetch(fetchImpl, store, signOutGuard?)` — optional third argument.
- Re-exports `SignOutError`, `SignOutOptions`, `SignOutResult` and `TombstoneStore` from `@atlasauth/js`.

## 0.2.2
- Picks up `@atlasauth/react` 0.6.0 / `@atlasauth/js` 0.7.0: popup sign-in completes when the opener page
  sends `Cross-Origin-Opener-Policy: same-origin`; a tab opened after a failed sign-out stays signed out
  (sign-out tombstones shared across tabs); the default focus ring keeps 3:1 contrast. No API changes.

## 0.2.1
- **`frontendApi` is validated at start-up.** A missing, empty or malformed value now throws an
  `AtlasConfigError` (from `@atlasauth/js`; `code: 'FRONTEND_API_REQUIRED'` or `'FRONTEND_API_INVALID'`)
  instead of silently sending requests to relative URLs on the app's own origin. Accepted: an absolute
  `https:` URL (`http:` only for localhost / local development hosts). An extension origin cannot host the Frontend API, so `"same-origin"` is refused.

## 0.2.0

### Added
- Native-session support: `createNativeSessionManager()` returns a `NativeSessionManager` backed by `chrome.storage`, rehydrating a stored session and persisting each rotated refresh token. Options are typed as `NativeSessionOptions`.
- `clearNativeSession()` to remove the persisted native session on sign-out, and `DEFAULT_NATIVE_SESSION_KEY`.
- Re-exports `NativeSessionManager`, `NativeSession`, `exchangeForSession()` and `refreshNativeSession()` from `@atlasauth/js`. All are also available from `@atlasauth/chrome-extension/background`.

## 0.1.0

First published release.

### Added
- Manifest V3 support with a React-free root entry, safe to import from a background service worker or content script.
- `StorageCache` token store over `chrome.storage.local` (`TokenStore`, `ChromeStorageArea`, `DEFAULT_TOKEN_KEY`), plus `createMemoryStorageArea()` for tests.
- `createAtlasClient()` returning an `AtlasClient` whose requests carry the session token as a bearer, and `syncSessionToken()` for background token refresh; helpers `bearerFetch()`, `persistingBearerFetch()` and `decodeTokenClaims()`.
- `@atlasauth/chrome-extension/background` entry exposing the same helpers for service workers.
- `@atlasauth/chrome-extension/react` entry with an `AtlasProvider` wired to extension storage and a re-export of `@atlasauth/react`. React is an optional peer.
