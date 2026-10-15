# @atlasauth/embed changelog

## 0.4.0
- **Completes a severed sign-in popup.** When the widget's page is the landing of a sign-in popup started by
  an Atlas SDK on the same site whose `window.opener` was cut by a Cross-Origin-Opener-Policy
  (`#atlas_popup_result=…` in the URL), the widget now calls `completeOAuthPopupLanding()` on mount: the
  result is relayed to the opener (which redeems the ticket) and the popup closes; when no opener takes it,
  the widget redeems the ticket itself like a redirect result (or follows the payload's `continuationUrl`).
  This runs once per page however many widgets mount, and the fragment is scrubbed.
- **Hands back to the opener after a sign-in inside the popup.** After the widget redeems a redirect ticket in
  a window named `atlas:oauth`, it calls `closeOAuthPopupAfterSignIn()`; when the opener acknowledges (or is
  still open) the popup closes instead of navigating. Ordinary tabs are unaffected.
- **Changed** `exchange()` (widget flow module) resolves `boolean` — whether the ticket exchange set a session
  (`false` in preview mode) — instead of `void`.
- **Changed** `EMAIL_UNAVAILABLE_MESSAGE` is now re-exported from `@atlasauth/js` (same text, same export).
- Requires `@atlasauth/js` 0.8.0.

## 0.3.0
- **The keyboard focus ring has at least 3:1 contrast.** The widget now sets
  `--atlas-embed-color-focus-ring` to the primary when it clears 3:1 against the card and the page
  background, otherwise to the primary's hue darkened or lightened until it does (it used to be the primary
  unchecked — mint `#22f79a` on white is ~1.4:1).
- **Added** `appearance.variables.colorFocusRing` (new `WidgetVariables` type, exported): an explicit ring
  colour, used as given.

## 0.2.2
- **Email-dependent UI follows the server.** The widget reads the new `email_delivery` block from
  `GET /v1/appearance`. "Forgot password?" is hidden when `password_reset` is false, and the sign-up form
  is replaced by "This app can't send email right now…" when `password_sign_up` is false (the app has no
  email provider and requires email verification). Older servers that omit the block behave as before.
- **Types.** `AppearanceResponse` gains optional `email_delivery` (`EmailDeliveryAvailability`:
  `available`, `password_reset`, `password_sign_up`). `AtlasWidget` gains `passwordResetEnabled` and
  `passwordSignUpEnabled`. `EMAIL_UNAVAILABLE_MESSAGE` is exported from the widget forms module.

## 0.2.1
- The widget's captcha loader/renderer now comes from `@atlasauth/js` (the same one the React
  components use). No behaviour change; a failed provider script load is now retried on the next
  attempt instead of failing until reload.

- **Accessibility.** The primary button label colour is picked for contrast from the primary colour
  (white or near-black) instead of a fixed white; override it with the new `--atlas-embed-color-text-on-primary`
  CSS variable. Buttons, social buttons, links and toggles show a solid 2px `:focus-visible` outline
  (`--atlas-embed-color-focus-ring`, default the primary). Text fields and the social search box are 16px, so
  iOS Safari no longer zooms on focus.


## 0.2.0
- **Design system.** `<atlas-sign-in>` / `<atlas-sign-up>` and `mount()` apply the design configured in
  the Atlas dashboard (from `/v1/appearance`): palette, radius, font, button/input style, shadow,
  density and social layout map onto the widget's tokens and interaction settings.
- **New inline `appearance.preset` and `appearance.design`** (and `data-atlas-preset` on the element) —
  the same settings and semantics as `@atlasauth/react`: tenant branding < dashboard design < `preset`
  < `variables` < `design`. Opt out of the dashboard design with `appearance.instanceDesign: false`.
- The widget root carries the stable `data-atlas-*` design attributes (the widget keeps styling itself
  through its `--atlas-embed-*` tokens; it does not ship the `--atlas-*` design stylesheet).
- Without a design, theming is unchanged.
- New dependency: `@atlasauth/design` — only its zod-free runtime entry is bundled into `embed.js`
  (about +21 KB minified).

## 0.1.2
- **Fixed: provider icons.** Social-button provider icons now carry an intrinsic 18px size, so they no longer collapse to 0px where no CSS sizes them. The widget's own styles still size them per button size.

## 0.1.1
- First published release.
- **Framework-agnostic sign-in widget.** Use the `<atlas-sign-in>` / `<atlas-sign-up>` custom elements (register them with `defineElements()`), or mount imperatively with `mountSignIn()` / `mountSignUp()`. The standalone `embed.js` bundle registers the elements and exposes `window.Atlas` for script-tag use; `publishable-key`, `frontend-api` and `redirect` can be set on the elements or the script tag (`readScriptTag()`, `setScriptDefaults()`).
- **Sign-in and sign-up flows.** Email + password on one screen, email / SMS verification codes with a segmented code input, forgot-password and reset, show / hide password, "remember me", trusted-device ("remember this device") for two-factor, configurable sign-up fields (including long text, date, radio and multi-select), and Terms / Privacy consent on sign-up.
- **Passkeys.** "Sign in with a passkey", including browser autofill (conditional UI).
- **Social sign-in.** Brand-logo provider buttons with configurable variant, size, layout and labels, search for long provider lists, a scrollable carousel, Google's official sign-in button, Bluesky handle sign-in, and a "Sign in with Atlas" button with a popup flow.
- **CAPTCHA** widgets are rendered for flows that require them.
- **Appearance.** The widget follows the instance's branding and appearance settings (design tokens, button effects, a customizable loading state). Helpers and types such as `resolveTokens()`, `cssVariables()`, `resolveSocialButtons()`, `providerIcon()`, `WidgetAppearance` and `SocialButtonsConfig` are exported for module users.
- Redirect targets are checked with `validateRedirect()`.
