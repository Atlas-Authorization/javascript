# @atlasauth/vue changelog

## 0.15.0 — 2026-10-30

- `<SignIn>` offers "Sign in with a passkey" and passkey autofill on the identifier field when the instance enables passkeys.

## 0.14.0 — 2026-10-28

- `ManageCiba` component lists sign-in approvals (approve or deny) and manages the CIBA PIN; mounted in the user profile.

## 0.13.0 — 2026-10-26

### Changed

- New components and composables for the additional authentication factors; appearance and plugin options extended.

## 0.12.0 — 2026-10-24

- SSO organization claims, app adoption, validating dry runs, sealed secrets, consent API adapters; see the Atlas changelog.

## 0.11.0 — 2026-10-24

- Integrator platform release: see the Atlas changelog for 2026-10-24.

## 0.10.0 — 2026-10-24

### Added

- **Policy acceptance** in `<SignUp>` and `<SignIn>` (consent block with in-page viewer, clickwrap line, unskippable scroll dialog, the `needs_policy_acceptance` step), plus `<PolicyGate/>`, `<PolicyConsent/>`, `<PolicyClickwrap/>`, `<PolicyAcceptStep/>`, `usePolicies()`. New `policy.*` strings.

## 0.9.0 — 2026-10-23

### Added

- `<OrganizationAuditLog/>` and `useOrganizationAuditLog()`: the active organization's audit trail for its admins, paged, with labels as props. Renders nothing for a member who may not read it. Appearance `elements` gain `list` and `listItem`.
- **Recovery codes after enrolment.** Setting up a second factor at sign-in now shows the account's one-time recovery codes before the sign-in finishes, as the hosted page does: copy them, download them as a .txt file, then "I've saved my codes" continues. Before, the sign-in completed straight away and the codes were never shown. The codes are kept in memory only, never on the attempt or in storage. New strings (`mfa.recoveryCodesTitle`, `mfa.recoveryCodesHelp`, `mfa.recoveryCodesCopy`, `mfa.recoveryCodesCopied`, `mfa.recoveryCodesDownload`, `mfa.recoveryCodesSaved`) are in the catalog and in every `@atlasauth/localizations` bundle.
- **MFA enrolment at sign-in works end to end.** When the app requires a second factor and the account has none, `<SignIn>` now fetches the authenticator setup and shows its QR code and the setup key, then asks for the code (one or two, as the app requires). Before, the step asked for codes without ever showing the setup.
- **Text-message enrolment** where the app offers texted codes and can send them: the user picks "Use text messages", enters a phone number, and confirms with the texted code. When both methods are offered the user chooses, and can switch.
- **"Text me a code instead"** at the second-factor step where the app offers texted codes, beside the existing "Email me a code instead".
- The new strings are in the catalog (`mfa.enrollChoose`, `mfa.enrollTotpOption`, `mfa.enrollSmsOption`, `mfa.enrollScan`, `mfa.enrollQrAlt`, `mfa.enrollSetupKey`, `mfa.enrollPreparing`, `mfa.phoneLabel`, `mfa.phoneHint`, `mfa.sendCode`, `mfa.codeTextedTo`, `mfa.smsCodeOption`) and in every `@atlasauth/localizations` bundle.
- "Email me a code instead" at the second factor showed its catalog key (`signIn.emailCodeOption`) unless a language bundle was passed; the English string is now in the default catalog.
- Texted codes are offered only where the server says the app can text (`account.mfa` on `/v1/appearance`). A server that does not say gets the authenticator app only.

### Changed

- Built on `@atlasauth/js` 0.16.0.

## 0.8.0

### Changed

- `@atlasauth/js` 0.15.0: referral capture for any referral program and any consent manager (pass a custom program's reader page-wide with `configureReferralCapture({ referralSource })`).

### Fixed

- Development instances: sign-in from `localhost` keeps working where the browser blocks the instance's cookie as third-party (Chrome, Safari). On a `pk_test_` key the SDK keeps the session's refresh token in `localStorage` and sends it as `x-refresh-token`; production keys never do.
- After a sign-in completes, the panel says "You're signed in" only once this browser holds the session, and says plainly when the browser didn't keep it, instead of "you are signed in where you started". That message is now shown only for a sign-in completed on another device.
- `<SignIn>` shows "No account? Sign up" on every step (`signUpUrl`; default the hosted sign-up page with the visitor's referral, `null` hides it), so a newcomer on a password-only instance always has a way to create an account.

## 0.7.0
- **Referral attribution.** The prebuilt forms send the referral the visitor arrived with on sign-in and sign-up (through `@atlasauth/js` 0.13.0) when the instance has referrals on, and show the captcha for a referred sign-up when the instance requires it. New `createAtlas` options: `referral?: false` and `referralConsent?`.

## 0.6.1
- **`<UserProfile>` can verify an address.** Each unverified email address now has a **Verify** button: it emails a code (`POST /v1/client/me/email_addresses/{id}/prepare_verification`) and shows a field to enter it (`attempt_verification`), then reloads the user. This includes the sign-up address on an app that does not require email verification, which now reads unverified until it is proven. New catalog keys: `userProfile.verify`, `userProfile.verifyConfirm`, `userProfile.verifyCodePlaceholder`, `userProfile.verifySendFailed`, `userProfile.verifyCodeRejected`.

## 0.6.0
- **New `createAtlas({ onSignOut })` and `useAtlas().onSignOut(listener)`**: `onSignOut({ reason, sessionId })` fired once each time a signed-in user becomes signed out, on every
  path: `reason` is `user` (this tab), `other_tab`, `session_expired`, `revoked` (the session was ended elsewhere,
  detected on the next token refresh or re-check) or `unknown`. The same event is dispatched on `window` as
  `atlas:signout`. Use it to reset an embedded widget (a support chat, a docs reader session).
- **`getToken({ template })`**: a short-lived token from a named JWT template for the current session (for
  example `'chatly'`, a support-chat identity token, when the instance has a Chatly connection).
- **SDK version advisories.** Every Frontend API request carries `X-Atlas-SDK: @atlasauth/vue/<version>`. When the
  response carries `Atlas-SDK-Advisory: upgrade; min=<version>; reason=<code>` (a version with a known bug), the SDK
  logs one console warning per advisory per page load. The Frontend API must allow the header in CORS, which Atlas
  does; a reverse proxy that forwards a fixed `Access-Control-Allow-Headers` list must add `x-atlas-sdk`.
- Requires `@atlasauth/js` 0.12.0.
- The prebuilt forms draw the **Atlas captcha** (provider `atlas`, no keys needed) through `@atlasauth/js` 0.12.0,
  with its words from the form's catalog. New catalog keys: `captcha.checking`, `captcha.verified`,
  `captcha.puzzlePrompt`, `captcha.puzzleConfirm`, `captcha.puzzleTile`, `captcha.puzzleAlternative`.

## 0.5.1
- **Fixed: email-code sign-in on instances without password sign-in.** After the email step the sign-in form now
  sends the code itself (`prepare_first_factor`), shows "We sent a code to …" with the code field and a
  "Resend code" action, and completes with `attempt_first_factor { strategy: "email_code", code }`. A password field
  is drawn only when the server offers `password`; when it is offered, password stays the default and the emailed
  code is one click away. If the automatic send is refused (a 429, or the app can't send email), the step shows the
  server's error and a button to try again.
- New catalog keys: `signIn.codeSentTo`, `signIn.linkSentTo`, `signIn.sending`, `signIn.resendCode`, `signIn.resendLink`, `signIn.passwordOption` ("Use your password instead", on the code step when password is also offered).

## 0.5.0
Requires `@atlasauth/js` 0.9.0.
- **Server errors render in the app's language.** `<SignIn>` / `<SignUp>` show the catalog string
  `error.<reason>` for an error's `reason` (placeholders filled from its `meta`), falling back to the server's
  message, then `error.generic`. With `createAtlas({ localization: esES })` a refused password reads
  "Esas credenciales son incorrectas." instead of the server's English sentence.
- **`Accept-Language`.** The flows' Frontend API requests carry the `locale` tag of the `localization` bundle, so
  the server localises `message` too — the fallback for a reason the bundle has no string for.
- **Added 38 `error.<reason>` keys** to the built-in `EN_US` catalog (see `@atlasauth/localizations` 0.4.0).
- `AtlasClient` (and `useAtlas()`) gains `errorCatalog?: Catalog` (the `localization` bundle alone, `EN_US` when
  none) and `locale?: string`.


## 0.4.0
- **Safer sign-out.** `signOut(options?)` now resolves `SignOutResult` (`{ revoked: boolean; activeSessionId?: string }`)
  instead of `void` (on `AtlasClient.signOut` and `useAuth().signOut`; existing `await signOut()` call sites keep
  working). The session is remembered before it is revoked (a tombstone in `localStorage`, per Frontend API origin)
  and the revoke is retried once; when the server still can't confirm it, the local sign-out happens anyway and
  `revoked` is `false`. A reload, a token refresh or a tab opened later never re-adopts that session while the
  browser's cookie still carries it, and the revoke is re-tried in the background (the tombstone is dropped once
  it lands). A refresh in flight during sign-out can no longer put the token back. With no session in memory the
  revoke still runs (the session is read from `GET /v1/client`). Built on `SignOutGuard` from `@atlasauth/js`.
- **`signOut({ strict: true })`** rejects with a `SignOutError` (`code: 'SIGN_OUT_REVOKE_FAILED'`, `sessionId`,
  `status`) when the revoke was not confirmed — after the local sign-out.
- **Promoted sessions are adopted.** When the server promotes another account signed in on this browser
  (`active_session_id` on the revoke), `signOut()` adopts it and resolves `activeSessionId`.
- **Sibling tabs.** A tab whose session another tab signed out of (the tombstone reaches it through `localStorage`)
  drops its token and re-checks, so it signs out too.
- **Popup OAuth landing.** On startup the plugin completes a popup OAuth landing first
  (`completeOAuthPopupLanding()` from `@atlasauth/js`): the result is relayed to the opener and the window closes,
  or, when no opener takes it, the ticket is exchanged here (or the page continues to the step's
  `continuationUrl`). After a ticket exchange inside the Atlas popup the popup hands back to the opener and
  closes (`closeOAuthPopupAfterSignIn()`); an ordinary tab never closes.
- **Email delivery in the prebuilt components** (from `settings.emailDelivery`, all `true` when the server omits it):
  - `<SignUp>` shows a "can't send email" notice instead of the email + password form when
    `emailDelivery.passwordSignUp` is `false` (new catalog key `signUp.emailUnavailable`, default
    `"This app can't send email right now. Try another sign-in method or contact the app owner."`).
  - `<SignIn>`'s first-factor step now offers "Email me a code" / "Email me a sign-in link" for the server's
    `email_code` / `email_link` strategies, filtered with `offeredFirstFactors()` so they are hidden while the app
    can't deliver email (new catalog keys `signIn.useEmailCode`, `signIn.useEmailLink`; buttons carry
    `data-strategy`).
- **Added to `FlowController`**: `prepare(strategy: 'email_code' | 'email_link'): Promise<boolean>`
  (`prepare_first_factor`).
- **Added exports** `SignOutError` and `type SignOutResult` (re-exported from `@atlasauth/js`).

## 0.3.0
- **`<SignUp>` now creates accounts.** Its first step is a create-account form (the instance's
  configured sign-up fields, email, password and the legal-consent row) that posts
  `POST /v1/client/sign_ups`; the emailed-code step and the ticket exchange then run through the shared
  flow. Previously `<SignUp>` rendered the sign-in identifier step and could not create an account.
- **Captcha renders automatically.** When the instance turns captcha on for a flow, `<SignUp>` and
  `<SignIn>` show the provider's widget (Turnstile, hCaptcha, reCAPTCHA v2/v3/Enterprise) in the
  configured mode (`visible`, `managed`, or `invisible` — run on submit), send its token as
  `captcha_token`, answer the sign-in `needs_captcha` step (continuing as soon as it is solved), and on
  `CAPTCHA_REQUIRED` / `CAPTCHA_FAILED` show a localized message and a fresh widget.
- **Added to `FlowController`** (returned by `useSignIn()` / `useSignUp()`): `create(values, consent?)`,
  `settings: ShallowRef<InstanceSettings | null>`, `captcha: CaptchaController`,
  `signUpCaptcha: CaptchaController`.
- **Added type re-exports** `InstanceSettings`, `PublicSignUpField`, `CaptchaController`,
  `CaptchaFlowKey`, `CaptchaWidgetMode`, `FlowCaptcha` from `@atlasauth/js`.
- **Added catalog keys** (en-US): `signUp.emailLabel`, `signUp.passwordLabel`, `signUp.optionalField`,
  `signUp.selectPlaceholder`, `signUp.consentAgree`, `signUp.consentNotice`, `signUp.terms`,
  `signUp.privacy`, `signUp.and`, `captcha.prompt`, `captcha.required`, `captcha.failed`.
- New element classes `atlas-captcha`, `atlas-consent`, `atlas-choices`, `atlas-choice`, `atlas-text`,
  `atlas-link`; the flow's inputs now carry `name` attributes.
- **`frontendApi` is validated at `createAtlas()`.** A missing (or non-string) or malformed value now throws an
  `AtlasConfigError` (from `@atlasauth/js`; `code: 'FRONTEND_API_REQUIRED'` or `'FRONTEND_API_INVALID'`)
  instead of silently sending requests to relative URLs on the app's own origin. Accepted: an absolute
  `https:` URL (`http:` only for localhost / local development hosts), or `"same-origin"` / a root-relative path such as `"/atlas"` for a reverse proxy.
- **Deprecated:** `frontendApi: ""` (the original same-origin spelling) still works as same-origin, with a
  one-time console warning; use `"same-origin"` instead.

## 0.2.1
- **Front-channel logout on sign-out.** `signOut()` now loads the `frontchannel_logout_urls` the
  Frontend API returns (apps signed in with "Sign in with Atlas" through this session) in hidden,
  sandboxed iframes, so those apps clear their sessions in this browser too. It waits until the frames
  load or 5 s pass, never fails the sign-out, only loads `https:` URLs (and `http://localhost`), and
  does nothing during SSR. Pass `signOut({ frontchannel: false })` to skip it.

## 0.2.0
- **Design system.** `createAtlas` now applies the design configured in the Atlas dashboard
  automatically (fetched from the Frontend API; opt out with `appearance.instanceDesign: false`).
- **New `appearance.preset` and `appearance.design`** — the same settings and semantics as
  `@atlasauth/react`: dashboard design < `preset` < `variables` < `design`. Invalid values are dropped
  with a development warning and never reach CSS. The document root gets stable `data-atlas-*`
  attributes and the `--atlas-*` design variables; web fonts are linked from your Frontend API.
- `appearance.variables` / `baseTheme` are unchanged when no design is in play.
- New dependency: `@atlasauth/design`.

## 0.1.5
- **`useAuth()` now also returns `status` and `session`.** `status` is a ref holding the three-state `AuthStatus` (`loading` | `signed_in` | `signed_out`) and `session` a ref holding the active session or `null`; both come from the same source as `isLoaded` / `isSignedIn`.
- README uses the published `@atlasauth/*` package names.

## 0.1.4
- **Docs fix.** Frontend API host example uses a single-label host (`your-instance-fapi.atlasauth.net`).

## 0.1.3
- **Metadata.** Added `repository` (monorepo + package directory), `homepage`, and `bugs` so the npm page links back to source.

## 0.1.2
- **Docs fix.** README Frontend API example now uses `https://your-instance.fapi.atlasauth.net` (was `.atlas.dev`).

## 0.1.1
- First published release.
- **Plugin.** `app.use(createAtlas({ publishableKey, frontendApi, ... }))` installs Atlas app-wide.
- **Composables.** `useAtlas()`, `useUser()`, `useSession()`, `useAuth()`, `useOrganization()`, and the headless flow composables `useSignIn()`, `useSignUp()` and `useFlow()`.
- **Components.** `SignedIn`, `SignedOut`, `AtlasLoading`, `AtlasLoaded`, `Protect`, `SignIn`, `SignUp`, `UserButton`, `OrganizationSwitcher`, `UserProfile` and `OrganizationProfile`.
- Appearance, localization and authorization helpers shared with the other Atlas UI SDKs.

