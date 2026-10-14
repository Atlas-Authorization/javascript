# @atlasauth/elements changelog

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

