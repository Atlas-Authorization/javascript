# @atlasauth/capacitor changelog

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
