# @atlasauth/vue changelog

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

