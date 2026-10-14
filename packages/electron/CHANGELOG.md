# @atlasauth/electron changelog

## 0.2.1
- **`frontendApi` is validated at start-up.** A missing (or non-string) or malformed value now throws an
  `AtlasConfigError` (from `@atlasauth/js`; `code: 'FRONTEND_API_REQUIRED'` or `'FRONTEND_API_INVALID'`)
  instead of silently sending requests to relative URLs on the app's own origin. Accepted: an absolute
  `https:` URL (`http:` only for localhost / local development hosts), or `"same-origin"` / a root-relative path such as `"/atlas"` for a reverse proxy (renderer only). Native apps have no origin of their own, so `"same-origin"` is refused in the main-process session manager.
- **Deprecated:** `frontendApi: ""` (the original same-origin spelling) still works as same-origin in the renderer, with a
  one-time console warning; use `"same-origin"` instead.

## 0.2.0

### Added
- Native-session support for apps without a cookie jar: `createNativeSessionManager()` returns a `NativeSessionManager` backed by the main-process `TokenStorage`, rehydrating a stored session on start and persisting each rotated refresh token. Options are typed as `NativeSessionOptions`.
- `clearNativeSession()` to remove the persisted native session on sign-out, and `DEFAULT_NATIVE_SESSION_KEY`.
- Re-exports `NativeSessionManager`, `NativeSession`, `exchangeForSession()` and `refreshNativeSession()` from `@atlasauth/js`.

## 0.1.0

First published release.

### Added
- Main process: `createAtlasBridge()` keeps the session token in the main process and exposes it to the renderer over a narrow IPC surface (`ATLAS_TOKEN_CHANNELS`).
- Token storage: `createTokenStorage()` with an optional cipher such as `safeStorageCipher()` (Electron `safeStorage`), plus `createInMemoryTokenStorage()`.
- Preload entry `@atlasauth/electron/preload` with `exposeAtlasBridge()` to publish the bridge on `window` via `contextBridge`.
- Renderer: `getAtlasBridge()`, `bearerFetch()` and `createAtlasClient()`, which builds an `@atlasauth/js` client that sends the session token as a bearer.
- Structurally typed against Electron, so the package compiles without the `electron` types installed.
