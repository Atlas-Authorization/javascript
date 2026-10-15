# @atlasauth/chrome-extension changelog

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
