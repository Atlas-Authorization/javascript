# @atlasauth/expo changelog

## 0.1.2
- Picks up `@atlasauth/react` 0.6.0 / `@atlasauth/js` 0.7.0: popup sign-in completes when the opener page
  sends `Cross-Origin-Opener-Policy: same-origin`; a tab opened after a failed sign-out stays signed out
  (sign-out tombstones shared across tabs); the default focus ring keeps 3:1 contrast. No API changes.

## 0.1.1
- **`frontendApi` is validated at mount (via `@atlasauth/react`) and in `createNativeSessionManager()`.** A missing, empty or malformed value now throws an
  `AtlasConfigError` (from `@atlasauth/js`; `code: 'FRONTEND_API_REQUIRED'` or `'FRONTEND_API_INVALID'`)
  instead of silently sending requests to relative URLs on the app's own origin. Accepted: an absolute
  `https:` URL (`http:` only for localhost / local development hosts). Native apps have no origin of their own, so `"same-origin"` is refused by the native session manager.

## 0.1.0

First published release.

### Added
- `AtlasProvider` for Expo that carries the session as a bearer token instead of a cookie.
- `createSecureStoreTokenCache()` backed by `expo-secure-store`, and `createInMemoryTokenCache()` for Expo Go and tests.
- `createCacheFetch()`, `tokenStorageFor()` and `createInMemoryStorage()` token-storage helpers.
- Native session management: `createNativeSessionManager()` and `clearNativeSession()`.
- Re-exports `useAuth`, `useUser`, `useSession`, `useSessionList`, `useOrganization`, `SignedIn`, `SignedOut`, `Protect`, `AtlasLoading` and `AtlasLoaded` from `@atlasauth/react`.
- `expo-secure-store`, `expo-web-browser` and `expo-auth-session` are optional peers.
