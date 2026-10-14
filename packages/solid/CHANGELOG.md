# @atlasauth/solid changelog

## 0.2.0
- **`<SignUp>` now creates accounts.** Its first step is a create-account form (the instance's
  configured sign-up fields, email, password and the legal-consent row) that posts
  `POST /v1/client/sign_ups`; the emailed-code step and the ticket exchange then run through the shared
  flow. Previously `<SignUp>` rendered the sign-in identifier step and could not create an account.
- **Captcha renders automatically.** When the instance turns captcha on for a flow, `<SignUp>` and
  `<SignIn>` show the provider's widget (Turnstile, hCaptcha, reCAPTCHA v2/v3/Enterprise) in the
  configured mode (`visible`, `managed`, or `invisible` — run on submit), send its token as
  `captcha_token`, answer the sign-in `needs_captcha` step (continuing as soon as it is solved), and on
  `CAPTCHA_REQUIRED` / `CAPTCHA_FAILED` show a message and a fresh widget.
- **Changed:** the flow now shows field-scoped errors (e.g. a rejected password) as alerts too;
  previously only form-level errors were shown. Inputs are re-created only when the step changes, so
  typed values survive a refused submit.
- **Added** `SIGN_UP_TEXT` — the en-US strings of the create-account form and captcha, under the same
  catalog keys as `@atlasauth/react`: `signUp.title`, `signUp.submit`, `signUp.emailLabel`,
  `signUp.passwordLabel`, `signUp.optionalField`, `signUp.selectPlaceholder`, `signUp.consentAgree`,
  `signUp.consentNotice`, `signUp.terms`, `signUp.privacy`, `signUp.and`, `captcha.prompt`,
  `captcha.required`, `captcha.failed`.
- New element classes `atlas-captcha`, `atlas-consent`, `atlas-choices`, `atlas-choice`, `atlas-text`,
  `atlas-link`.
- **`frontendApi` is validated at `<AtlasProvider>`.** A missing (or non-string) or malformed value now throws an
  `AtlasConfigError` (from `@atlasauth/js`; `code: 'FRONTEND_API_REQUIRED'` or `'FRONTEND_API_INVALID'`)
  instead of silently sending requests to relative URLs on the app's own origin. Accepted: an absolute
  `https:` URL (`http:` only for localhost / local development hosts), or `"same-origin"` / a root-relative path such as `"/atlas"` for a reverse proxy.
- **Deprecated:** `frontendApi: ""` (the original same-origin spelling) still works as same-origin, with a
  one-time console warning; use `"same-origin"` instead.

## 0.1.2

### Added
- `signOut()` now runs OIDC front-channel logout before clearing local state: the front-channel logout URLs returned when the session is revoked are loaded in hidden iframes (up to 5 seconds), so other apps signed in through the session are signed out in this browser too. Pass `signOut({ frontchannel: false })` to skip it. `signOut` on `AtlasClient` and `useAuth()` now accepts an optional `SignOutOptions`.

## 0.1.1

### Added
- `useAuth()` now also returns `status()` (`loading` | `signed_in` | `signed_out`) and `session()` (the active session, or `null`) accessors alongside `isLoaded` / `isSignedIn`.

## 0.1.0

First published release.

### Added
- `AtlasProvider` and `createAtlasClient()` for SolidJS, built on `@atlasauth/js`.
- Reactive accessors: `useAuth()`, `useUser()`, `useSession()` and `useAtlas()`.
- Guards: `SignedIn`, `SignedOut`, `AtlasLoading`, `AtlasLoaded` and `Protect`.
- Mountable `SignIn`, `SignUp` and `UserButton` components, plus `mountSignInWidget()`, `mountSignUpWidget()` and `mountUserButtonWidget()`.
- Types `AtlasUser`, `AtlasSession`, `SessionClaims`, `AuthStatus` and `AtlasState`.

