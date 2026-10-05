# @atlasauth/react changelog

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

## 0.1.17
- **Fix — SSR-safe base styles.** The base stylesheet is now rendered as a `<style id="atlas-base-styles">` in `AtlasProvider`'s own output, so prebuilt components are styled in server-rendered HTML **and** on the client (no flash of unstyled content on SSR/Next.js). `ATLAS_BASE_CSS` and `injectAtlasStyles` are exported for manual/advanced use.
- **Use `>= 0.1.17`** if you rely on the prebuilt components styling themselves. 0.1.15/0.1.16 did not ship usable CSS (see below).

## 0.1.16
- First attempt to ship the base component CSS (client-side runtime injection). Superseded by 0.1.17's SSR-safe approach — prefer 0.1.17+.

## 0.1.15
- ⚠️ **Known issue: prebuilt components render unstyled.** The components emitted `atlas-*` class names and consumed `--atlas-*` design tokens but shipped **no stylesheet** and did no style injection. **Do not use for the prebuilt components** — upgrade to **0.1.17+**, which ships and injects the base CSS.

---

Components are styled out of the box from 0.1.17 with no CSS import — see the guide: https://atlasauth.net/docs/react-appearance-and-styling
