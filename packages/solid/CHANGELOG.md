# @atlasauth/solid changelog

## 0.5.0
- **New `<AtlasProvider onSignOut>` and `client.onSignOut(listener)`**: `onSignOut({ reason, sessionId })` fired once each time a signed-in user becomes signed out, on every
  path: `reason` is `user` (this tab), `other_tab`, `session_expired`, `revoked` (the session was ended elsewhere,
  detected on the next token refresh or re-check) or `unknown`. The same event is dispatched on `window` as
  `atlas:signout`. Use it to reset an embedded widget (a support chat, a docs reader session).
- **`getToken({ template })`**: a short-lived token from a named JWT template for the current session (for
  example `'chatly'`, a support-chat identity token, when the instance has a Chatly connection).
- **SDK version advisories.** Every Frontend API request carries `X-Atlas-SDK: @atlasauth/solid/<version>`. When the
  response carries `Atlas-SDK-Advisory: upgrade; min=<version>; reason=<code>` (a version with a known bug), the SDK
  logs one console warning per advisory per page load. The Frontend API must allow the header in CORS, which Atlas
  does; a reverse proxy that forwards a fixed `Access-Control-Allow-Headers` list must add `x-atlas-sdk`.
- Requires `@atlasauth/js` 0.12.0.
- The prebuilt forms draw the **Atlas captcha** (provider `atlas`, no keys needed) through `@atlasauth/js` 0.12.0,
  with its words from the form's catalog. New catalog keys: `captcha.checking`, `captcha.verified`,
  `captcha.puzzlePrompt`, `captcha.puzzleConfirm`, `captcha.puzzleTile`, `captcha.puzzleAlternative`.

## 0.4.1
- **Fixed: email-code sign-in on instances without password sign-in.** After the email step the sign-in form now
  sends the code itself (`prepare_first_factor`), shows "We sent a code to …" with the code field and a
  "Resend code" action, and completes with `attempt_first_factor { strategy: "email_code", code }`. A password field
  is drawn only when the server offers `password`; when it is offered, password stays the default and the emailed
  code is one click away. If the automatic send is refused (a 429, or the app can't send email), the step shows the
  server's error and a button to try again.
- The email-link step also has "Resend link".

## 0.4.0
Requires `@atlasauth/js` 0.9.0.
- **Server errors render in the app's language.** New `AtlasProviderProps.localization?: ErrorStrings` (a bundle
  from `@atlasauth/localizations`, e.g. `esES`, or a flat `{ 'error.<reason>': '…' }` catalog): `<SignIn>` /
  `<SignUp>` show an error's `error.<reason>` string from it, else the server's message.
- **New `AtlasProviderProps.locale?: string`**, sent as `Accept-Language` on every Frontend API request
  (defaults to the `localization` bundle's `locale` tag), so the server localises `message` too.
- `AtlasClient` gains `localization?: ErrorStrings` and `locale?: string`; `createAtlasClient` accepts both.


## 0.3.0
Requires `@atlasauth/js` 0.8.0.
- **Safer sign-out.** `signOut(options?: SignOutOptions)` now resolves `SignOutResult`
  (`{ revoked: boolean; activeSessionId?: string }`) instead of `void` — on `AtlasClient.signOut` and
  `useAuth().signOut`. Existing `await signOut()` call sites keep working.
  - The session is tombstoned (in `localStorage`, per Frontend API origin, shared by every tab) BEFORE the
    revoke, which is retried once; a reload, a token refresh, a sibling tab or a tab opened later never
    re-adopts a signed-out session from a refresh cookie the revoke did not clear. Such a revoke is re-tried
    in the background, and the tombstone dropped once it lands.
  - `revoked: false` — the server never confirmed the revoke; this browser is signed out regardless.
    `{ strict: true }` rejects with a `SignOutError` (`code: 'SIGN_OUT_REVOKE_FAILED'`, `sessionId`, `status`)
    in that case, after the local sign-out.
  - `activeSessionId` — a parked session the server promoted on revoke; it is adopted.
  - With no cached token the revoke still runs (the current session, or `GET /v1/client`, names it).
  - Another tab signing out of this session now signs this tab out too.
  - Built on `SignOutGuard` from `@atlasauth/js`; unmounting `<AtlasProvider>` stops its watch and cancels
    pending background re-tries (it never revokes).
- **OAuth popup landing.** On boot the provider completes a popup landing whose opener a
  Cross-Origin-Opener-Policy severed (`#atlas_popup_result=…`): the result is relayed to the opener and the
  window closes, or — with no opener listening — its ticket is exchanged here (or the page moves to its
  `continuationUrl`). After a successful ticket exchange inside the Atlas popup the opener is woken and the
  popup closes (`closeOAuthPopupAfterSignIn`); an ordinary tab never closes.
- **Email delivery.** The prebuilt widgets read `emailDelivery` from the instance settings they load:
  - `<SignUp>` shows a "can't send email" notice (new catalog key `signUp.emailUnavailable`, en-US text
    "This app can't send email right now. Try another sign-in method or contact the app owner.") instead of
    the email + password form when `passwordSignUp` is `false`.
  - `<SignIn>`'s first-factor step now offers the server's strategies through `offeredFirstFactors`: a
    password field when `password` is offered, and "Email me a code" / "Email me a sign-in link" when
    `email_code` / `email_link` are offered and email can be delivered (hidden when `available` is `false`).
- **Added** `SIGN_UP_TEXT['signUp.emailUnavailable']`.

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

