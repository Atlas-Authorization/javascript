# @atlasauth/react changelog

## 0.24.0 — 2026-10-30

### Added

- `<ApiKeys/>` renders a resource by read/write scope grid (`ScopePicker`). Implied scopes show as checked and locked, and only the scopes you choose are sent. `useApiKeys()` exposes `scopeImplications`.
- `<SignIn/>` offers "Sign in with a passkey" and passkey autofill on the identifier field (`autocomplete="username webauthn"`) when the instance enables passkeys. `passkeyPrf` and `onPasskeyExtensionResults` now apply to passkey sign-in too.

## 0.23.1 — 2026-10-28

- The SDK reports its own version correctly again (the previous release still identified itself as the release before).

## 0.23.0 — 2026-10-28

- `<ManageCiba/>` in the account panel
- Sharing and approval widgets: `ShareDialog`, `RoleMatrix`, `AccessRequestButton`, `PendingApprovals`
- `<IntegrationGallery/>`
- `keepSessionAlive` on `AtlasProvider` refreshes the token when a tab wakes

## 0.22.0 — 2026-10-27

### Added

- `<AccessRequests/>` and `useAccess()`: browse the access catalog, request access, approve or decline requests, and complete access reviews for the signed-in user.

### Changed

- `<ConnectedAccounts/>` and `useConnectedAccounts().authorize` connect the connection itself (its tokens are stored on the connection, no external account and no sign-in method) instead of linking an external account; an organization admin gets Connect as well as Share my account. Statuses `revoked` and `error` have labels.

## 0.21.0 — 2026-10-26

### Added

- `<ManageMfa/>` offers counter-based tokens, YubiKeys and Duo when the application has them on (`<ManageMoreFactors/>`), and `<ManageSecurityQuestions/>` (also inside `<UserProfile/>`) sets recovery questions. `<SignIn/>` shows "Use Duo instead" at the second-factor step and polls until Duo approves. The authenticator field no longer says "6-digit".

## 0.20.0 — 2026-10-25

### Added

- `@atlasauth/react/compat`: `useOktaAuthCompat` / `OktaAuthCompat` (okta-react, okta-auth-js), `useKindeBrowserClientCompat` / `useKindeAuthCompat` (Kinde), and `useDescopeCompat`, `useDescopeSessionCompat`, `useDescopeUserCompat`, `getDescopeSessionTokenCompat` (Descope), keeping each SDK's result shapes for apps migrated with `atlas migrate code`.

## 0.19.0 — 2026-10-24

- Per-call integration audiences (`getToken({ for, cbid })`), partner platforms, operator tokens for partner products.

## 0.18.0 — 2026-10-24

- SSO organization claims, app adoption, validating dry runs, sealed secrets, consent API adapters; see the Atlas changelog.

## 0.17.0 — 2026-10-24

### Added

- `SignInWithAtlasButton` dispatches the `atlasid:ready` / `atlasid:signin` / `atlasid:error` / `atlasid:onetap` DOM events and sets `data-atlasid-state`; new `listenAtlasIdEvents()` and `useAtlasIdEvents()` subscribe to them (on this button or a script-upgraded `[data-atlas-signin]` element).
- The button's label and `aria-label` follow `locale` (default the page's `<html lang>`), it shows a visible `:focus-visible` ring, honours `prefers-reduced-motion`, and reads the host page's `--atlas-host-*` variables (`--atlas-host-accent`, `--atlas-host-accent-ink`, `--atlas-host-surface`, `--atlas-host-ink`, `--atlas-host-line`, `--atlas-host-focus-ring`). New props `locale`, `ariaLabel`, `onReady`, `oneTap`.
- One Tap: `oneTapWithAtlas()` (FedCM) and the button's `oneTap` prop.
- The components' stylesheet is a constructable stylesheet (no `style-src 'unsafe-inline'` needed), or a `<style>` carrying the page's CSP nonce; the host page's `--atlas-host-*` variables restyle them where set.

## 0.16.0 — 2026-10-24

### Added

- **Policy acceptance.** `<SignUp>` shows the instance's policies instead of the single terms checkbox: a combined (or per-policy) checkbox whose names open the document in an in-page viewer, a clickwrap line under the button, and an unskippable scroll-to-accept dialog (focus trapped, no close button, Escape ignored; Accept turns on once the end of the text is seen or when it fits; Decline cancels). The submit is blocked until the required policies are accepted, `policy_acceptances` is sent, and a 422 `POLICY_ACCEPTANCE_REQUIRED` reloads the policies and asks again.
- `<SignIn>` handles `needs_policy_acceptance`: the dialog (with what changed on a re-acceptance) or the checkboxes, then it continues to the second factor or the session. Declining cancels the attempt and says why.
- New: `<PolicyGate/>` (in-app re-acceptance banner), `usePolicies()`, `<PolicyConsent/>`, `<PolicyClickwrap/>`, `<PolicyModal/>`, `<PolicyAcceptStep/>`. `FlowProps.policyConsent` picks `combined` or `separate` checkboxes. New `policy.*` strings in the catalog and in every `@atlasauth/localizations` bundle.

## 0.15.0 — 2026-10-24

### Added

- `@atlasauth/react/compat`: drop-in compat helpers for apps migrated from Auth.js, Auth0, Supabase Auth and Better Auth (what `atlas migrate code` rewrites onto): `useNextAuthSession`, `nextAuthSignIn`, `nextAuthSignOut`, `getNextAuthSession`, `useAuth0Compat`, `useAuth0UserCompat`, `withAuthenticationRequiredCompat`, `getSupabaseUserCompat`, `getSupabaseSessionCompat`, `supabaseSignOutCompat`, `supabaseSignInWithOAuthCompat`, `onSupabaseAuthStateChangeCompat`, `useSupabaseUserCompat`, `useSupabaseSessionCompat`, `createBetterAuthCompatClient`, plus `signInRedirect` and the pure projections. The imperative ones act on the mounted `<AtlasProvider>` (`getActiveAtlas()`).
- `<DeviceAuthorization/>` and `useDeviceAuthorization()`: approve a TV / console / CLI sign-in (RFC 8628) on your own page — enter or scan the code, see the app and the access it asks for, Allow or Deny, with the "Confirm it's you" prompt when the app requires a recent re-authentication. Reads `?user_code=` from the page URL. New strings (`deviceAuth.*`) are in the catalog and in every `@atlasauth/localizations` bundle.
- `signOut()` follows SAML Single Logout (`saml_logout_url`) as well as upstream (RP-initiated) logout, with the same options and precedence as `@atlasauth/js` (`samlLogout`, `samlLogoutRedirectUrl`, `SignOutResult.samlLogoutUrl`; the upstream URL wins when both are returned).
- WebAuthn PRF: `passkeyPrf` / `onPasskeyExtensionResults` on `<SignIn>` / `<SignUp>`, and `prf` / `onExtensionResults` on `<ManagePasskeys>` (`ManagePasskeysProps`) when a passkey is added. The outputs never reach Atlas.
- Billing: `useBilling()` returns `subscriptions` and `addons` (live add-on subscriptions), `changePlan` / `cancel` / `restore` take `subscriptionId`, and `check(feature, { required })` asks whether the subject may use a feature (`AtlasFeatureCheck`). Plans and subscriptions carry `provider`, `kind` and the trial / annual fields.
- `custom_data` on the session resource (read-only on the client).
- `<SignIn>` / `<SignUp>` captchas support CaptchaFox and Vercel BotID.

## 0.14.0 — 2026-10-23

### Added

- `<OrganizationAuditLog/>` and `useOrganizationAuditLog()`: the active organization's audit trail for its admins.
- **Recovery codes after enrolment.** Setting up a second factor at sign-in now shows the account's one-time recovery codes before the sign-in finishes, as the hosted page does: copy them, download them as a .txt file, then "I've saved my codes" continues. Before, the sign-in completed straight away and the codes were never shown. The codes are kept in memory only, never on the attempt or in storage. New strings (`mfa.recoveryCodesTitle`, `mfa.recoveryCodesHelp`, `mfa.recoveryCodesCopy`, `mfa.recoveryCodesCopied`, `mfa.recoveryCodesDownload`, `mfa.recoveryCodesSaved`) are in the catalog and in every `@atlasauth/localizations` bundle.
- **MFA enrolment at sign-in works end to end.** When the app requires a second factor and the account has none, `<SignIn>` now fetches the authenticator setup and shows its QR code and the setup key, then asks for the code (one or two, as the app requires). Before, the step asked for codes without ever showing the setup.
- **Text-message enrolment** where the app offers texted codes and can send them: the user picks "Use text messages", enters a phone number, and confirms with the texted code. When both methods are offered the user chooses, and can switch.
- **"Text me a code instead"** at the second-factor step where the app offers texted codes, beside the existing "Email me a code instead".
- The new strings are in the catalog (`mfa.enrollChoose`, `mfa.enrollTotpOption`, `mfa.enrollSmsOption`, `mfa.enrollScan`, `mfa.enrollQrAlt`, `mfa.enrollSetupKey`, `mfa.enrollPreparing`, `mfa.phoneLabel`, `mfa.phoneHint`, `mfa.sendCode`, `mfa.codeTextedTo`, `mfa.smsCodeOption`) and in every `@atlasauth/localizations` bundle.
- Texted codes are offered only where the server says the app can text (`account.mfa` on `/v1/appearance`). A server that does not say gets the authenticator app only.

### Changed

- Built on `@atlasauth/js` 0.16.0.

## 0.13.0

### Added

- `@atlasauth/js` 0.15.0: referral capture for any referral program and any consent manager.
- `<SignInWithAtlas referralSource={…}>`: your own reader for another referral program.

### Fixed

- Development instances: sign-in from `localhost` keeps working where the browser blocks the instance's cookie as third-party (Chrome, Safari). On a `pk_test_` key the SDK keeps the session's refresh token in `localStorage` and sends it as `x-refresh-token`; production keys never do.
- After a sign-in completes, the panel says "You're signed in" only once this browser holds the session, and says plainly when the browser didn't keep it, instead of "you are signed in where you started". That message is now shown only for a sign-in completed on another device.
- `<SignIn>` shows "No account? Sign up" on every step (`signUpUrl`; default the hosted sign-up page with the visitor's referral, `null` hides it), so a newcomer on a password-only instance always has a way to create an account.

## 0.12.0
- **Sign in with Atlas carries the referral.** `buildAtlasAuthorizeUrl`, `signInWithAtlasPopup` and `<SignInWithAtlasButton>` (including `loginUri`) add the visitor's referral as `ref_*` query parameters (from `window.aff`, else `ref` / `via` / `aff` on the page URL), through `@atlasauth/js` 0.14.0. New `AtlasIdOptions` fields `referral?: false | 'auto'` (default `'auto'`) and `referralConsent?` (ids only with consent).

## 0.11.0
- **Referral attribution.** `<SignIn>` / `<SignUp>` send the referral the visitor arrived with on sign-in and sign-up (through `@atlasauth/js` 0.13.0) when the instance has referrals on. New props on `<SignIn>`, `<SignUp>` and `<AtlasProvider>`: `referral?: false` (opt out) and `referralConsent?: 'granted' | 'denied' | boolean | () => …` (the app's own consent for the referral cookie, used when Cookie Munch is not on the page). When the instance requires it (`challenge_referred_signups: 'always'`), a referred sign-up or sign-in shows the captcha even when it is otherwise off.

## 0.10.1
- **`<ProfileCard>` can verify an address.** Each unverified email address now has a **Verify** button: it emails a code (`POST /v1/client/me/email_addresses/{id}/prepare_verification`) and shows a field to enter it (`attempt_verification`). This includes the sign-up address on an app that does not require email verification, which now reads unverified until it is proven.

## 0.10.0
- **New `<AtlasProvider onSignOut>`, `useSignOutListener(listener)` and `useAtlas().addSignOutListener()`: `onSignOut({ reason, sessionId })`** fired once each time a signed-in user becomes signed out, on every
  path: `reason` is `user` (this tab), `other_tab`, `session_expired`, `revoked` (the session was ended elsewhere,
  detected on the next token refresh or re-check) or `unknown`. The same event is dispatched on `window` as
  `atlas:signout`. Use it to reset an embedded widget (a support chat, a docs reader session).
- **`getToken({ template })`**: a short-lived token from a named JWT template for the current session (for
  example `'chatly'`, a support-chat identity token, when the instance has a Chatly connection).
- **SDK version advisories.** Every Frontend API request carries `X-Atlas-SDK: @atlasauth/react/<version>`. When the
  response carries `Atlas-SDK-Advisory: upgrade; min=<version>; reason=<code>` (a version with a known bug), the SDK
  logs one console warning per advisory per page load. The Frontend API must allow the header in CORS, which Atlas
  does; a reverse proxy that forwards a fixed `Access-Control-Allow-Headers` list must add `x-atlas-sdk`.
- New exports: `useSignOutListener`, `ATLAS_REACT_SDK`, `ATLAS_REACT_VERSION`, `SIGN_OUT_EVENT`, `onAtlasSignOut`,
  `SignOutEvent`, `SignOutReason`. Requires `@atlasauth/js` 0.12.0.
- `<SignIn>` and `<SignUp>` draw the **Atlas captcha** (provider `atlas`, no keys needed) when the instance turns it on,
  through `@atlasauth/js` 0.12.0. Invisible for most visitors; a shape-matching step only for risky traffic.
- `useCaptcha().getToken()` draws a fresh widget when the solved one is about to expire (`CaptchaWidgetHandle.stale`).
- The Atlas captcha's words follow the provider's localization (new catalog keys `captcha.checking`,
  `captcha.verified`, `captcha.puzzlePrompt`, `captcha.puzzleConfirm`, `captcha.puzzleTile`, `captcha.puzzleAlternative`).
  `useCaptcha` takes a new `atlasLabels` option.

## 0.9.1
- Every component and hook module is marked `'use client'`, so `<AtlasProvider>`, `<SignIn>`, `<UserButton>` and the
  rest can be rendered straight from a Next.js App Router server layout or page. You no longer need your own
  `'use client'` wrapper unless you pass the provider a function (`onSignedIn`, `fetchImpl`). The package entry and
  `fetchAtlasInitialState()` stay unmarked, so the latter is still callable on the server.

## 0.9.0
- **New `<AtlasProvider initialState>`**: the instance's public sign-in data, fetched on the server with
  `fetchAtlasInitialState()` (re-exported here) or `getAtlasInitialState()` from `@atlasauth/nextjs/server`. With it,
  `<SignIn>` / `<SignUp>` render in the server HTML with the dashboard design, the sign-in settings and the social
  buttons (including the Google button), and the browser doesn't request `/v1/appearance` or
  `/v1/client/environment`. Without it nothing changes.
- **Fewer requests without it too**: the client environment is fetched once per provider and shared. Before, the
  social buttons and the Google button each requested it. The "Sign in with Atlas" button reads the provider's
  appearance instead of requesting `/v1/appearance` a second time.
- The provider renders `<link rel="preconnect">` to the Frontend API and, when the instance uses native Google
  sign-in, `<link rel="preload" as="script">` for Google's sign-in script.
- `useAtlas()` adds `environment` (the raw `/v1/client/environment` body or null), `appearanceData` (the raw
  `/v1/appearance` body or null) and `loadEnvironment()`.
- New exports: `fetchAtlasInitialState`, `AtlasInitialState`, `FetchInitialStateOptions`.

## 0.8.1
- **Fixed: `<SignIn>` can complete an email-code sign-in.** On an instance without password sign-in, the
  first-factor step showed a password field and posted `strategy: "password"`, which the server refused
  (`STRATEGY_DISABLED`); no code was ever sent. It now calls `prepare_first_factor` itself, shows "We sent a code to …"
  with a code field (`autocomplete="one-time-code"`), and completes with `attempt_first_factor { strategy: "email_code", code }`.
- **Email link**: when `email_link` is the only factor, the link is sent and the tab polls with `poll_secret` until
  it is opened, then signs in.
- **Password and email code both on**: password stays the default, with "Email me a code instead" (and "Email me a
  sign-in link instead" when offered) under it; the code step has "Use your password instead".
- **"Resend code" / "Resend link"** on the sent step. A 429 shows its message and the button counts down the
  server's `retry_after` ("Resend in 30s").
- A password field is never drawn unless the server offers `password`.
- New `AttemptFlow` props: `prepared`, `onPrepare(strategy)`, `onUsePassword()`. `useFlow()` also returns
  `prepare(strategy)` and `usePassword()`.
- All new strings come from the catalog (`signIn.codeSentTo`, `signIn.resendCode`, …), translated in every
  `@atlasauth/localizations` bundle.
- Base stylesheet: link-style buttons for these actions (`.atlas-alternatives`, `button.atlas-link`).

## 0.8.0
- **Server errors render in the app's language.** `<SignIn>`, `<SignUp>`, the flow panels, `<ApiKeys/>` (and
  `useApiKeys().error`), `<Waitlist>`, `<ManageMfa>`, `<ManagePasskeys>`, `<EmbeddedCheckout>` and the
  Sign in with Atlas SSO button show the catalog string `error.<reason>` for an error's `reason`, falling back to
  the server's message, then `error.generic`. With `<AtlasProvider locale="es">` a refused password now reads
  "Esas credenciales son incorrectas." instead of the server's English sentence.
- **`Accept-Language`.** Every Frontend API request the components make carries the provider's `locale` (or the
  `locale` tag of a `localization` bundle), so the server localises `message` too — the fallback for a reason the
  catalog has no string for.
- Reason strings are looked up in the language layer only (the `locale` bundle plus `localization`), never in the
  English defaults beneath it, so an unsupported `locale` shows the server's localised message rather than English.
- **Added 38 `error.<reason>` keys** to the built-in `EN_US` catalog (see `@atlasauth/localizations` 0.4.0).
- `useAtlas()` gains `locale?: string` and `errorCatalog?: Catalog`.


## 0.7.0
- **Added `tombstoneStore?: TombstoneStore` to `AtlasProviderProps`.** Where to keep the ids of sessions
  this app signed out of on a runtime without `localStorage` (React Native / Expo, Electron's main
  process, an extension service worker): a `{ getItem(key), setItem(key, value) }` adapter (sync or
  async) over the platform's persistent store. Without it tombstones stay in `localStorage` per Frontend
  API as before. Every boot / re-check now waits for the store to be read (immediate for
  `localStorage`), so a restarted app never re-adopts a session whose revoke failed. `TombstoneStore`
  is re-exported from the package entry.
- **`<SignUp>` shows a "can't send email" state** instead of the email + password form when
  `instanceSettings.emailDelivery.passwordSignUp === false` (the app can't deliver the verification
  email). New catalog key `signUp.emailUnavailable`, default "This app can't send email right now. Try
  another sign-in method or contact the app owner." (Language bundles fall back to English until
  `@atlasauth/localizations` ships it.)
- **`<SignIn>`'s first-factor step offers `offeredFirstFactors(step.strategies, emailDelivery)`**: email
  code / link are not offered while `emailDelivery.available === false`; when nothing else is left the
  step shows the `signUp.emailUnavailable` notice instead of a password field. The prebuilt components
  have no "Forgot password?" control, so `emailDelivery.passwordReset` needs no handling here.

## 0.6.0
- **Popup sign-in works when your page sends `Cross-Origin-Opener-Policy: same-origin`.** `<AtlasProvider>`
  now finishes a popup that was severed from its opener: when the popup lands back on your page with
  `#atlas_popup_result=…`, the provider relays the result to the opener (which completes the sign-in) and
  closes the popup; if no opener takes it (its tab was closed), it completes the sign-in in that window like a
  redirect. The fragment is removed from the URL first. Social buttons in popup mode keep waiting (up to
  5 minutes) for a severed popup instead of treating it as cancelled.
- **A sign-in completed inside the Atlas popup closes the popup** once it has told the waiting opener.
- **Changed `startOauth({ mode: 'popup' })`** (from `useSignIn()`): accepts `signal?: AbortSignal` and
  re-boots signed-in when the popup finished the sign-in itself (`sessionDetected`).
- **A tab opened after a failed sign-out stays signed out.** Sign-out tombstones are now kept in
  `localStorage` per Frontend API (shared by all tabs, 30 days, at most 20) instead of per-tab
  `sessionStorage`. A later successful background revoke clears the tombstone, and a new sign-in (new
  session id) is adopted normally. A tombstone another tab adds for the current session drops this tab's
  token.
- **The default focus ring has at least 3:1 contrast against `colorBackground`.** `colorFocusRing` used to
  default to `colorPrimary` unchecked (mint `#22f79a` on white is ~1.4:1). It is now the primary when that
  clears 3:1, otherwise the primary's hue darkened (light backgrounds) or lightened (dark backgrounds) until
  it does. An explicit `colorFocusRing` still wins. With a design active, the focus outline uses the design's
  new `--atlas-focus-outline-color` (same rule).

## 0.5.0
- **`<SignUp>` now creates accounts.** Its first step is a create-account form (the instance's
  configured sign-up fields, email, password and the legal-consent row) that posts
  `POST /v1/client/sign_ups`; the emailed-code step and completion then run through the shared flow.
  Previously `<SignUp>` rendered the sign-in identifier step and could not create an account.
- **Captcha renders automatically.** When the instance turns captcha on for a flow, `<SignUp>` and
  `<SignIn>` show the provider's widget (Turnstile, hCaptcha, reCAPTCHA v2/v3/Enterprise) in the
  configured mode (`visible`, `managed`, or `invisible` — run on submit), send its token as
  `captcha_token`, answer the sign-in `needs_captcha` step (continuing as soon as it is solved), and on
  `CAPTCHA_REQUIRED` / `CAPTCHA_FAILED` show a localized message and a fresh widget.
- **Added** `useAtlas().instanceSettings: InstanceSettings | null` — the instance's public
  `captchaFlows`, `signUpFields` and `legal` settings from `GET /v1/appearance`. The provider now
  fetches `/v1/appearance` even with `appearance.instanceDesign: false` (the design is still not
  applied then).
- **Added types** `InstanceSettings`, `PublicSignUpField`, and re-exported `FlowCaptcha`,
  `CaptchaFlowKey`, `CaptchaWidgetMode` from `@atlasauth/js`.
- **Added catalog keys** (en-US): `signUp.emailLabel`, `signUp.passwordLabel`, `signUp.optionalField`,
  `signUp.selectPlaceholder`, `signUp.consentAgree`, `signUp.consentNotice`, `signUp.terms`,
  `signUp.privacy`, `signUp.and`, `captcha.prompt`, `captcha.required`, `captcha.failed`.
- `InstanceSettings`, `PublicSignUpField` and `localizeCaptchaErrors` now come from `@atlasauth/js`
  (same shapes; one implementation shared with the other framework SDKs).
- **Added base classes** `atlas-captcha`, `atlas-consent`, `atlas-choices`, `atlas-choice` (new `ATLAS_FLOW_CSS` export, appended to `ATLAS_STYLES_CSS`; `ATLAS_BASE_CSS` is unchanged). The flow's inputs now carry `name` attributes.
- **Added base classes** `atlas-captcha`, `atlas-consent`, `atlas-choices`, `atlas-choice` (new `ATLAS_FLOW_CSS` export, appended to `ATLAS_STYLES_CSS`). The flow's inputs now carry `name` attributes.
- **`frontendApi` is validated at render.** A missing (`undefined`/`null`), non-string, blank or malformed value now
  throws an **`AtlasConfigError`** (exported; `code: 'FRONTEND_API_REQUIRED' | 'FRONTEND_API_INVALID'`, type
  `AtlasConfigErrorCode`) instead of silently sending every request to relative URLs on the app's own
  origin. Accepted: an absolute `https:` URL (`http:` only for localhost / local development hosts), or
  `"same-origin"` (exported as `SAME_ORIGIN_FRONTEND_API`) / a root-relative path such as `"/atlas"` for a
  reverse proxy.
- **Deprecated:** `frontendApi=""` (the original same-origin spelling) still works as same-origin, with a one-time
  console warning; use `"same-origin"` instead.
- **`signOut()` now resolves `SignOutResult`** — `{ revoked: boolean; activeSessionId?: string }` (was
  `Promise<void>`; `await signOut()` keeps working). Changed on both `useAtlas()` and `useAuth()`
  (`UseAuthReturn.signOut`).
  - The revoke is retried once. If it still fails, the user is signed out locally anyway and the session id
    is remembered (this tab + sibling tabs via the session broadcast), so focus, a sibling tab's signal or a
    failed token refresh never re-adopt it from the still-valid refresh cookie; the next re-check retries the
    revoke in the background.
  - The revoke runs even when no token is cached (it falls back to the booted session, or asks the Frontend
    API which session the browser's cookies carry).
  - When the server promotes another account signed in on this browser, the provider adopts it and
    `activeSessionId` names it.
  - **New option `signOut({ strict: true })`** rejects with a **`SignOutError`** (exported;
    `code: 'SIGN_OUT_REVOKE_FAILED'`, `sessionId`, `status`) after the local sign-out when the revoke fails.
  - `sessions` is now cleared on sign-out too.
- **New `locale` prop on `<AtlasProvider>`** (`SupportedLocale | string`): `'en'`, `'en-US'`, `'es'`, `'es-ES'`,
  `'fr'`, `'fr-FR'`, `'de'`, `'de-DE'`, `'pt'`, `'pt-BR'`, `'ja'`, `'ja-JP'`, `'nl'`, `'nl-NL'`, and regional
  variants that fall back to their language. Unknown → English with a console warning. `localization` still
  overrides key by key on top. Re-exported from `@atlasauth/localizations`: `resolveLocale`,
  `LOCALIZATION_KEYS`, `missingKeys`, type `SupportedLocale`. New dependency: `@atlasauth/localizations`
  (bundled statically: the catalogs are small, and a synchronous lookup means no English flash and identical
  SSR output).
- **New context method `broadcastSessionChange()`** on `useAtlas()`: tells sibling tabs to re-check. The
  built-in flows call it after completing a sign-in, so other tabs update immediately instead of on focus.
- **Popup OAuth:** a popup that closes without posting back but left a session behind (the browser severed
  `window.opener`) now completes the sign-in in the opener (re-boot, `afterUrl`, sibling tabs) instead of
  being treated as a cancel.
- **Accessibility / appearance:**
  - New `appearance.variables.colorTextOnPrimary` (→ `--atlas-color-text-on-primary`): primary button and avatar
    text. Defaults to white or near-black, whichever contrasts more with the resolved `colorPrimary` (was a
    fixed `#fff`). The `dark` and `neobrutalist` themes now get dark button text.
  - New `appearance.variables.colorFocusRing` (→ `--atlas-color-focus-ring`): a solid 2px `:focus-visible`
    outline (2px offset) on inputs, buttons, social buttons, menu items, tabs and the avatar, replacing the
    translucent glow. Defaults to the primary (`neobrutalist`: black).
  - With a design active, explicit `colorTextOnPrimary` / `colorFocusRing` still win over the design's ink
    and ring; design-mode focus is a solid outline too.
  - Inputs are at least 16px (base and design mode), so iOS Safari no longer zooms on focus.
  - `DesignTokens`, `DEFAULT_TOKENS` and `THEMES` gain both keys. The base stylesheet (`ATLAS_BASE_CSS`)
    changed deliberately for these fixes.
- **`<ApiKeys/>` and `useApiKeys()`.** Let signed-in users manage their own API keys: list, create
  (prompts for the password and retries when the server asks for a recent sign-in), show the new
  secret once with a copy button, rename, and revoke after a confirmation. Props: `organizationId`,
  `renderClaimsFields` (alias `claimsForm`) for extra fields that go into the key's `claims`,
  `onCreate`, and `expiryOptionsDays`. Shows a key's `limits` when present.
- New exported types: `ApiKeysProps`, `ApiKeysStatus`, `ApiKeyClaimsFieldsContext`,
  `UseApiKeysResult`, and re-exports of `UserApiKey`, `CreatedUserApiKey`, `CreateUserApiKeyInput`.
- New en-US catalog keys under `apiKeys.*` (32 keys).

## 0.4.1
- **Front-channel logout on sign-out.** `signOut()` now loads the `frontchannel_logout_urls` the
  Frontend API returns (apps signed in with "Sign in with Atlas" through this session) in hidden,
  sandboxed iframes, so those apps clear their sessions in this browser too. It waits until the frames
  load or 5 s pass, never fails the sign-out, only loads `https:` URLs (and `http://localhost`), and
  does nothing during SSR. Pass `signOut({ frontchannel: false })` to skip it.

## 0.4.0
- **Design system.** Components now adopt the design configured in the Atlas dashboard
  automatically (fetched from the Frontend API; opt out with `appearance.instanceDesign: false`).
- **New `appearance.preset`** (`minimal`, `atlas`, `glass`, `midnight`, `editorial`, `terminal`,
  `sunrise`, `forest`, `grape`, `slate`, `split-photo`, `bold`) and **`appearance.design`**
  (structured overrides: palette, typography, shape, elevation, density, card, buttons, inputs…).
  Precedence: dashboard design < `preset` < `variables` < `design`. Values are validated — an
  invalid one is dropped with a development warning and never reaches CSS.
- `appearance.variables` and `baseTheme` keep working unchanged when no design is in play; with a
  design they map onto it (colours, radius, curated font, density).
- The provider root carries stable `data-atlas-*` attributes (`data-atlas-card`, `data-atlas-button`,
  `data-atlas-input`, `data-atlas-density`, `data-atlas-theme`, …) and the components read the
  documented `--atlas-*` design variables.
- **More element keys** for `appearance.elements`: `sectionTitle`, `formButtonSecondary` (now
  rendered), `socialButtonIcon`, `socialButtonText`, `alert`, `text`, `link`, `list`, `listItem`,
  `userButton`, `tabs`, `tab`, `pricingTable`, `planName`, `price`, `priceInterval`; `root`,
  `formField`, `formFieldLabel` and `headerSubtitle` are now applied.
- New dependency: `@atlasauth/design`.

## 0.3.1
- `useAuth()` now also returns `status` (`'loading' | 'signed_in' | 'signed_out'`) and `session`,
  the same names `useAtlas()` uses, so code that destructures them no longer gets `undefined`.
  `isLoaded` / `isSignedIn` are unchanged.
- `useAuth()` has an exported return type, `UseAuthReturn`; annotate with it and TypeScript
  rejects fields that don't exist.

## 0.3.0
- **Popup sign-in for "Sign in with Atlas".** New `signInWithAtlasPopup(opts)` signs in from a
  popup with no full-page redirect and no callback page; the code is exchanged in the page with
  PKCE. It rejects with `popup_closed` if the user closes the popup, and falls back to the
  redirect flow when the popup is blocked.
- `<SignInWithAtlasButton>` accepts `uxMode: 'redirect' | 'popup'` (default `'redirect'`) and
  `onSuccess(result)` for popup mode.
- The sign-in result (`AtlasIdResult`) now also includes `credential` (the id_token).
- Changed: the default issuer is `https://atlasauth.net`.

## 0.2.0
- **New: `<SignInWithAtlasButton>` + `completeSignInWithAtlas()`** — "Sign in with Atlas" for any
  website via OIDC authorization-code + PKCE against `https://atlasauth.net`. Standalone: no
  `<AtlasProvider>` needed. `buildAtlasAuthorizeUrl()` is exported for custom buttons. Shares its
  sessionStorage contract with the hosted script, so the two can be mixed.
  - `loginUri` prop for server apps: the click goes to your backend login route (a same-origin
    path or an `https://` URL, same check as the script's `data-login-uri`); `clientId` /
    `redirectUri` aren't needed in that mode.
  - `completeSignInWithAtlas()` matches the script's `AtlasID.handleCallback()` exactly: a
    callback `error` is reported before the state check; the stored transaction is validated
    and removed as soon as it is read (blocked storage → `state_mismatch`); the id_token's `iss`
    and `aud` must match (`invalid_id_token`); an unparseable token response is
    `token_exchange_failed`; an unparseable callback URL is `invalid_url`.
  - The button looks like the script's button: same colours, weight, sizes and Atlas mark.
- The prebuilt `<SignIn>` social section now shows a "Continue with Atlas" button when the
  instance has Sign in with Atlas enabled. Space on it no longer scrolls the page.

## 0.1.30
- **`frontendApi` is now a REQUIRED prop on `<AtlasProvider>`** (D10). It was silently
  defaulting to `''`, so omitting it sent every request to a relative URL and failed with no
  clear signal. It's now required in the types — pass your Frontend API base (or `""` explicitly
  for a same-origin / reverse-proxy setup). Breaking at the type level only; a value you were
  already passing is unaffected.
- **`<SignIn afterUrl>` / `<SignUp afterUrl>` now navigate** on completion (D11). It was typed
  but never read; it now redirects after the session is established. No-op when unset.
- **Provider icons render at a real size** (D12). Brand marks (GitHub especially) carried only a
  `viewBox` and collapsed to 0×0 in the SDK; they now have an intrinsic size plus a CSS rule.
- **`frontendApi` is now a REQUIRED prop on `<AtlasProvider>`**. It was silently
- **`<SignIn afterUrl>` / `<SignUp afterUrl>` now navigate** on completion. It was typed
- **Provider icons render at a real size**. Brand marks (GitHub especially) carried only a

## 0.1.29
- **Fix — the invisible Google overlay is no longer rendered at exactly `opacity:0`.** GSI's
  visibility / anti-clickjacking check treats an element at exactly `opacity:0` as not-visible and
  **silently refuses the click** (dead button, no callback, no error) — which is why the overlay
  was dead on a cold click while Google's visible button (`googleButton:"google"`) always worked,
  regardless of geometry. The host-mode overlay now uses a near-zero opacity (0.004): invisible to
  the user (your styled button shows through), but GSI sees it as visible and processes the click.
  Requires `@atlasauth/js@^0.1.9`. If a cold first click is still dead on your instance, use
  `googleButton:"google"` (Google's visible button) — the only config guaranteed never refused.

## 0.1.28
- **Fix — the native Google overlay now actually stretches its iframe.** 0.1.27 stretched GSI's
  container div but ran the stretch synchronously, before GSI injects its `<iframe>` (which it does
  asynchronously, at a fixed px width) — so the iframe stayed clipped inside the wrapper and a
  click near the edges could still miss. The SDK now re-applies the fill via a `MutationObserver`
  the moment GSI injects/resizes the iframe, so it covers the wrapper exactly. Requires
  `@atlasauth/js@^0.1.8`.

## 0.1.27
- **`googleButton?: 'host' | 'google'`** on `<SignIn>` (and the headless
  `<SocialSignInButton provider="google">`) — a supported, built-in way to choose how
  the native Google button is rendered, so teams stop hand-rolling the invisible-overlay
  technique (customer spec 4.5; this is the spec's `appearance:"host"|"google"`, named
  `googleButton` because `appearance` is already the theming prop on `<AtlasProvider>`).
  - `'host'` (default, unchanged): your OWN styled button — themed by the `appearance`
    design tokens / `socialButton` element — with Google's real GSI button overlaid
    INVISIBLY on top. The user sees your button; the click mints an id_token in-page.
  - `'google'`: Google's OWN "Sign in with Google" button, rendered VISIBLY in place of
    the styled host button, for teams who'd rather not maintain a styled button at all.
    Google controls that button's look.
  In BOTH modes the button still falls back to the ordinary redirect OAuth flow (and
  fires `onProviderUnavailable`) when GSI is blocked or never renders — a dead GSI is
  never a blank, unclickable surface. Additive and default-off: unset behaves exactly as
  before. Backed by a new `visible` option on `renderGoogleOverlayButton` in `@atlasauth/js`.

## 0.1.26
- **Provider-health telemetry.** When native Google falls back to redirect (the 0.1.24
  behaviour), the SDK now also sends a best-effort beacon to Atlas so the failure — which
  happens entirely in the browser, before sign-in — shows up in the instance dashboard
  ("Google sign-in is failing for some users", with the reason split). No user identifier is
  sent; it's fire-and-forget and never blocks or throws. Requires `@atlasauth/js@^0.1.6`.

## 0.1.25
- **`onProviderUnavailable(provider, reason)`** on `<SignIn>` (and `onUnavailable` on the
  headless `<SocialSignInButton>`). Fires once when a native (in-page) provider — today
  Google/GSI — can't be used and the button has fallen back to redirect, with `reason`
  `"script_blocked"` (library blocked/threw) or `"not_rendered"` (loaded but drew no button —
  unregistered origin or blocked iframe). Lets you show honest copy without inspecting Atlas's
  DOM. The button still works via redirect regardless. Type: `ProviderUnavailableReason`.

## 0.1.24
- **Google sign-in no longer dead-ends when GSI can't load.** When Google's in-page
  library (One Tap / GSI) is blocked by an extension or privacy list, or its button
  iframe never renders, `<SignIn>` now detects it (a try/catch around init plus a
  short render watchdog) and falls back to the ordinary redirect OAuth button instead
  of leaving a button that looks enabled and does nothing.
- **Per-provider `mode` (`"native" | "redirect"`).** `<SignIn>` reads the mode from
  `/v1/client/environment`; `mode:"redirect"` skips the in-page library entirely and
  renders a plain redirect button — one code path that works in every browser (no GSI,
  no popup). Set it per provider via `PUT /v1/oauth_providers/{provider} { "mode": "redirect" }`.
  Redirect for Google requires a `client_secret` to be configured on the provider.
- **Add `hideTitle` prop** to `<SignIn>` / `<SignUp>`. Set it when your page already renders its own "Sign in" heading above the panel, so the title doesn't appear twice.

## 0.1.23
- The headless `<SocialSignInButton provider="google">` (and `useSignIn()`) now use the same
  in-page Google button as the built-in `<SignIn>`, so Google sign-in completes without a
  redirect or a stranded tab. Other providers keep the popup / redirect flow.

## 0.1.22
- Social buttons in `<SignIn>` now show a provider icon: the built-in brand mark, or a custom
  icon URL configured for the provider in the dashboard.

## 0.1.21
- Added: `onSignedIn(user)` prop on `<AtlasProvider>`. Fires once on a real signed-out →
  signed-in transition (including after a popup sign-in), never when a session is restored on
  page load.

## 0.1.20
- Social buttons in `<SignIn>` now use the per-instance button label configured in the
  dashboard when one is set, instead of always "Continue with {provider}".

## 0.1.19
- Added: popup-mode social / OIDC sign-in. Set `oauthMode: 'popup' | 'redirect'` on
  `<AtlasProvider>` as the app default or on `<SignIn>` to override; the default stays
  `'redirect'`. A blocked popup falls back to redirect.
- Added: `useSignIn().startOauth({ provider, mode })` and a headless `<SocialSignInButton>`
  with `onOpen`, `onError` and `onBlockedFallback` callbacks.

## 0.1.18
- Added: `hideTitle` prop on `<SignIn>` / `<SignUp>` to hide the panel's own heading when the
  page already shows one.

## 0.1.17
- **Fix — SSR-safe base styles.** The base stylesheet is now rendered as a `<style id="atlas-base-styles">` in `AtlasProvider`'s own output, so prebuilt components are styled in server-rendered HTML **and** on the client (no flash of unstyled content on SSR/Next.js). `ATLAS_BASE_CSS` and `injectAtlasStyles` are exported for manual/advanced use.
- **Use `>= 0.1.17`** if you rely on the prebuilt components styling themselves. 0.1.15/0.1.16 did not ship usable CSS (see below).

## 0.1.16
- First attempt to ship the base component CSS (client-side runtime injection). Superseded by 0.1.17's SSR-safe approach — prefer 0.1.17+.

## 0.1.15
- ⚠️ **Known issue: prebuilt components render unstyled.** The components emitted `atlas-*` class names and consumed `--atlas-*` design tokens but shipped **no stylesheet** and did no style injection. **Do not use for the prebuilt components** — upgrade to **0.1.17+**, which ships and injects the base CSS.

---

Components are styled out of the box from 0.1.17 with no CSS import — see the guide: https://atlasauth.net/docs/react-appearance-and-styling
## 0.1.14
- Added: billing hooks `useBilling()`, `useCheckout()` and `useSubscription()` (user- or
  organization-scoped via `{ orgId }`) and a `<PricingTable>` component; checkout and the billing
  portal open on Stripe-hosted pages. New `CheckoutParams`, `AtlasBillingPlan` and
  `AtlasBillingSubscription` types.

## 0.1.13
- Added: multiple signed-in accounts per browser. `useSessionList()` lists them and
  `setActive({ session })` switches; `<UserButton>` lists other accounts for one-click
  switching; `<MultisessionAppSupport>` remounts its children on a switch. New
  `AtlasSessionResource` type.
- Added: extension points for prebuilt components — `<UserButton.MenuItems>` with
  `<UserButton.Action>` / `<UserButton.Link>`, and `<UserProfile.Page>` / `<UserProfile.Link>`.

## 0.1.12
- Added: `useOrganizationList()`, `<CreateOrganization>` and `<OrganizationList>`.
- Added: `<Waitlist>` and `useWaitlist()`.
- Added: `useReverification()` — headless wrapper for step-up re-authentication.

## 0.1.11
- Added: `<SignInButton>`, `<SignUpButton>` and `<SignOutButton>` (new `AuthButtonProps` type),
  `<RedirectToSignIn>` / `<RedirectToSignUp>`, `<UserAvatar>`, and the headless `useSignUp()`.

## 0.1.10
- Fixed: republished with resolved dependency versions; 0.1.9 was published with unresolved
  workspace dependencies and could not be installed (deprecated on npm).

## 0.1.9
- Added: `<ManagePasskeys>` — list, add and remove passkeys; included in `<UserProfile>`. Shows a
  "not supported" note when the browser has no WebAuthn.

## 0.1.8
- Added: `<ManageMfa>` — enrol an authenticator app (TOTP), verify, show backup codes and turn
  2FA off; included in `<UserProfile>`.

## 0.1.7
- Added: `<ProfileCard>` (editable name, email addresses) and `<ActiveSessions>` (devices with
  per-device sign-out and "sign out of all other devices"). `<UserProfile>` now composes them.

## 0.1.6
- `<SignIn>` now shows a button for every enabled social provider: Google in-page, the others
  via redirect back to the current page.

## 0.1.5
- Sign-in, sign-out and organization switches now propagate to other open tabs, and a tab
  re-checks the session on focus, so a tab that started a sign-in elsewhere updates itself.

## 0.1.4
- The Google button in `<SignIn>` now has default styling from the `--atlas-*` appearance
  variables, so it looks like a button without any custom CSS.

## 0.1.3
- Changed: the Google button in `<SignIn>` is now your themed button (the `socialButton`
  appearance element) with Google's real button overlaid invisibly, instead of Google's own
  fixed-style button.

## 0.1.2
- Added: `<SignIn>` shows a native in-page Google button when the Google connection is enabled
  with a client id; One Tap is opt-in via `googleOneTap`.
- Added: headless `useSignIn()` for apps that render their own Google button.

## 0.1.1
- First published release.
- `<AtlasProvider>` with `useAtlas()`, `useAuth()`, `useUser()`, `useSession()`,
  `useOrganization()`.
- Components: `<SignIn>`, `<SignUp>`, `<UserButton>`, `<UserProfile>`,
  `<OrganizationSwitcher>`, `<OrganizationProfile>`, `<SignedIn>`, `<SignedOut>`, `<Protect>`,
  `<AtlasLoading>`, `<AtlasLoaded>`.
- Theming via `appearance` (design tokens, themes, per-element classes) and i18n.
- Silent cross-site session check: `useSilentAuth()`, plus `checkSession` /
  `handleSilentCallback` re-exported from `@atlasauth/js`.

---

Components are styled out of the box from 0.1.17 with no CSS import — see the guide: https://atlasauth.net/docs/react-appearance-and-styling

