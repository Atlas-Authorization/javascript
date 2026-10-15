# @atlasauth/expo changelog

## 0.2.0
- **Signing out clears the stored session token.** `createCacheFetch()` now clears the token in the
  `TokenCache` when `POST /v1/client/sessions/:id/revoke` succeeds (2xx, or 404 — already gone) for the
  session the token belongs to (its `sid`), before the response is returned. Previously a sign-out left
  the token in the cache. A failed revoke keeps the token, so the background re-try can still
  authenticate; a `jwt` a revoke response carries is still persisted.
- **A failed sign-out survives an app restart.** `<AtlasProvider>` passes `@atlasauth/react` a
  `tombstoneStore` backed by the same `TokenCache`, so the ids of sessions the app signed out of persist
  (React Native has no `localStorage`; they were memory-only). After a restart a session whose revoke
  failed is refused — and its revoke re-tried — instead of re-adopted from the token.
- **Added `tombstoneStoreFor(cache: TokenCache): TombstoneStore`** — the adapter (`getItem` →
  `cache.getToken`, `setItem` → `cache.saveToken`; the key is rewritten to `[A-Za-z0-9._-]` for
  `expo-secure-store`).
- **Added `tombstoneStore?: TombstoneStore` to `AtlasProviderProps`** (inherited from `@atlasauth/react`
  0.7.0); defaults to `tombstoneStoreFor(tokenCache)`.

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
