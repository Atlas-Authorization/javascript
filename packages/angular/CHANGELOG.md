# @atlasauth/angular changelog

## 0.7.0
- **Referral attribution.** The prebuilt forms send the referral the visitor arrived with on sign-in and sign-up (through `@atlasauth/js` 0.13.0) when the instance has referrals on, and show the captcha for a referred sign-up when the instance requires it. New `AtlasOptions`: `referral?: false` and `referralConsent?`.

## 0.6.1
- **`<atlas-user-profile>` can verify an address.** Each unverified email address now has a **Verify** button: it emails a code (`POST /v1/client/me/email_addresses/{id}/prepare_verification`) and shows a field to enter it (`attempt_verification`), then reloads the user. This includes the sign-up address on an app that does not require email verification, which now reads unverified until it is proven. New catalog keys: `userProfile.verify`, `userProfile.verifyConfirm`, `userProfile.verifyCodePlaceholder`, `userProfile.verifySendFailed`, `userProfile.verifyCodeRejected`.

## 0.6.0
- **New `provideAtlas({ onSignOut })`, `AtlasService.signOut$` and `AtlasService.onSignOut(listener)`**: `onSignOut({ reason, sessionId })` fired once each time a signed-in user becomes signed out, on every
  path: `reason` is `user` (this tab), `other_tab`, `session_expired`, `revoked` (the session was ended elsewhere,
  detected on the next token refresh or re-check) or `unknown`. The same event is dispatched on `window` as
  `atlas:signout`. Use it to reset an embedded widget (a support chat, a docs reader session).
- **`getToken({ template })`**: a short-lived token from a named JWT template for the current session (for
  example `'chatly'`, a support-chat identity token, when the instance has a Chatly connection).
- **SDK version advisories.** Every Frontend API request carries `X-Atlas-SDK: @atlasauth/angular/<version>`. When the
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
- `AtlasFlowController` sends the code automatically when `planFirstFactor(firstFactors()).autoSend` is `email_code`. `<atlas-attempt-flow>` shows the "code sent to" line and turns "Email me a code" into "Resend code" once sent. New catalog keys: `signIn.codeSentTo`, `signIn.resendCode`.

## 0.5.0
Requires `@atlasauth/js` 0.9.0.
- **Server errors render in the app's language.** `<atlas-sign-in>` / `<atlas-sign-up>` (the attempt flow and
  the sign-up form) show the catalog string `error.<reason>` for an error's `reason`, falling back to the
  server's message, then `error.generic`.
- **`Accept-Language`.** `AtlasService`'s Frontend API client and `createFapiClient()` send the `locale` tag of
  the `localization` bundle, so the server localises `message` too.
- **Added 38 `error.<reason>` keys** to the built-in `EN_US` catalog (see `@atlasauth/localizations` 0.4.0).
- `AtlasService` gains `errorText(error)`, the `locale` getter (`string | undefined`) and the
  `errorLocalization` getter (`Catalog`).


## 0.4.0
- **Safer sign-out.** `AtlasService.signOut(options?: SignOutOptions)` now returns
  `Promise<SignOutResult>` (`{ revoked: boolean; activeSessionId?: string }`; was `Promise<void>` —
  existing `await signOut()` / `.then()` call sites keep working). It runs through the shared
  `SignOutGuard` from `@atlasauth/js`: the session id is recorded as a tombstone (localStorage, per
  Frontend API origin) before the revoke, the revoke is retried once, and a reload, token refresh, a
  sibling tab or a tab opened later never re-adopts a signed-out session — even when the revoke failed
  and the refresh cookie is still valid. A refused session's revoke is retried in the background and
  its tombstone dropped once the server confirms. With no cached token the cookie session is found via
  `GET /v1/client`, so the revoke is never skipped. A parked session the server promoted on revoke
  (`active_session_id`) is adopted. New option `signOut({ strict: true })` rejects with a
  `SignOutError` (`code: 'SIGN_OUT_REVOKE_FAILED'`, `sessionId`, `status`) after the local sign-out
  when the revoke was never confirmed. Another tab signing out of the same session now signs this tab
  out too. `ngOnDestroy()` also stops the cross-tab watch and cancels background re-tries.
- **Popup OAuth landing.** On startup (browser only), before the redirect-ticket exchange, the service
  calls `completeOAuthPopupLanding()`: on the landing page of a sign-in popup whose opener was severed
  by a Cross-Origin-Opener-Policy (`#atlas_popup_result=…`) it scrubs the fragment, relays the result
  to the opener and closes the window — without redeeming the ticket itself. When no opener takes it,
  it exchanges the ticket like a redirect result (or follows the payload's `continuationUrl`). After a
  successful ticket exchange inside the Atlas popup it calls `closeOAuthPopupAfterSignIn()`, which
  wakes the waiting opener and closes the popup (a no-op in an ordinary tab).
- **Email delivery in the prebuilt components** (`InstanceSettings.emailDelivery` from
  `GET /v1/appearance`; everything reads as available when the server omits it):
  - `<atlas-sign-up-form>` shows a `signUp.emailUnavailable` notice (`role="alert"`,
    `data-atlas-email-unavailable`) instead of the email + password form when
    `emailDelivery.passwordSignUp` is `false`.
  - `<atlas-sign-in>`'s first-factor step offers `offeredFirstFactors(strategies, emailDelivery)`:
    an "Email me a code" option when `email_code` is offered (hidden while the app cannot send email),
    and the password field unless an emailed code is the only offer.
- **Added to `AtlasFlowController`:** `firstFactors(): string[]`, `signUpEmailUnavailable(): boolean`,
  `passwordResetAvailable(): boolean`, `prepare(strategy: 'email_code'): Promise<void>` and
  `preparedFactor: WritableSignal<'email_code' | null>`.
- **Added to `AttemptFlowComponent`:** inputs `firstFactors: string[] | null` and
  `preparedFactor: string | null`, output `chooseFactor: EventEmitter<'email_code'>`; new element class
  `atlas-button-secondary` (`formButtonSecondary`).
- **Added catalog keys** (en-US): `signUp.emailUnavailable` ("This app can't send email right now. Try
  another sign-in method or contact the app owner." — `EMAIL_UNAVAILABLE_MESSAGE`), `signIn.useEmailCode`.
- **Added re-exports** from `@atlasauth/js`: `SignOutError` (class) and the types `SignOutResult`,
  `SignOutOptions`, `EmailDelivery`.
- Requires `@atlasauth/js` 0.8.0.

## 0.3.0
- **`<atlas-sign-up>` now creates accounts.** Its first step is a create-account form (the instance's
  configured sign-up fields, email, password and the legal-consent row) that posts
  `POST /v1/client/sign_ups`; the emailed-code step and the ticket exchange then run through the shared
  flow engine. Previously it rendered the sign-in identifier step and could not create an account.
- **Captcha renders automatically.** When the instance turns captcha on for a flow, `<atlas-sign-up>` and
  `<atlas-sign-in>` show the provider's widget (Turnstile, hCaptcha, reCAPTCHA v2/v3/Enterprise) in the
  configured mode (`visible`, `managed`, or `invisible` — run on submit), send its token as
  `captcha_token`, answer the sign-in `needs_captcha` step (continuing as soon as it is solved), and on
  `CAPTCHA_REQUIRED` / `CAPTCHA_FAILED` show a localized message and a fresh widget.
- **Added to `AtlasFlowController`:** `create(values, consent?)`, `loadSettings()`,
  `settings: WritableSignal<InstanceSettings | null>`, `captcha` / `signUpCaptcha: CaptchaController`,
  `captchaDrawn` / `signUpCaptchaDrawn: WritableSignal<boolean>`, and an optional 4th constructor
  argument `t: (key: string) => string` for the captcha messages (defaults to en-US). `destroy()` now
  also removes the captcha widgets.
- **Added** `SignUpFormComponent` (`<atlas-sign-up-form>`, output `submitSignUp: SignUpFormSubmit`),
  the `SignUpFormSubmit` type, the `AtlasCaptchaSlotDirective` (`[atlasCaptchaSlot]`), the
  `AttemptFlowComponent` input `captcha`, and type re-exports `InstanceSettings`, `PublicSignUpField`,
  `CaptchaController`, `CaptchaFlowKey`, `CaptchaWidgetMode`, `FlowCaptcha` from `@atlasauth/js`.
- **Added catalog keys** (en-US): `signUp.emailLabel`, `signUp.passwordLabel`, `signUp.optionalField`,
  `signUp.selectPlaceholder`, `signUp.consentAgree`, `signUp.consentNotice`, `signUp.terms`,
  `signUp.privacy`, `signUp.and`, `captcha.prompt`, `captcha.required`, `captcha.failed`.
- New element classes `atlas-captcha`, `atlas-consent`, `atlas-choices`, `atlas-choice`, `atlas-text`,
  `atlas-link`; the flow's inputs now carry `name` attributes.
- **`frontendApi` is validated at `provideAtlas()` / `AtlasModule.forRoot()`.** A missing (or non-string) or malformed value now throws an
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
- **Design system.** `atlasRoot` now applies the design configured in the Atlas dashboard
  automatically (fetched in the browser; opt out with `appearance.instanceDesign: false`).
- **New `appearance.preset` and `appearance.design`** — the same settings and semantics as
  `@atlasauth/react`: dashboard design < `preset` < `variables` < `design`. Invalid values are dropped
  with a development warning and never reach CSS. The `atlasRoot` host gets stable `data-atlas-*`
  attributes and the `--atlas-*` design variables; web fonts are linked from your Frontend API.
- `AtlasService` gains `appearanceRender()` and `loadInstanceDesign()`.
- `appearance.variables` / `baseTheme` are unchanged when no design is in play.
- New dependency: `@atlasauth/design`.

## 0.1.3
- **Metadata.** Added `repository` (monorepo + package directory), `homepage`, and `bugs` so the npm page links back to source.

## 0.1.2
- **Docs fix.** README now references the real published packages `@atlasauth/react` / `@atlasauth/js` (were shown as `@atlas/*`).

## 0.1.1
- First published release.
- **Setup.** `provideAtlas({ publishableKey, frontendApi, ... })` (or `AtlasModule`) configures the SDK; options are injectable through `ATLAS_OPTIONS`. Requires Angular 17 or later.
- **`AtlasService`.** Signals and observables for `status`, `user`, `session`, `claims`, `memberships`, `organization`, `isLoaded` and `isSignedIn`, plus `getToken()`, `getProviderToken()`, `has()`, `signOut()`, `setActiveOrganization()` and `reload()`.
- **Directives.** `*atlasSignedIn`, `*atlasSignedOut`, `*atlasLoading`, `*atlasLoaded` and `*atlasProtect` structural directives, and the `atlasRoot` theming host.
- **Components.** Sign-in, sign-up, user button, organization switcher, user profile and organization profile components, plus `AttemptFlowComponent` / `AtlasFlowController` for custom flows.
- `ATLAS_UI` bundles the directives and components for standalone imports.
- **Route guards.** `atlasGuard` and `atlasChildGuard` protect routes by sign-in state and the same role / permission conditions as `has()`; `AtlasGuardOptions` adds `redirectTo` and `preserveReturnUrl`.
- Appearance, localization and authorization helpers shared with the other Atlas UI SDKs.

