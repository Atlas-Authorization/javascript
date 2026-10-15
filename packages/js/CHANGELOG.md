# @atlasauth/js changelog

## 0.7.0
- **Popup OAuth completes when the opener page sends `Cross-Origin-Opener-Policy: same-origin`.** That
  header puts the provider popup in another browsing-context group: `popup.closed` reads `true` at once and
  the popup has no `window.opener`, so the result could never be posted back and the flow settled as a
  cancel while the popup stayed open. Now the popup lands back on your page with the result in the URL
  fragment (`#atlas_popup_result=…`, never the query string), the SDK there hands it to the opener over
  `BroadcastChannel('atlas:oauth:<nonce>')` (a `localStorage` `storage` event where BroadcastChannel is
  missing) and closes the popup.
- **Changed `startOauthPopup` cancel semantics.** `popup.closed` turning true within 1.5 s of opening means
  the opener link was severed, not that the user closed it: the flow keeps waiting, probing `GET /v1/client`
  with back-off, for up to 5 minutes, and settles as `popup_closed` only on that timeout, an explicit error
  result, `signal` aborting, or a newer popup flow starting. A close after 1.5 s is a cancel after one final
  session probe (as before).
- **Changed `startOauthPopup` request.** It now sends `popup_nonce` and `opener_origin`
  (`window.location.origin`) with `mode: 'popup'`, and opens the popup with the window name `atlas:oauth`.
- **Added** to `startOauthPopup`: `input.signal?: AbortSignal`, `handlers.onSevered?: () => void`,
  `PopupStartResult.severed?: boolean`; new `OAuthPopupInput` type; `POPUP_SEVERED_WINDOW_MS` (1500) and
  `POPUP_SEVERED_TIMEOUT_MS` (300000); `mapOAuthPopupPayload(data)` (the payload half of
  `parseOAuthPopupMessage`).
- **Added popup channel helpers:** `completeOAuthPopupLanding({ win?, ackTimeoutMs? })` →
  `PopupLanding | null` (`{ payload, delivered }`; reads and scrubs the fragment, relays the result and
  closes once the opener acknowledges — call it on startup), `closeOAuthPopupAfterSignIn({ win?, ackTimeoutMs? })`
  (a page that finished a sign-in inside the Atlas popup closes itself when an opener is waiting),
  `listenForPopupResult(nonce, { onResult, onSignedIn? })`, `readPopupLanding(hash)`, `popupChannelName(nonce)`,
  `createPopupNonce()`, `PopupRelayMessage`, and the constants `OAUTH_POPUP_WINDOW_NAME`
  (`'atlas:oauth'`), `POPUP_RESULT_FRAGMENT` (`'atlas_popup_result'`), `POPUP_SIGNAL_CHANNEL`.
- **Sign-out tombstones are shared by every tab.** `SessionTombstones` moved from `sessionStorage` to
  `localStorage`, so after a failed revoke a newly opened tab no longer re-adopts the session. Entries are
  `{ id, at }`, at most 20, kept 30 days, pruned on every read, and keyed per Frontend API origin
  (`atlas:signed-out-sessions:<origin>`). `sessionStorage` is used only when `localStorage` throws; tombstones
  an earlier version kept in `sessionStorage` are carried over.
- **Changed** `new SessionTombstones(options?)`: accepts `{ frontendApi?, storageKey?, now? }`
  (`SessionTombstonesOptions`); a bare storage-key string is still accepted. **Added** `remove(...ids)` (forget
  a tombstone once a later revoke is confirmed) and `subscribe(listener)` (another tab's changes, via the
  `storage` event). `has()`/`list()` re-read storage, so other tabs' changes are seen.

## 0.6.0
- **Per-flow captcha widget rendering**, shared by the prebuilt sign-in / sign-up UIs:
  `renderCaptchaWidget(flow, container)` → `{ token: Promise<string>, remove() }`,
  `getCaptchaToken(flow, container)`, `loadCaptchaProvider(provider, siteKey, win)`,
  `isRenderableCaptcha(provider)`, `flowNeedsCaptcha(flow)`, `isCaptchaError(error)` and
  `CAPTCHA_ERROR_CODES`. Renders Turnstile, hCaptcha, reCAPTCHA v2, v3 and Enterprise, honouring the
  `invisible` / `managed` / `visible` widget mode. A failed script load is retried on the next render.
- **Added types** `FlowCaptcha` (`{ enabled, provider?, siteKey?, widget? }` — one entry of
  `/v1/appearance` `captchaFlows`), `CaptchaFlowKey`, `CaptchaWidgetMode`, `CaptchaWidgetHandle`.
- **Framework-agnostic captcha lifecycle** for the prebuilt forms of every framework SDK:
  `createCaptchaController(options?)` → `CaptchaController` (`needed`, `configure(options)`,
  `attach(el)`, `getToken()`, `reset()`, `destroy()`), with the new `CaptchaControllerOptions` type
  (`{ flow, active, eager?, onSolved? }`); `localizeCaptchaErrors(errors, t)`.
- **Sign-in / sign-up submit helpers:** `signInCaptchaOptions(flow, state, onChallengeSolved)`,
  `advanceWithCaptcha(client, state, values, { captcha?, identifier?, t })` → `{ state, identifier }`
  (adds the captcha token on the identifier / `needs_captcha` step, reports a rejected token as
  `CAPTCHA_FAILED` and draws a fresh widget), and `createSignUp(client, values, { consent, captcha?, t })`
  (posts `/v1/client/sign_ups` with the sign-up captcha's token).
- **Instance settings:** `fetchInstanceSettings(client)` (`GET /v1/appearance`, null on failure),
  `instanceSettingsFrom(body)`, `toSignUpInput(values, consent, captchaToken?)`, and the types
  `InstanceSettings` (`{ captchaFlows, signUpFields, legal }`) and `PublicSignUpField` (moved here from
  `@atlasauth/react`, which re-exports them unchanged).

- **New: `resolveFrontendApi(value, { component?, allowSameOrigin? })`** — validates a provider's
  `frontendApi` and returns the request base URL. Throws an **`AtlasConfigError`** (new, exported;
  `code: AtlasConfigErrorCode` = `'FRONTEND_API_REQUIRED' | 'FRONTEND_API_INVALID'`) when the value is
  missing, non-string, blank, not an absolute `https:` URL (`http:` only for localhost / local development hosts), or
  carries credentials, a query or a fragment. `"same-origin"` (new constant `SAME_ORIGIN_FRONTEND_API`)
  resolves to `""` and a root-relative path such as `"/atlas"` is kept, for reverse proxies; both are refused
  with `allowSameOrigin: false` (native apps). An explicit `""` is the **deprecated** same-origin spelling: it
  still resolves to `""` (one-time console warning pointing at `"same-origin"`), and is refused with
  `allowSameOrigin: false`. Every framework SDK now uses it instead of `frontendApi ?? ''`.
- **New: `revokeSession(request, sessionId, { retries = 1 })`** → `RevokeSessionOutcome`
  (`{ revoked, status, response?, activeSessionId? }`). Retries once on a network failure, 5xx or 429; a 404
  counts as revoked; `activeSessionId` is the parked session the server promoted.
- **New: `SessionTombstones`** — remembers (memory + `sessionStorage`, bounded to 20) the session ids a tab
  signed out of, so a re-boot from a still-valid refresh cookie never re-adopts them.
- **New types:** `SignOutResult` (`{ revoked: boolean; activeSessionId?: string }`), `SignOutError`
  (`code: 'SIGN_OUT_REVOKE_FAILED'`, `sessionId`, `status`), `ResolveFrontendApiOptions`, `RevokeSessionOutcome`.
- **`SignOutOptions.strict?: boolean`** added (reject with `SignOutError` when the revoke fails; honoured by
  `@atlasauth/react`).
- **Popup OAuth:** when the popup closes without posting a result, `startOauthPopup()` checks
  `GET /v1/client` once; if a session now exists it resolves `{ error: 'popup_closed', sessionDetected: true }`
  (new `PopupStartResult.sessionDetected?: boolean`) so the caller re-boots instead of treating it as a cancel.
- **End-user API key self-service.** New `listApiKeys(client, { organizationId? })`,
  `createApiKey(client, input)`, `updateApiKey(client, id, { name })` and
  `revokeApiKey(client, id)` drive `/v1/client/me/api_keys` through a `FapiClient`.
  Added types: `UserApiKey` (`id`, `subject_type`, `subject_id`, `name`, `prefix`, `claims`,
  `scopes`, optional `limits`, `last_used_at`, `expires_at`, `revoked_at`, `created_at`),
  `CreatedUserApiKey` (adds the one-time `secret`, `note`), `UserApiKeyList` (`data`,
  `allowedScopes`, `allowedClaims`, `maxActiveKeys`, `activeCount`) and `CreateUserApiKeyInput`
  (`name`, `expiresAt`, `expiresInSeconds`, `scopes`, `claims`, `organizationId`). A refused call
  throws the new `ApiKeyRequestError` (`code`, `status`, `param`, `needsReverification`).

## 0.5.0
- **OIDC Front-Channel Logout helpers.** `runFrontChannelLogout(urls, { timeoutMs })` loads each
  front-channel logout URL in a hidden, sandboxed iframe and resolves once they have all loaded or
  after the timeout (default 5 s); it never throws, only loads `https:` URLs (and `http://localhost`
  for development), and is a no-op without a DOM (SSR). `runFrontChannelLogoutFromResponse(res)`
  reads `frontchannel_logout_urls` from a Frontend API sign-out response. The framework SDKs'
  `signOut()` uses them; the new `SignOutOptions` type (`{ frontchannel?: boolean }`) is the option
  they accept.


## 0.4.0
- `AttemptView` now carries `id` (`string | null`; `null` only on the pre-attempt captcha
  challenge), plus optional `object`, `identifier` and `expires_at`, matching what the server
  returns, so consumers can read `attempt.id` without a cast.

## 0.3.0
- **Captcha for any action.** New `captcha(client)` returns `config(action?)` (fetch the
  centrally managed public provider + site key), `verify(token, action?)` (server-side check)
  and `protect(element, action?)` (load the provider's widget script, render it, resolve the
  solved token) — so an app can protect any action without hardcoding provider keys.
- New `CaptchaWidgetConfig` and `CaptchaVerification` types, plus `loadCaptchaScript()` /
  `resetCaptchaScripts()`.

## 0.2.0
- **Native-session helpers** for apps without a cookie jar (React Native, Electron, extension
  service workers): `exchangeForSession()` trades a first-party OAuth access token for an Atlas
  session, and `refreshNativeSession()` rotates it without cookies. Both return `null` instead
  of throwing on failure.
- `NativeSessionManager` holds the current session, hands out a fresh session JWT and fires
  `onChange` on every rotation so the new refresh token can be persisted.
  `serializeNativeSession()` / `parseNativeSession()` help store it. New `NativeSession` type.

## 0.1.9
- Fixed: the invisible Google overlay now uses a near-zero opacity instead of exactly `0`.
  Google's button treats an element at `opacity: 0` as not visible and silently ignores the
  click; the overlay stays invisible to users but now receives the click.

## 0.1.8
- Fixed: the native Google overlay now stretches Google's button iframe, which Google injects
  asynchronously, to cover the whole wrapper (re-applied via a `MutationObserver`), so clicks
  near the edges no longer miss.

## 0.1.7
- Added: `renderGoogleOverlayButton` accepts `visible` — `false` (default) keeps Google's button
  as an invisible click target over your own styled button; `true` shows Google's own button.
- Added: `diagnoseProvider()` reports a provider's resolved mode, client id, overlay geometry and
  whether a credential was minted this session, for debugging a dead Google button. New `Rect`,
  `OverlayGeometry` and `ProviderDiagnosis` types; `resetGoogleCredentialFlag()`.
- Changed: the invisible Google overlay is stretched to fill its wrapper, and in development it
  warns in the console when it is misaligned or undersized.

## 0.1.6
- Added: `reportProviderUnavailable(client, provider, reason)` sends a best-effort beacon when a
  native provider (Google) can't be used, so the failure shows up in the dashboard. New
  `ProviderUnavailableReason` type (`'script_blocked' | 'not_rendered'`).
- Changed: device telemetry honours Do-Not-Track — when it is on, no persistent device id is
  stored. New `doNotTrackEnabled()`.

## 0.1.5
- Added: popup-mode social / OIDC sign-in. `startOauthPopup(client, { provider, redirectUrl })`
  opens the provider in a popup, accepts the result only from the Frontend API origin, and falls
  back to a full-page redirect when the popup is blocked. New `parseOAuthPopupMessage()`,
  `PopupOutcome`, `PopupStartResult` and `OAuthPopupHandlers`.
- Added: `FapiClient.frontendApiOrigin`.

## 0.1.4
- Added: `startOauthRedirect(client, { provider, redirectUrl })` starts a redirect OAuth sign-in
  and returns the provider's authorization URL.

## 0.1.3
- Added: `renderGoogleOverlayButton` accepts `oneTap` to also show Google One Tap (off by
  default).

## 0.1.2
- Added: native Google sign-in with replay protection. `mintNativeNonce(client, provider)` gets a
  single-use nonce from Atlas and `nativeSignIn(client, { provider, idToken, nonce })` signs in
  with a provider id token, returning the same `FlowState` as the other sign-in flows.

## 0.1.1
- First published release.
- Sign-in / sign-up flow driver over the Frontend API (`FapiClient`, `initialFlow`, `advance`,
  `startSignUp`, `prepareFactor`, `pollAttempt`) with attempt helpers (`nextStep`, `fieldErrors`,
  `formErrors`).
- Session token cache with refresh scheduling (`TokenCache`) and cross-tab refresh election
  (`winsElection`, `bestChannel`).
- Google Identity Services helpers (`loadGoogleIdentityServices`, `renderGoogleButton`,
  `renderGoogleOverlayButton`), passkeys (`createPasskey`, `getPasskeyAssertion`,
  `passkeysSupported`), Telegram and Sign-In with Ethereum request builders.
- Redirect handling (`readRedirectResult`, `stripRedirectParams`), password reset
  (`startPasswordReset`, `advancePasswordReset`), step-up re-authentication
  (`reauthenticate`), connecting an extra provider (`connectExternalAccount`) and provider
  tokens (`getProviderToken`).
- Silent cross-site session check (`checkSession`, `handleSilentCallback`) and device
  telemetry (`sendTelemetry`).
- Authorization helpers re-exported from `@atlasauth/authz` (`hasFromClaims`,
  `protectFromClaims`, `evaluate`, `ForbiddenError`, …).
