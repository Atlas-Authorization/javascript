# @atlasauth/elements changelog

## 0.4.0
Requires `@atlasauth/react` 0.8.0.
- **Server errors render in the app's language.** The flow's `errors` (and so `<Field.Error>`) carry the catalog
  string `error.<reason>` as their `message` — from the provider's `locale` / `localization` — else the server's
  message; `reason` stays on each error. The flow's Frontend API client sends the provider's `locale` as
  `Accept-Language`.
- `<Field.Error>`'s render-prop argument gains `reason?: string`.


## 0.3.0
- **`<SignIn.Strategy>` / `<SignUp.Strategy>` follow the app's email delivery**
  (`instanceSettings.emailDelivery` from `@atlasauth/react`): `email_code` / `email_link` are not offered
  while the app can't deliver email (`available === false`), via `offeredFirstFactors` from
  `@atlasauth/js`.
- **Added the `reset_password` strategy name** for a "Forgot password?" control: `<SignIn.Strategy
  name="reset_password">` renders on a first-factor step that offers `password`, and only while reset
  emails can be delivered (`passwordReset !== false`). Exported as `RESET_PASSWORD_STRATEGY`.
- **Added `<SignUp.EmailUnavailable>`** (props type `EmailUnavailableProps`): renders its children (default:
  the English "This app can't send email right now. Try another sign-in method or contact the app
  owner.") on the sign-up start step when `emailDelivery.passwordSignUp === false`.
- **Added `emailDelivery?: EmailDelivery` to `FlowContextValue`** (undefined until the settings load).
- **Changed `strategyAvailable(attempt, strategy, delivery?)`**: new optional third argument. Added
  `signUpEmailUnavailable(delivery)`.
- Social sign-in and sign-out come from `@atlasauth/react` (`useSignIn().startOauth`, `useAtlas()`), so
  this release picks up its popup and sign-out changes with no code here.

## 0.2.0
- **Added `<SignIn.Captcha>` and `<SignUp.Captcha>`** — where the instance's captcha widget draws
  (Turnstile, hCaptcha, reCAPTCHA v2/v3/Enterprise) in the mode the dashboard configured. A bare `<div>`
  (or your element via `asChild`), rendered only while the current step needs one: the sign-up create
  step when sign-up captcha is on, the sign-in start step when sign-in captcha is always on, and the
  `needs_captcha` challenge (solving it continues the sign-in on its own). Its token is sent as
  `captcha_token` automatically; on `CAPTCHA_REQUIRED` / `CAPTCHA_FAILED` the flow's error is localized
  (catalog keys `captcha.required` / `captcha.failed`) and a fresh widget is drawn. A
  `captcha_token` value you set yourself still takes precedence.
- **Added to `FlowContextValue`** (optional fields): `captcha?: CaptchaController`,
  `captchaNeeded?: boolean`. Added the `CaptchaProps` type.
## 0.1.0

First published release.

### Added
- Headless, unstyled React primitives for building a fully custom sign-in / sign-up UI on top of the Atlas attempt flow. Pair with `<AtlasProvider>` from `@atlasauth/react`.
- `SignIn` and `SignUp` compound components (also importable as `@atlasauth/elements/sign-in` and `@atlasauth/elements/sign-up`) with `Root`, `Step`, `Action`, `Strategy` and `Connection` (OAuth button); `SignIn.PasskeyButton` for passkey sign-in.
- Shared field primitives: `Field`, `FieldLabel`, `FieldInput`, `FieldError` and `Slot`.
- `useFlowContext()` and `FlowContextValue` for building your own primitives.
- The framework-free flow state machine: `stepForAttempt()`, `stepMatches()`, `strategyAvailable()`, `oauthProviderOf()`, `fieldError()`, `bindField()`, `runAction()` and their types.

