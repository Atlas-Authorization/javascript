# @atlasauth/electron changelog

## 0.3.0
- **Added sign-out that revokes the session.** Until now the bridge could only clear the token, so the
  session stayed alive server-side. New:
  - Renderer: `signOut(options?: SignOutOptions & { bridge?: AtlasTokenBridge | null }): Promise<SignOutResult>`
    resolves `{ revoked: boolean; activeSessionId?: string }`; `{ strict: true }` rejects with a real
    `SignOutError` (`code: 'SIGN_OUT_REVOKE_FAILED'`, `sessionId`, `status`), re-created in the renderer from
    the main process's reply (an error thrown across IPC loses its class). A bridge from an older preload
    clears the token and resolves `{ revoked: false }`.
  - Main: `AtlasBridge.signOut(options?: SignOutOptions): Promise<SignOutResult>` (rejects `SignOutError`
    under `strict`), and the `ATLAS_TOKEN_CHANNELS.signOut` (`'atlas:token:sign-out'`) IPC handler, which
    resolves a `SignOutReply` (`{ revoked; activeSessionId?; sessionId: string | null; status: number }`)
    and never rejects for a failed revoke.
  - Preload: `exposeAtlasBridge()` publishes `window.atlas.signOut(options?: SignOutRequest)`;
    `AtlasTokenBridge.signOut?` is optional in the type.
  - The revoke (`POST /v1/client/sessions/:id/revoke`, retried once) is sent from the main process with the
    stored token; a token with no `sid` claim is resolved with `GET /v1/client` first. With no stored token
    there is nothing to revoke (`{ revoked: true }`).
- **Signed-out sessions are never re-adopted.** The session id is remembered (a tombstone) in the bridge's
  `storage` before the revoke — session ids only, under `atlas:signed-out-sessions:<frontend api origin>` —
  so a token for it is refused by `getToken()` (and dropped from storage) on every read, including the first
  read after a restart, and ignored by `setToken()`. A refused session's revoke is re-tried in the background
  with its own token and the tombstone is dropped once the server confirms.
- **Added `CreateAtlasBridgeOptions`:** `frontendApi?: string` (absolute URL, validated like the session
  manager), `publishableKey?: string`, `fetchImpl?: typeof fetch`, `signOutRetryDelaysMs?: number[]`
  (default `[15000, 60000, 300000]`). Without `frontendApi` + `publishableKey`, `signOut()` can only clear
  the token and reports `revoked: false`.
- `activeSessionId` is reported when the server names a promoted session, but not adopted: a bearer client
  receives no token for it.
- `AtlasBridge.cleanup()` also removes the sign-out handler and cancels scheduled background re-tries.
- **Added types:** `SignOutReply`, `SignOutRequest`; re-exports `SignOutError`, `SignOutOptions`,
  `SignOutResult` from `@atlasauth/js`.

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
