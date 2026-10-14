# @atlasauth/react changelog

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
