# @atlasauth/vue changelog

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

