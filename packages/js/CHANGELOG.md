# @atlasauth/js changelog

## Unreleased

### Added

- `scopeImplications` on the user's API key list, plus the `impliedScopes()` and `scopeGrid()` helpers for a resource by read/write scope picker.
- `signInWithPasskey`, `startConditionalPasskeySignIn` and `createPasskeySignInController`: usernameless passkey sign-in (button and autofill) for any prebuilt or custom form; a cancelled prompt is a `PASSKEY_CANCELLED` error, never a throw.
- `InstanceSettings.passkeySignIn` says whether the instance offers passkey sign-in.
- One `POST /v1/client/tickets/exchange` per ticket: a second exchange of the same ticket within 10 seconds (React StrictMode, a double-mounted router) shares the first answer instead of failing with 400.

## 0.26.1 — 2026-10-28

- The SDK reports its own version correctly again (the previous release still identified itself as the release before).

## 0.26.0 — 2026-10-28

- CIBA approvals and PIN (`listCibaRequests`, `decideCibaRequest`, `getCibaPin`, `setCibaPin`, `clearCibaPin`)
- Cross-device magic link (`prepareFactor(..., { crossDevice: true })`, `previewCrossDeviceLink`, `confirmCrossDeviceLink`)
- Passkey hints, conditional create and `getClientCapabilities`
- Resource sharing client and connector directory facets

## 0.25.0 — 2026-10-27

- `signInWithSrp` and `srpClientStart`: SRP-6a password sign-in (RFC 5054, 3072-bit group, SHA-256), so the password never leaves the browser.
- `listAuthorizedApps`, `disconnectAuthorizedApp` and `revokeAppGrant`: the apps a user authorized, with the OpenID Grant Management grants each holds.
- Identity governance for the signed-in user: `listAccessCatalog`, `requestAccess`, `listMyAccess`, `listMyAccessRequests`, `getAccessRequest`, `cancelAccessRequest`, `listPendingApprovals`, `decideAccessRequest`, `listAccessReviews`, `decideAccessReview`, `listAccessDelegations`, `delegateApprovals` and `endDelegation`.
- Connections: `revokeMyConnection` and `revokeOrganizationConnection` return `provider_revoked` (true, false or `'unsupported'`), `provider_status`, `provider_error` and `local_cleared`; `AppConnection.last_error` carries the provider's code and HTTP status and `refresh_failures`.
- Connections: `setOrganizationConnectionCredentials` takes every credential field (bearer token, basic username and password, custom header value, HMAC secret, signing key, OAuth 1.0a keys), `expiresAt` and `config`; `AppConnection.kind` lists the new kinds and carries `secret_expires_at`. There is still no call that reads a credential back.
- Connections: `connectMyConnection`, `connectOrganizationConnection`, `revokeOrganizationConnection`, `listOrganizationOAuthClients`, `setOrganizationOAuthClient`, `deleteOrganizationOAuthClient`; `AppConnection` carries `environment`, `external_id`, `host_params`, `scopes`, `metadata` and `last_error`, and its status adds `revoked` and `error`.
- User-managed access for resource owners: `listUmaResources`, `shareUmaResource`, `unshareUmaResource`, `listUmaAccessRequests` and `decideUmaAccessRequest`, with a typed `UmaError`, plus `umaClaimsUrl` and `parseUmaClaimsRedirect` for the claims-gathering redirect.

## 0.24.0 — 2026-10-26

- Additional factors: `startHotp`, `verifyHotp`, `resyncHotp`; `enrollYubikey`, `looksLikeYubicoOtp`; `startDuoEnrollment`, `finishDuoEnrollment`, `prepareDuo`, `pollDuo`; `getSecurityQuestions`, `setSecurityQuestions`, `removeSecurityQuestions`, `getResetSecurityQuestions`; `signInWithSmartCard`. `advancePasswordReset` and `pollPasswordReset` take `{ askQuestions }` and a reset flow reports `securityQuestions` at the new-password step (send the answers as `securityAnswers`). `account.mfa` reads `hotp`, `yubikey`, `duo`, `securityQuestions` and `smartCard`; `MfaChoices.duo`.

## 0.23.1 — 2026-10-25

- `ATLAS_JS_VERSION` reports 0.23.1 (0.23.0 still reported 0.22.0 to the SDK advisory check).

## 0.23.0 — 2026-10-25

- `stepUp(client, { strategy, … })` and `sendStepUpEmailCode(client)`: re-authenticate the signed-in user in place (`POST /v1/client/me/step_up`) and get a token with a fresh `auth_time`; `authenticatedWithin(claims, maxAgeSeconds)` checks it.

## 0.22.0 — 2026-10-24

- Per-call integration audiences (`getToken({ for, cbid })`), partner platforms, operator tokens for partner products.

## 0.21.0 — 2026-10-24

- SSO organization claims, app adoption, validating dry runs, sealed secrets, consent API adapters; see the Atlas changelog.

## 0.20.0 — 2026-10-24

### Added

- Referral config reads `context_cookies` (a list of tracking cookies tried in order; `contextCookies` on the config) and falls back to the single `context_cookie`.

### Changed

- The `referally` browser source id is read as `referalli`.

- `loadSignInWithAtlas({ version?, integrity?, nonce? })`: load the Sign in with Atlas button script from your bundle; a Content-Security-Policy block is logged as `[Atlas] blocked by CSP: add <origin> to <directive> (…)` and rejects with `csp_blocked`. Plus `signInWithAtlasScriptUrl()` and `cspBlockedMessage()`.

## 0.19.0 — 2026-10-24

### Added

- Policy acceptance (terms of service, privacy, any policy): `getPolicies()`, `buildPolicyAcceptances()`, `acceptAttemptPolicies()` (continue a sign-in at `needs_policy_acceptance`), `getMyPolicies()` and `acceptPolicies()`; `startSignUp({ policyAcceptances })` and `startPasskeySignUp({ policyAcceptances })`.
- The `needs_policy_acceptance` attempt status and the `accept_policies` step (`pending_policies`, `policy_acceptance_token` on `AttemptView`; `FlowState.policyToken`); `advance` posts the step's acceptances with the held attempt's token. `readRedirectResult` and popup outcomes carry `policyToken` (`__atlas_policy_token`).
- Policy UI building blocks: `loadPolicies()` / `loadMyPolicies()` (camel-cased `Policy` lists), `PolicyAcceptanceController` (per-policy tick, in-page viewer clock, scroll-to-end, `build()` for the `policy_acceptances` body), `PolicyGateController` for in-app re-acceptance, `observeScrollEnd()`, `trapFocus()`, `mountPolicyConsent()` / `mountPolicyClickwrap()` / `openPolicyModal()` / `mountPolicyAcceptStep()` (the DOM the Vue, Svelte, Angular, Solid and embed UIs host) and `POLICY_STRINGS`.

## 0.18.0 — 2026-10-24

### Added

- Better Auth session bridge for apps whose Better Auth cookie is readable by script: exchanges it once for an Atlas session.

## 0.17.0 — 2026-10-24

### Added

- `@atlasauth/js/compat`: `createAuth0CompatClient` / `Auth0CompatClient`, a drop-in for `@auth0/auth0-spa-js` on Atlas for framework-free browser apps (`loginWithRedirect`, `handleRedirectCallback`, `loginWithPopup`, `isAuthenticated`, `getUser`, `getIdTokenClaims`, `getTokenSilently` incl. templates and `detailedResponse`, `getTokenWithPopup`, `checkSession`, `logout`), with `Auth0CompatError` codes. What `atlas migrate code --from auth0` rewrites auth0-spa-js onto.
- Device sign-in approval on your own page (RFC 8628): `lookupDeviceAuthorization(client, userCode)`, `approveDeviceAuthorization(client, authorization)` and `denyDeviceAuthorization(...)` over `/v1/client/me/device_authorizations`, with `formatUserCode`, `userCodeFromUrl` and `DeviceAuthorizationError` (`needsReverification` when the app requires a recent re-authentication to approve, `isInvalidCode`).
- SAML Single Logout on sign-out: when the server returns `saml_logout_url`, `signOut()` sends the browser there after the local sign-out, so the identity provider's session ends too. It does not when another account was promoted. `signOut({ samlLogout: false })` keeps the page, `signOut({ samlLogoutRedirectUrl })` picks where the IdP returns the browser, and `SignOutResult.samlLogoutUrl` reports the URL. Also `safeSamlLogoutUrl`.
- Upstream (RP-initiated) logout on sign-out: when the session came from a custom OAuth/OIDC provider or an enterprise OIDC connection with RP-initiated logout on, the server returns `upstream_logout_url` and `signOut()` follows it after the local sign-out. `signOut({ upstreamLogout: false })` keeps the page, `signOut({ returnUrl })` picks where the user lands, and `SignOutResult.upstreamLogoutUrl` reports the URL. `SignOutGuard` takes a `navigate` opener (native hosts), used for SAML Single Logout too.
- A browser follows one logout redirect: if a sign-out returns both `upstream_logout_url` and `saml_logout_url`, the upstream URL is followed and the SAML identity provider is told server-to-server (SOAP back-channel logout, when configured); both URLs are reported. `samlLogoutRedirectUrl` defaults to `returnUrl`.
- WebAuthn PRF: `getPasskeyAssertion` and passkey registration take `prf` (`PasskeyPrfRequest`: `eval`, `evalByCredential`) and `onExtensionResults` (`PasskeyExtensionResults`); the outputs go to your code only and the `finish` body is unchanged. `passkeyExtensionsInput`, `readExtensionResults`.
- Check an emailed one-time code without using it up: `checkEmailCode(client, target, code)` (`EmailCodeCheck` with `expires_at` and `attempts_remaining`) for sign-in first and second factor, sign-up verification, step-up and email-address verification; `emailCodeCheckRequest`, `emailCodeTargetForAttempt`.
- Captcha providers CaptchaFox and Vercel BotID (`attestation_url` / `attestationUrl`, `fetchBotIdAttestation`); `isRenderableCaptcha(provider, flow)` takes the flow.

## 0.16.0 — 2026-10-23

### Added

- `createOrganizationAuditLog(client, { pageSize, action })`: the framework-agnostic pager behind every SDK's `<OrganizationAuditLog/>`, with `organizationAuditLogPath`, `describeAuditAction` and the `OrganizationAuditLogEntry` type.
- Sign-up starts, and every start that can create an account (social, enterprise SSO and SAML, DiscourseConnect, native id_token, external JWT, LDAP, Telegram and wallet sign-ins), send the stable device id, so an instance's accounts-per-device limit counts devices rather than networks, across email and social sign-ups alike. `DEVICE_ID_ROUTES` lists them.
- The recovery codes an MFA enrolment completes the sign-in with: `advance` moves `backup_codes` off the attempt into `FlowState.recoveryCodes` (memory only), and the components show them before exchanging the ticket with `pendingRecoveryCodes`, `acknowledgeRecoveryCodes`, `copyRecoveryCodes`, `downloadRecoveryCodes` / `canDownloadRecoveryCodes` (a `recovery-codes.txt` file), `recoveryCodesText` and `recoveryCodesFrom`.
- The sign-in's MFA steps, shared by every framework SDK: `createMfaEnrollment` (the enrolment step's state and requests: authenticator app with `qrCode`, or a texted code), `prepareMfaEnrollment`, `enrollmentSubmitKey`, `groupSetupKey`, `prepareSecondFactorCode` (`sms` or `email_code`) and `mfaChoicesFrom`.
- `requestForStep` posts a texted enrolment as `{ factor_id, code }` (values with `enrollStrategy: 'phone_code'`).
- `AccountUx.mfa` (`{ totp, sms, totpCodes }`), read from `account.mfa` when the server sends it.
- `beginPasskeySignIn(client, { captcha })`: the passkey sign-in start (`sign_ins/passkey/begin`) with the sign-in captcha folded in. It sends `captcha_token` when the token source has one, and after a `CAPTCHA_REQUIRED` / `CAPTCHA_FAILED` refusal asks once for a fresh token and retries once.

## 0.15.0

### Added

- Referral capture works with any referral program and any consent manager: it reads Referally, Rewardful, Tolt, PromoteKit, FirstPromoter, PartnerStack and Dub (the instance's `browser_sources`), and asks Cookie Munch, OneTrust, Cookiebot, Didomi, Usercentrics, Osano, CookieYes, Complianz, Klaro, any IAB TCF v2 manager or Google Consent Mode for consent (the instance's `consent_provider`).
- `referralSource` (client option, `configureReferralCapture`, and `source` on `signIn` / `referralParams`): your own reader for any other program.
- `detectConsent`, `detectConsentProvider`, `detectReferralSource`, `REFERRAL_BROWSER_SOURCES` and `CONSENT_PROVIDERS` are exported.
- A captured referral says where it came from (`source`) and who decided consent (`consent_by`), also as `ref_source` / `ref_consent_by` on redirects, for the delivery log.

### Changed

- A consent manager on the page decides; `referralConsent` applies when there is none (or when the instance's `consent_provider` is `app`).

### Fixed

- Development instances: sign-in from `localhost` keeps working where the browser blocks the instance's cookie as third-party (Chrome, Safari). On a `pk_test_` key the SDK keeps the session's refresh token in `localStorage` and sends it as `x-refresh-token`; production keys never do.
- After a sign-in completes, the panel says "You're signed in" only once this browser holds the session, and says plainly when the browser didn't keep it, instead of "you are signed in where you started". That message is now shown only for a sign-in completed on another device.
- `withDevBrowser`, `devBrowserEnabled`, `devBrowserToken` and `forgetDevBrowserToken` are exported for custom fetch layers.

## 0.14.0
- **Referral capture v2.** One source per referral, in precedence order and never mixed: the page's referral script (`window.aff.getReferral()` → `{code, clickId, anonId, ts}`), explicit `ref_*` URL parameters (`ref`, `ref_click_id`, `ref_anon_id`, `ref_consent`, `ref_captured_at`), a code in the instance's URL parameters, then the tracking cookie. A URL code no longer travels with the cookie's click id. Click and anonymous ids are sent only with consent (Cookie Munch, `referralConsent`, or `ref_consent=granted` on the URL); without it only the code goes. The cookie may carry `ts` (becomes `captured_at`) and `exp` (an expired cookie is ignored).
- **New redirect helpers:** `signIn({ url | frontendApi, redirectUrl?, referral?: false | 'auto', consent?, config?, navigate? })` / `signUp(...)` go to the hosted page (or any URL, e.g. `/oauth2/authorize`) with the referral as `ref_*` query parameters; `referralParams(options)` and `withReferralParams(url, options)` for your own redirects.
- **New `lookupReferralCode(configOrTemplate, code, { fetchImpl?, timeoutMs? })`** → `{ valid, partnerDisplayName?, refereeReward? } | null` (the instance's public code lookup; null on any failure).
- `ReferralConfig` gains `codeLookupUrl` and `signupCodeField` (from `referrals.code_lookup_url` / `referrals.signup_code_field`). `FapiClientOptions.referral` and `ReferralCaptureOptions.referral` accept `'auto'` (the default). New exports: `referralTime`, `referralFromScript`, `explicitReferralFromSearch`, types `ReferralSourceFields`, `ReferralRedirectOptions`, `HostedRedirectOptions`, `ReferralCodeLookup`. `ReferralPage` gains `aff`. `parseReferralCookie` takes an optional `now`.

## 0.13.0
- **New: referral attribution.** A `FapiClient` captures the referral the visitor arrived with and sends it as `referral: { code, click_id, anon_id, consent, captured_at }` on every sign-in / sign-up start (`/v1/client/sign_ups`, `/v1/client/sign_ins`, OAuth / SSO / SAML / native id_token / passkey / wallet starts) and the steps that continue one, when the instance has referrals on. The code comes from the instance's URL parameters (default `ref`, `via`, `aff`) on the current page, the page the SDK loaded on, and their `redirect_url` / `after_url`. The instance's tracking cookie is read only under consent: Cookie Munch on the page decides (the instance's category, else its fallback category); otherwise the new `referralConsent` option (`'granted'` or a function) does. The SDK never writes the cookie. New `FapiClientOptions.referral?: false` (opt out) and `referralConsent?`; page-wide `configureReferralCapture({ referral, referralConsent })`. The config is read from `referrals` in `GET /v1/client/environment` / `GET /v1/appearance` (one read per page; nothing is fetched when there is no query and no config yet).
- **Referred sign-up challenge.** `fetchInstanceSettings` switches the sign-up and sign-in captcha on when a referral code was captured and the instance's `referrals.challenge_referred_signups` is `always` (as long as a captcha provider is configured). New exports: `referralChallengeRequired`, `withReferralChallenge`, `referralChallengeFlows`, `captureReferral`, `referralConfigFrom`, `parseReferralCookie`, `acceptsReferral`, `seedReferralConfig`, `referralCacheKeyFor`, types `ReferralConfig`, `ReferralCapture`, `ReferralConsent`, `ReferralCaptureOptions`.
- `FapiClient.post` is now `async` (it already returned a promise).

## 0.12.0
- **New: SDK identity and advisories.** `FapiClientOptions.sdk?: AtlasSdkInfo` (`{ name, version }`, default
  `@atlasauth/js`) is sent as `X-Atlas-SDK: <name>/<version>`; an `Atlas-SDK-Advisory` response header is logged once
  per advisory per page load. New exports: `ATLAS_JS_VERSION`, `ATLAS_JS_SDK`, `AtlasSdkInfo`, `SDK_HEADER`,
  `SDK_ADVISORY_HEADER`, `sdkHeaderValue()`, `parseSdkAdvisory()`, `reportSdkAdvisory()`, `resetSdkAdvisoryLog()`,
  `SdkAdvisoryNotice`.
- **New: sign-out events.** `SignOutNotifier` (`subscribe`, `expect(reason)`, `clear`, `signedOut(sessionId, fallback?)`),
  `SignOutEvent` (`{ reason, sessionId }`), `SignOutReason` (`'user' | 'other_tab' | 'session_expired' | 'revoked' |
  'unknown'`), `SignOutListener`, `SIGN_OUT_EVENT` (`'atlas:signout'`), `dispatchSignOutEvent()`, `onAtlasSignOut()` and
  `signOutReasonFromClient()` (reads the new `signed_out_reason` of a signed-out `GET /v1/client`). Every framework
  provider drives one.
- **New: `getTemplateToken(client, sessionId, template)`** → `{ jwt, expiresIn } | null` (`getToken({ template })`), and
  **`getForumulateReaderToken(client, spaceId?)`** → `{ jwt, expiresIn, orgId, spaceId, redeemUrl } | null`
  (`GET /v1/client/forumulate/reader_token`).
- **New: the Atlas captcha (provider `atlas`).** Atlas's own captcha needs no provider account or keys.
  `renderCaptchaWidget` (and so every prebuilt form using `createCaptchaController`) draws it when a flow's provider is
  `atlas`: it fetches a challenge, solves the proof of work in Web Workers (on the page when workers are blocked) and
  shows the shape-matching step only when the server asks for it, with an accessible alternative.
- **New exports:** `renderAtlasCaptcha(container, { fetchChallenge?, challengeUrl?, mode?, labels?, workers? })` →
  `{ token: Promise<string>; stale(): boolean; remove(): void }`, `solveAtlasChallenge(challenge, { workers?, cancelled? })`
  → `Promise<{ n, worker }>`, `searchAtlasRange`, `fetchAtlasChallenge(url, accessible?)`, `encodeAtlasToken(solution)`,
  `ATLAS_CAPTCHA_LABELS`, types `AtlasChallenge`, `AtlasCaptchaOptions`, `AtlasCaptchaLabels`, `AtlasCaptchaHandle`.
- **Added `FlowCaptcha.challengeUrl?: string`** (read from `/v1/appearance` `captchaFlows[flow].challengeUrl`).
- **Added `CaptchaWidgetHandle.stale?(): boolean`**: a solved token about to expire unspent; the captcha controller
  draws a fresh widget instead of sending it.
- **Added an optional third argument to `renderCaptchaWidget` / `getCaptchaToken`:** `{ atlas?: { fetchChallenge?, labels?, workers? } }`.
- `captcha(client).protect(el, action?)` supports `atlas` (the challenge is fetched through the client).
- **New: `atlasCaptchaLabels(lookup)`** → `Partial<AtlasCaptchaLabels>` from a translator or a flat catalog (keys in
  `ATLAS_CAPTCHA_LABEL_KEYS`, e.g. `captcha.puzzleTile`); unknown or echoed keys keep the English default.
- **New: second argument to `createCaptchaController(initial?, settings?)`**: `{ atlasLabels?: () => Partial<AtlasCaptchaLabels> }`,
  read each time a widget is drawn. New type `CaptchaControllerSettings`.

## 0.11.0
- **New: `fetchAtlasInitialState({ publishableKey, frontendApi, fetchImpl?, init?, timeoutMs? })`** →
  `Promise<AtlasInitialState>` (`{ appearance?: unknown; environment?: unknown }`). Fetches `/v1/appearance` and
  `/v1/client/environment` in parallel on the server, for a provider's `initialState`. Never throws: a part that
  fails or takes longer than `timeoutMs` (default 1500) is left out. `init` is passed to both requests (for example
  `{ next: { revalidate: 60 } }`).
- New types `AtlasInitialState` and `FetchInitialStateOptions`.

## 0.10.0
- **New: `planFirstFactor(offered)`** → `{ password: boolean; email: ('email_code' | 'email_link')[]; autoSend: 'email_code' | 'email_link' | null }`.
  The rule every prebuilt sign-in form follows: a password field only when the server offers `password`; with no
  password on offer, send the emailed code (else link) straight away.
- **New: `retryAfterSeconds(errors)`** → the `retry_after` seconds of a 429, or `null`, so a "Resend" button can wait it out.
- **New: `EmailFactor` type** (`'email_code' | 'email_link'`) and `FirstFactorPlan`.
- **Added `FlowState.prepared?: 'email_code' | 'email_link' | null`**: the emailed factor `prepareFactor` sent for the
  current attempt. `advance` keeps it while the attempt and status are unchanged (a wrong code) and clears it otherwise.
- **Changed `prepareFactor`**: keeps `poll_secret` only for `email_link`. A code is typed into this tab, so there is
  nothing to poll for.

## 0.9.1
- **Fixed** the invisible Google sign-in overlay: Google gives its button frame a -10px side margin, which left a strip on the right of the host button where clicks missed Google's button. The margin is now zeroed so the overlay covers the button exactly.

## 0.9.0
- **Added `reason?: string` and `meta?: Record<string, unknown>` to `FieldError`**, parsed from the Frontend API
  error envelope (`{ code, message, reason?, param?, meta? }`). `code` is unchanged. A network failure now carries
  the client-side reason `network`.
- **Added `reason?: string` and `meta?: Record<string, unknown>` to `ApiKeyRequestError`** (new optional
  constructor arguments `reason`, `meta` after `param`). `reauthenticate()` errors carry `.reason` too.
- **New: `localizedErrorMessage(error, strings?, fallback?)`** → the text to show for a server error: the catalog
  string `error.<reason>` (placeholders filled from `meta`), else the server's `message`, else `error.generic`,
  else an English generic sentence — never blank. `strings` is a flat catalog or a `(key) => string | undefined`
  lookup (a lookup that echoes the key counts as missing). `ErrorStrings` accepts any object, so an
  `interface`-typed bundle such as `esES` from `@atlasauth/localizations` passes without a cast.
- **New: `ERROR_REASONS`** (the 38 reasons the shipped catalogs translate), type **`ErrorReason`**,
  **`errorReasonKey(reason)`** (`error.<reason>`), types **`ErrorLike`** and **`ErrorStrings`**, and
  **`catalogLocale(catalog)`** (a bundle's own `locale` tag).
- **New: `FapiClientOptions.locale?: string`** — sent as `Accept-Language` on every request so the server's
  `message` comes back in that language; `FapiClient.locale` getter and **`acceptLanguageFor(tag)`** (normalises
  `pt_BR` → `pt-BR`, rejects anything that is not a plain BCP-47 tag). **`ReauthOptions.locale?: string`** does the
  same for `reauthenticate()`.


## 0.8.0
- **New: `SignOutGuard`** — the safer sign-out every framework provider now drives, so they all behave like
  `@atlasauth/react`: `new SignOutGuard({ request, frontendApi?, store?, tombstones?, retryDelaysMs?,
  frontChannelLogout? })` (`SignOutGuardOptions`). Methods: `revoke(sessionId, { frontchannel?, request? })` →
  `SignOutAttempt` (`{ sessionId, outcome }`; finds the cookie session with `GET /v1/client` when the id is unknown,
  tombstones it before revoking, revokes with one retry, runs front-channel logout, and re-tries a failed revoke in
  the background after 15 s, 1 min and 5 min); `settle(attempt, { strict? })` → `SignOutResult` (throws
  `SignOutError` under `strict`); `promoted(attempt)` → the server-promoted session id to adopt, or null;
  `refuse(sessionId)` → whether a booted session must not be adopted (re-tries its revoke in the background and
  removes the tombstone once it lands); `isSignedOut(id)`; `signal(attempt)` / `learn(message)` for the cross-tab
  `{ signedOut: string[] }` message; `watch(current, onSignedOut)` (another tab signed out of this session);
  `ready`; `dispose()`; `tombstones`. **Added types** `FapiRequest`, `SignOutGuardOptions`, `SignOutAttempt`,
  `SignedOutSignal`.
- **Tombstones on platforms without `localStorage`.** `SessionTombstonesOptions.store?: TombstoneStore` (new type:
  `{ getItem(key), setItem(key, value) }`, sync or async) keeps the tombstones in the platform's own store
  (AsyncStorage, `expo-secure-store`, `chrome.storage`, Capacitor Preferences…). **Added**
  `SessionTombstones.ready: Promise<void>` (settles once the store has been read; immediate for `localStorage`).
- **Email delivery.** `InstanceSettings.emailDelivery: EmailDelivery` (new type: `{ available, passwordReset,
  passwordSignUp }`, read from `email_delivery` on `GET /v1/appearance`; all `true` on a server that does not send
  it). **New helpers:** `emailDeliveryFrom(body)` (an environment / appearance body or the object itself),
  `offeredFirstFactors(strategies, delivery)` (drops `email_code` / `email_link` while email can't be delivered),
  and the constants `EMAIL_DELIVERY_UNKNOWN`, `EMAIL_UNAVAILABLE_MESSAGE`, `EMAIL_FIRST_FACTORS`.
- **New: typed client environment.** `fetchClientEnvironment(client)` → `ClientEnvironment | null` and
  `clientEnvironmentFrom(body)` for `GET /v1/client/environment`: `{ firstFactors, strategies, emailDelivery,
  socialProviders }`, with the new `EnvironmentSocialProvider` type (`provider`, `native`, `mode`, `label`,
  `display_name`, `icon`, `allow_sign_in`, `allow_sign_up`, `client_id?`, `bot_username?`).

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
