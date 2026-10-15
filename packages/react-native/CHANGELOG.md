# @atlasauth/react-native changelog

## 0.4.0
- **Safer sign-out.** `signOut(options?: SignOutOptions)` (on `AtlasStore` and `useAuth()`) now revokes the
  session on the Frontend API (`POST /v1/client/sessions/:id/revoke`, retried once) with the token being
  dropped, then clears the stored token, and resolves `SignOutResult` (`{ revoked: boolean; activeSessionId?: string }`)
  instead of `void`. Existing `await signOut()` call sites keep working.
  - `{ strict: true }` rejects with `SignOutError` (`code: 'SIGN_OUT_REVOKE_FAILED'`, `sessionId`, `status`)
    when the revoke was not confirmed, after the local sign-out.
  - The session id is remembered (a tombstone) before the revoke, so `bootstrap()` never re-adopts a
    signed-out session from a token that survived the sign-out; a refused session's revoke is re-tried in
    the background (bound to its own token) and the tombstone dropped once the server confirms. A token
    adapter whose `clearToken()` throws no longer makes `signOut()` reject.
  - `activeSessionId` is reported when the server names a promoted session, but not adopted: a bearer
    client receives no token for it (the Frontend API does not promote on a bearer revoke today).
  - A session with no `sid` in the stored token is found with `GET /v1/client` before revoking.
- **Added `AtlasStoreConfig.tombstoneStore?: TombstoneStore`** / `<AtlasProvider tombstoneStore>`: where the
  signed-out session ids are kept (session ids only, never tokens). Defaults to memory; pass an AsyncStorage /
  `expo-secure-store` adapter to keep them across restarts. Added `createInMemoryTombstoneStore()` and the
  `TombstoneStore` type export.
- **Added `AtlasStoreConfig.signOutRetryDelaysMs?: number[]`**: delays between background revoke re-tries
  (default `[15000, 60000, 300000]`).
- **Added `AtlasStore.dispose()`**: cancels scheduled background re-tries (`<AtlasProvider>` calls it on unmount).
- **Added email-delivery facts for apps drawing their own screens** (this SDK ships no prebuilt sign-in /
  sign-up UI): `AtlasStore.getInstanceSettings(): Promise<InstanceSettings | null>`,
  `AtlasStore.getEmailDelivery(): Promise<EmailDelivery>` (all `true` when unknown) and the
  `useEmailDelivery(): { isLoaded: boolean; emailDelivery: EmailDelivery | null }` hook.
- **Re-exported from `@atlasauth/js`:** `SignOutError`, `SignOutResult`, `SignOutOptions`, `EmailDelivery`,
  `InstanceSettings`, `EMAIL_DELIVERY_UNKNOWN`, `EMAIL_UNAVAILABLE_MESSAGE`, `offeredFirstFactors`.

## 0.3.0
- **Fixed: `signUpWithPassword` now creates accounts.** It posted `email_address` (and top-level
  `first_name` / `last_name`), which the Frontend API does not read, so every sign-up was refused for a
  missing email. It now posts `email`, and sends names as the `first_name` / `last_name` sign-up fields.
- **Fixed:** an immediately-complete sign-up stored the one-time ticket as the session token; it now
  exchanges the ticket for a token first, like every other completion.
- **Added to `signUpWithPassword`:** `fields?: Record<string, string>` (the instance's configured
  sign-up fields), `consent?: boolean` (legal-consent agreement), `captchaToken?: string`.
- **Added to `signInWithPassword`:** `captchaToken?: string`; a sign-in the server answers with a
  captcha challenge now asks for a token and continues, or returns `CAPTCHA_REQUIRED` instead of a
  `needs_more` with status `needs_captcha`.
- **Added captcha support without a WebView:** `AtlasStoreConfig.getCaptchaToken` /
  `<AtlasProvider getCaptchaToken>` — `(request: CaptchaTokenRequest) => Promise<string | null>`, called
  only when the instance requires a token, with `{ flow: 'signUp' | 'signIn', captcha: FlowCaptcha | null }`
  (the public provider / site key / widget mode); the request is retried once with the token.
- **Added** the `CaptchaTokenRequest` type, `ATLAS_ERROR_CODES.CAPTCHA_REQUIRED` /
  `ATLAS_ERROR_CODES.CAPTCHA_FAILED`, and `isCaptchaRequired(result)`.
- **`frontendApi` is validated at `AtlasStore` / `createNativeClient()` / `createNativeSessionManager()`.** A missing, empty or malformed value now throws an
  `AtlasConfigError` (from `@atlasauth/js`; `code: 'FRONTEND_API_REQUIRED'` or `'FRONTEND_API_INVALID'`)
  instead of silently sending requests to relative URLs on the app's own origin. Accepted: an absolute
  `https:` URL (`http:` only for localhost / local development hosts). Native apps have no origin of their own, so `"same-origin"` is refused.

## 0.2.2

### Added
- Named server error codes: `ATLAS_ERROR_CODES` (including `EMAIL_DELIVERY_NOT_CONFIGURED`, `VALIDATION_FAILED`, `RATE_LIMITED`, `IDENTIFIER_NOT_FOUND`, `IDENTIFIER_EXISTS`, `VERIFICATION_EXPIRED`, `VERIFICATION_FAILED`, `EMAIL_NOT_VERIFIED`, `TOO_MANY_ATTEMPTS`, `PASSWORD_BREACHED`, `PASSWORD_POLICY`, `LOCKED`) and the `AtlasErrorCode` type.
- Error helpers for `FlowResult` errors: `hasErrorCode()`, `isEmailDeliveryNotConfigured()` and `firstErrorMessage()`.

## 0.2.1

### Added
- `useAuth()` now also returns `status` (`loading` | `signed_in` | `signed_out`) and `session` (the active session, or `null`) alongside `isLoaded` / `isSignedIn`.

### Changed
- README examples use the published `@atlasauth/*` package names.

## 0.2.0

### Added
- Native-session support: `createNativeSessionManager()` returns a `NativeSessionManager` backed by your `TokenStorage`, rehydrating a stored session and persisting each rotated refresh token, so an app can hold a full Atlas session without cookies. Options are typed as `NativeSessionConfig`.
- `clearNativeSession()` to remove the persisted native session on sign-out.
- Re-exports `NativeSessionManager`, `NativeSession`, `exchangeForSession()` and `refreshNativeSession()` from `@atlasauth/js`.

## 0.1.1

First published release.

### Added
- `AtlasProvider` for React Native and Expo, holding the session token in a `TokenStorage` adapter you supply (for example `expo-secure-store` or AsyncStorage) and sending it as a bearer header; `createInMemoryStorage()` as a non-persistent default.
- Hooks: `useAuth()` (including `has()` for permission, role, `anyPermission` and `allPermissions` checks), `useUser()`, `useSession()`, `useSignIn()` and `useSignUp()`, plus `useAtlasStore()` / `useAtlasState()`.
- `AtlasStore` / `createAtlasStore()` for the session state outside React.
- Client helpers: `createNativeClient()`, `bearerFetch()`, `startOAuthSignIn()`, `exchangeTicketForToken()`, `fetchCurrentUser()` and `decodeClaims()`.
- Types `AtlasUser`, `AtlasSession`, `SessionClaims`, `AuthStatus` and `FlowResult`.

