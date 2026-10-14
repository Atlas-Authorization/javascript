# @atlasauth/embed changelog

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
