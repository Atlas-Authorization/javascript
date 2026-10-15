# @atlasauth/capacitor changelog

## 0.2.0

### Changed
- **`signOut(options?: SignOutOptions)` now resolves `Promise<SignOutResult>`** (`{ revoked: boolean; activeSessionId?: string }`)
  instead of `Promise<void>`, and revokes the session on the Frontend API (it used to only clear local state). Existing
  `await atlas.signOut()` call sites keep working. The revoke is authenticated as the session being dropped, retried once,
  then re-tried in the background (a 401 from an expired JWT rotates it once with the refresh token). `{ strict: true }`
  rejects with `SignOutError` (`code: 'SIGN_OUT_REVOKE_FAILED'`, `sessionId`, `status`) after the local sign-out.
  `activeSessionId` (a server-promoted session) is reported but not adopted: the bearer revoke never returns a credential
  for it.
- **A signed-out session is never re-adopted.** Its id is remembered (a tombstone, via `SignOutGuard` from
  `@atlasauth/js`) in the platform store before the revoke; the next app start refuses a stored session that is tombstoned
  (and clears it), and a refresh still in flight at sign-out can no longer write the session back or resurrect it in
  memory. A refused session's revoke is re-tried in the background and its tombstone dropped once the server confirms.
- `getToken()` / `authHeaders()` return no bearer for a session signed out while a refresh was in flight; `onChange()`
  listeners are not called for a signed-out session.

### Added
- `CreateAtlasCapacitorConfig.tombstoneStore?: TombstoneStore` (default: `@capacitor/preferences` when present, else the
  WebView's `localStorage`) and `CreateAtlasCapacitorConfig.signOutRetryDelaysMs?: number[]`.
- `createPreferencesTombstoneStore(preferences)` and `tombstoneStoreFromTokenStore(store)` adapters.
- `NativeSessionConfig.refuse?: (session: NativeSession) => boolean` on `createNativeSessionManager()`.
- Re-exports `SignOutError`, `SignOutOptions`, `SignOutResult` and `TombstoneStore` from `@atlasauth/js`.

## 0.1.1
- **`frontendApi` is validated at `createAtlasCapacitor()`.** A missing, empty or malformed value now throws an
  `AtlasConfigError` (from `@atlasauth/js`; `code: 'FRONTEND_API_REQUIRED'` or `'FRONTEND_API_INVALID'`)
  instead of silently sending requests to relative URLs on the app's own origin. Accepted: an absolute
  `https:` URL (`http:` only for localhost / local development hosts). Native apps have no origin of their own, so `"same-origin"` is refused. A trailing slash is now normalised away.

## 0.1.0

First published release.

### Added
- `createAtlasCapacitor()` sets up native sign-in for Capacitor / Ionic apps on iOS, Android and web.
- System-browser sign-in with deep-link callback and PKCE: `signInWithBrowser()`, `completeRedirectSignIn()`, `buildAuthorizeUrl()`, `parseAuthCallback()`, `redeemAuthorizationCode()`, `exchangeAuthCode()`.
- Cookie-free native session that auto-refreshes and persists: `createNativeSessionManager()`, `clearNativeSession()`, plus re-exported `NativeSessionManager`, `exchangeForSession`, `refreshNativeSession`.
- Token stores: `createPreferencesTokenStore()` (backed by `@capacitor/preferences`) and `createInMemoryTokenStore()`.
- PKCE helpers `createPkcePair()` and `createState()`.
- `loadCapacitorPlugins()` / `isNativePlatform()`; all `@capacitor/*` plugins are optional peers with graceful fallback.
