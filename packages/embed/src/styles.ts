/**
 * Minimal, scoped stylesheet for the widget.
 *
 * Injected once into the document head (keyed by a data attribute so mounting
 * two widgets does not duplicate it) rather than an inline `style` per element —
 * a single sheet is what a tenant can override with their own CSS, which is the
 * whole reason the widget renders in the host DOM instead of an iframe.
 *
 * Every class is namespaced `atlas-embed-*` so it cannot collide with the host
 * page, and every colour/radius/font reads a `--atlas-embed-*` custom property
 * with a hard-coded fallback, so the widget looks right the instant it mounts —
 * before `GET /v1/appearance` resolves — and re-themes when it does.
 */
export const STYLE_MARKER = 'atlas-embed-styles';

export const EMBED_CSS = `
.atlas-embed-root {
  --_bg: var(--atlas-embed-color-background, #ffffff);
  --_card: var(--atlas-embed-color-card, #ffffff);
  --_text: var(--atlas-embed-color-text, #1c1c1f);
  --_primary: var(--atlas-embed-color-primary, #5b5bd6);
  --_border: var(--atlas-embed-color-border, #e4e4e9);
  --_radius: var(--atlas-embed-border-radius, 10px);
  /* Transition tempo — the widget sets --atlas-embed-motion from motionSpeed and
     to 0s when animations are off; reduced-motion forces 0s below regardless. */
  --_motion: var(--atlas-embed-motion, 0.16s);
  font-family: var(--atlas-embed-font-family, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif);
  color: var(--_text);
  box-sizing: border-box;
  display: block;
}
.atlas-embed-root *, .atlas-embed-root *::before, .atlas-embed-root *::after { box-sizing: border-box; }
.atlas-embed-card {
  max-width: 400px;
  margin: 0 auto;
  padding: 28px 26px;
  background: var(--_card);
  border: 1px solid var(--_border);
  border-radius: calc(var(--_radius) + 4px);
  box-shadow: 0 1px 2px rgba(0,0,0,0.04), 0 8px 28px rgba(0,0,0,0.06);
}
.atlas-embed-logo { display: block; max-height: 40px; margin: 0 auto 16px; }
.atlas-embed-title { font-size: 20px; font-weight: 650; text-align: center; margin: 0 0 4px; }
.atlas-embed-subtitle { font-size: 14px; color: #6b7280; text-align: center; margin: 0 0 20px; }
.atlas-embed-social { display: flex; flex-direction: column; gap: 8px; margin-bottom: 16px; }
.atlas-embed-social-button {
  display: flex; align-items: center; justify-content: center; gap: 8px;
  width: 100%; padding: 10px 12px; font-size: 14px; font-weight: 550; cursor: pointer;
  color: var(--_text); background: var(--_card);
  border: 1px solid var(--_border); border-radius: var(--_radius);
}
.atlas-embed-social-button:hover { filter: brightness(0.97); }
.atlas-embed-social-icon { display: inline-flex; flex: none; line-height: 0; }
.atlas-embed-social-icon svg { width: 18px; height: 18px; display: block; }
.atlas-embed-social-label { display: inline-block; }

/* Size — button scale and icon size together. */
.atlas-embed-social[data-size="sm"] .atlas-embed-social-button { padding: 8px 10px; font-size: 13px; }
.atlas-embed-social[data-size="sm"] .atlas-embed-social-icon svg { width: 16px; height: 16px; }
.atlas-embed-social[data-size="lg"] .atlas-embed-social-button { padding: 13px 16px; font-size: 15px; }
.atlas-embed-social[data-size="lg"] .atlas-embed-social-icon svg { width: 22px; height: 22px; }

/* Icon-only variant: a square button, name in the tooltip. Always laid out as a
   centred wrap (or a carousel), never a full-width bar. */
.atlas-embed-social-button[data-variant="icon"] { width: auto; padding: 10px; aspect-ratio: 1; }
.atlas-embed-social[data-size="sm"] .atlas-embed-social-button[data-variant="icon"] { padding: 8px; }
.atlas-embed-social[data-size="lg"] .atlas-embed-social-button[data-variant="icon"] { padding: 13px; }
.atlas-embed-social[data-variant="icon"]:not([data-layout="carousel"]) {
  flex-direction: row; flex-wrap: wrap; justify-content: center;
}

/* Grid — bars share a row and wrap. */
.atlas-embed-social[data-layout="grid"] { flex-direction: row; flex-wrap: wrap; }
.atlas-embed-social[data-layout="grid"] .atlas-embed-social-button { width: auto; flex: 1 1 auto; }
.atlas-embed-social[data-layout="grid"] .atlas-embed-social-button[data-variant="icon"] { flex: 0 0 auto; }

/* Carousel — one swipeable, scroll-snapped row. The raw scrollbar is hidden; the
   arrow buttons (below) are the affordance instead. */
.atlas-embed-social[data-layout="carousel"] {
  flex-direction: row; flex-wrap: nowrap; overflow-x: auto;
  scroll-snap-type: x mandatory; -webkit-overflow-scrolling: touch; scroll-behavior: smooth;
  scrollbar-width: none;
}
.atlas-embed-social[data-layout="carousel"]::-webkit-scrollbar { display: none; }
.atlas-embed-social[data-layout="carousel"] .atlas-embed-social-button { width: auto; flex: 0 0 auto; scroll-snap-align: start; }
.atlas-embed-social[data-layout="carousel"] .atlas-embed-social-button[data-variant="block"] { min-width: 60%; }

/* Carousel shell — prev/next controls flanking the scroll row. */
.atlas-embed-carousel { position: relative; display: flex; align-items: center; gap: 4px; margin-bottom: 16px; }
.atlas-embed-carousel .atlas-embed-social { flex: 1 1 auto; min-width: 0; margin-bottom: 0; }
.atlas-embed-carousel-nav {
  flex: none; display: inline-flex; align-items: center; justify-content: center;
  width: 30px; height: 30px; padding: 0; cursor: pointer;
  color: var(--_text); background: var(--_card);
  border: 1px solid var(--_border); border-radius: 999px; transition: opacity 0.15s;
}
.atlas-embed-carousel-nav svg { width: 16px; height: 16px; display: block; }
.atlas-embed-carousel-nav:hover:not(:disabled) { filter: brightness(0.97); }
.atlas-embed-carousel-nav:disabled { opacity: 0.35; cursor: default; }
/* Nothing overflows → no controls at all. */
.atlas-embed-carousel[data-overflow="false"] .atlas-embed-carousel-nav { display: none; }
/* When the carousel sits inside a search field, the field owns the bottom margin. */
.atlas-embed-social-field .atlas-embed-carousel { margin-bottom: 0; }

/* Search — a filter box above a long provider list (socialButtons.search). The
   field wraps the button container so its own margin replaces the button block's. */
.atlas-embed-social-field { display: flex; flex-direction: column; gap: 8px; margin-bottom: 16px; }
.atlas-embed-social-field .atlas-embed-social { margin-bottom: 0; }
.atlas-embed-social-search {
  width: 100%; padding: 9px 12px; font-size: 14px; color: var(--_text);
  background: var(--_bg); border: 1px solid var(--_border); border-radius: var(--_radius);
}
.atlas-embed-social-search:focus { outline: 2px solid var(--_primary); outline-offset: -1px; }
.atlas-embed-social-button[hidden] { display: none; }
.atlas-embed-social-empty { font-size: 13px; color: #9ca3af; text-align: center; padding: 6px 0; }
.atlas-embed-social-empty[hidden] { display: none; }
.atlas-embed-divider {
  display: flex; align-items: center; text-align: center; gap: 10px;
  color: #9ca3af; font-size: 12px; margin: 14px 0;
}
.atlas-embed-divider::before, .atlas-embed-divider::after {
  content: ""; flex: 1; height: 1px; background: var(--_border);
}
.atlas-embed-field { display: block; margin: 0 0 12px; }
.atlas-embed-label { display: block; font-size: 13px; margin: 0 0 5px; color: var(--_text); }
.atlas-embed-input {
  width: 100%; padding: 10px 12px; font-size: 14px; color: var(--_text);
  background: var(--_bg); border: 1px solid var(--_border); border-radius: var(--_radius);
}
.atlas-embed-input:focus { outline: 2px solid var(--_primary); outline-offset: -1px; }
/* Password field with a show/hide toggle. */
.atlas-embed-password { position: relative; display: flex; align-items: center; }
.atlas-embed-password .atlas-embed-input { width: 100%; padding-right: 54px; }
.atlas-embed-password-toggle {
  position: absolute; right: 6px; padding: 4px 7px; font: inherit; font-size: 12px; font-weight: 600;
  cursor: pointer; color: var(--_primary); background: none; border: 0; border-radius: 6px;
}
.atlas-embed-password-toggle:hover { text-decoration: underline; }
select.atlas-embed-input { appearance: auto; }
.atlas-embed-field-checkbox { display: flex; flex-direction: row-reverse; align-items: center; justify-content: flex-end; gap: 8px; }
.atlas-embed-field-checkbox .atlas-embed-label { margin: 0; }
.atlas-embed-checkbox { width: 16px; height: 16px; margin: 0; flex: none; }
textarea.atlas-embed-input { min-height: 72px; resize: vertical; font-family: inherit; }
fieldset.atlas-embed-field { border: 0; padding: 0; margin: 0 0 12px; }
.atlas-embed-choices { display: flex; flex-direction: column; gap: 6px; }
.atlas-embed-choice { display: flex; flex-direction: row; align-items: center; gap: 8px; font-size: 14px; cursor: pointer; }
.atlas-embed-choice input { width: 16px; height: 16px; margin: 0; flex: none; accent-color: var(--_primary); }
.atlas-embed-button {
  width: 100%; margin-top: 6px; padding: 11px 12px; font-size: 14px; font-weight: 650;
  cursor: pointer; color: #ffffff; background: var(--_primary);
  border: 0; border-radius: var(--_radius);
}
.atlas-embed-button:disabled { opacity: 0.6; cursor: default; }
.atlas-embed-handle-back {
  width: 100%; margin-top: 8px; padding: 6px; font-size: 13px; font-weight: 550;
  cursor: pointer; color: #6b7280; background: none; border: 0;
}
.atlas-embed-handle-back:hover { color: #374151; }
.atlas-embed-error { display: block; font-size: 13px; color: #d64545; margin: 6px 0 0; }
.atlas-embed-form-error { font-size: 13px; color: #d64545; margin: 0 0 12px; min-height: 0; }
/* A success/confirmation banner (e.g. after a force-login password reset). */
.atlas-embed-flash {
  font-size: 13px; color: #0f7a4d; background: rgba(16,163,101,0.08);
  border: 1px solid rgba(16,163,101,0.25); border-radius: var(--_radius);
  padding: 9px 11px; margin: 0 0 14px; text-align: center;
}
.atlas-embed-footer { font-size: 13px; color: #6b7280; text-align: center; margin: 16px 0 0; }
/* §5.1 legal consent row on sign-up. */
.atlas-embed-consent { display: flex; align-items: flex-start; gap: 8px; margin: 2px 0 14px; font-size: 13px; color: #6b7280; }
.atlas-embed-consent-check { margin: 2px 0 0; width: 15px; height: 15px; flex: none; accent-color: var(--_primary); cursor: pointer; }
.atlas-embed-consent-link { color: var(--_primary); text-decoration: underline; }
/* §7.5 Remember-me row. */
.atlas-embed-remember { display: flex; align-items: center; gap: 8px; margin: -2px 0 14px; font-size: 13px; color: var(--_text); cursor: pointer; }
.atlas-embed-remember-check { width: 15px; height: 15px; flex: none; accent-color: var(--_primary); cursor: pointer; }
.atlas-embed-note { font-size: 14px; color: #6b7280; text-align: center; margin: 8px 0; }

/* Verification step — a continuation of the email panel, not a new screen: the
   context line ("Enter the code we sent to …") + a way back, then a segmented
   one-box-per-digit code input that spawns in. */
.atlas-embed-step-context { text-align: center; margin: 0 0 20px; }
.atlas-embed-step-context .atlas-embed-subtitle { margin: 0 0 6px; }
.atlas-embed-step-back {
  display: inline-block; padding: 2px 4px; font: inherit; font-size: 13px; font-weight: 550;
  cursor: pointer; color: var(--_primary); background: none; border: 0;
}
.atlas-embed-step-back:hover { text-decoration: underline; }
/* A standalone action under the submit button (Forgot password?, Back to sign in,
   the 2FA toggle) reads as a centred link, not a left-aligned fragment. */
form > .atlas-embed-step-back { display: block; width: 100%; text-align: center; margin-top: 10px; }
.atlas-embed-code { display: flex; gap: 8px; justify-content: space-between; }
.atlas-embed-code-box {
  flex: 1 1 0; min-width: 0; aspect-ratio: 1 / 1.15; padding: 0; text-align: center;
  font-size: 20px; font-weight: 600; font-variant-numeric: tabular-nums; color: var(--_text);
  background: var(--_bg); border: 1px solid var(--_border); border-radius: var(--_radius);
}
.atlas-embed-code-box:focus { outline: 2px solid var(--_primary); outline-offset: -1px; }
/* A real step change eases its content in; error/busy re-renders (same step) do
   not, and a reduced-motion viewer gets no animation at all. */
@media (prefers-reduced-motion: no-preference) {
  .atlas-embed-card[data-enter] > form,
  .atlas-embed-card[data-enter] > .atlas-embed-step-context {
    animation: atlas-embed-spawn 0.26s cubic-bezier(0.22, 0.61, 0.36, 1) both;
  }
}
@keyframes atlas-embed-spawn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }

/* ─────────────────────────────────────────────────────────────────────────
   Interaction / polish layer — how controls FEEL. Driven by data-attributes on
   the root (data-button-style / -button-effect / -shadow / -density /
   -input-style) that the widget sets from the resolved interaction config, plus
   the --_motion tempo var. Every rule is additive: with no attributes set the
   widget looks exactly as it did before this layer existed.
   ───────────────────────────────────────────────────────────────────────── */

/* Smooth every interactive control at the configured tempo. */
.atlas-embed-button, .atlas-embed-social-button, .atlas-embed-carousel-nav,
.atlas-embed-handle-back, .atlas-embed-step-back, .atlas-embed-password-toggle,
.atlas-embed-input, .atlas-embed-code-box {
  transition:
    transform var(--_motion) ease, box-shadow var(--_motion) ease,
    background-color var(--_motion) ease, border-color var(--_motion) ease,
    color var(--_motion) ease, filter var(--_motion) ease, outline-color var(--_motion) ease;
}

/* Primary CTA — a subtle hover darken by default (was static). */
.atlas-embed-button:hover:not(:disabled) { filter: brightness(1.06); }

/* Button fill style (primary CTA only — social buttons keep provider styling). */
.atlas-embed-root[data-button-style="outline"] .atlas-embed-button {
  background: transparent; color: var(--_primary); border: 1px solid var(--_primary);
}
.atlas-embed-root[data-button-style="outline"] .atlas-embed-button:hover:not(:disabled) {
  filter: none; background: color-mix(in srgb, var(--_primary) 10%, transparent);
}
.atlas-embed-root[data-button-style="soft"] .atlas-embed-button {
  background: color-mix(in srgb, var(--_primary) 14%, transparent); color: var(--_primary);
}
.atlas-embed-root[data-button-style="soft"] .atlas-embed-button:hover:not(:disabled) {
  filter: none; background: color-mix(in srgb, var(--_primary) 22%, transparent);
}
.atlas-embed-root[data-button-style="ghost"] .atlas-embed-button {
  background: transparent; color: var(--_primary);
}
.atlas-embed-root[data-button-style="ghost"] .atlas-embed-button:hover:not(:disabled) {
  filter: none; background: color-mix(in srgb, var(--_primary) 12%, transparent);
}

/* Press/hover effect — applies to every button. */
.atlas-embed-root[data-button-effect="scale"] .atlas-embed-button:active:not(:disabled),
.atlas-embed-root[data-button-effect="scale"] .atlas-embed-social-button:active,
.atlas-embed-root[data-button-effect="scale"] .atlas-embed-carousel-nav:active:not(:disabled) {
  transform: scale(0.97);
}
.atlas-embed-root[data-button-effect="lift"] .atlas-embed-button:hover:not(:disabled),
.atlas-embed-root[data-button-effect="lift"] .atlas-embed-social-button:hover {
  transform: translateY(-1px); box-shadow: 0 4px 14px rgba(0,0,0,0.14); filter: none;
}
.atlas-embed-root[data-button-effect="lift"] .atlas-embed-button:active:not(:disabled),
.atlas-embed-root[data-button-effect="lift"] .atlas-embed-social-button:active { transform: translateY(0); }
.atlas-embed-root[data-button-effect="glow"] .atlas-embed-button:hover:not(:disabled),
.atlas-embed-root[data-button-effect="glow"] .atlas-embed-social-button:hover {
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--_primary) 35%, transparent); filter: none;
}
/* Ripple — the widget appends a span on pointer-down; buttons must clip it. */
.atlas-embed-root[data-button-effect="ripple"] .atlas-embed-button,
.atlas-embed-root[data-button-effect="ripple"] .atlas-embed-social-button {
  position: relative; overflow: hidden;
}
.atlas-embed-ripple {
  position: absolute; border-radius: 50%; transform: scale(0);
  background: currentColor; opacity: 0.28; pointer-events: none;
  animation: atlas-embed-ripple 0.55s ease-out;
}
@keyframes atlas-embed-ripple { to { transform: scale(2.6); opacity: 0; } }

/* Card + solid-button elevation. */
.atlas-embed-root[data-shadow="none"] .atlas-embed-card { box-shadow: none; }
.atlas-embed-root[data-shadow="sm"] .atlas-embed-card { box-shadow: 0 1px 2px rgba(0,0,0,0.05); }
.atlas-embed-root[data-shadow="lg"] .atlas-embed-card {
  box-shadow: 0 4px 12px rgba(0,0,0,0.08), 0 16px 48px rgba(0,0,0,0.12);
}

/* Density — compact tightens padding and gaps. */
.atlas-embed-root[data-density="compact"] .atlas-embed-card { padding: 20px 18px; }
.atlas-embed-root[data-density="compact"] .atlas-embed-social { gap: 6px; margin-bottom: 12px; }
.atlas-embed-root[data-density="compact"] .atlas-embed-field { margin-bottom: 9px; }
.atlas-embed-root[data-density="compact"] .atlas-embed-button { padding: 9px 12px; }
.atlas-embed-root[data-density="compact"] .atlas-embed-social-button { padding: 8px 10px; }
.atlas-embed-root[data-density="compact"] .atlas-embed-subtitle { margin-bottom: 14px; }

/* Input style — filled and underline treatments (default is the outlined field). */
.atlas-embed-root[data-input-style="filled"] .atlas-embed-input,
.atlas-embed-root[data-input-style="filled"] .atlas-embed-code-box,
.atlas-embed-root[data-input-style="filled"] .atlas-embed-social-search {
  background: color-mix(in srgb, var(--_border) 24%, transparent); border-color: transparent;
}
.atlas-embed-root[data-input-style="filled"] .atlas-embed-input:focus,
.atlas-embed-root[data-input-style="filled"] .atlas-embed-code-box:focus,
.atlas-embed-root[data-input-style="filled"] .atlas-embed-social-search:focus {
  background: var(--_bg); border-color: var(--_primary);
}
.atlas-embed-root[data-input-style="underline"] .atlas-embed-input,
.atlas-embed-root[data-input-style="underline"] .atlas-embed-code-box,
.atlas-embed-root[data-input-style="underline"] .atlas-embed-social-search {
  background: transparent; border: 0; border-bottom: 1.5px solid var(--_border);
  border-radius: 0; padding-left: 2px; padding-right: 2px;
}
.atlas-embed-root[data-input-style="underline"] .atlas-embed-input:focus,
.atlas-embed-root[data-input-style="underline"] .atlas-embed-code-box:focus,
.atlas-embed-root[data-input-style="underline"] .atlas-embed-social-search:focus {
  outline: none; border-bottom-color: var(--_primary);
}

/* ── Loading states — spinner / skeleton / dots / bar (interaction.loading).
   Shown while appearance resolves, while a redirect ticket is exchanged, and the
   button spinner while a form submits — so the widget never flashes blank. ── */
.atlas-embed-button { display: flex; align-items: center; justify-content: center; gap: 8px; }
.atlas-embed-loading { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; min-height: 168px; padding: 12px 0; }
.atlas-embed-sr { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }

/* Spinner (default) + the in-button spinner. */
.atlas-embed-spinner, .atlas-embed-btn-spinner {
  border-radius: 50%; border-style: solid; flex: none;
  animation: atlas-embed-spin 0.7s linear infinite;
}
.atlas-embed-spinner { width: 30px; height: 30px; border-width: 3px;
  border-color: color-mix(in srgb, var(--_primary) 22%, transparent); border-top-color: var(--_primary); }
.atlas-embed-btn-spinner { width: 17px; height: 17px; border-width: 2px;
  border-color: color-mix(in srgb, currentColor 35%, transparent); border-top-color: currentColor; }
@keyframes atlas-embed-spin { to { transform: rotate(360deg); } }

/* Dots. */
.atlas-embed-loading[data-loading="dots"] { flex-direction: row; }
.atlas-embed-dot { width: 10px; height: 10px; border-radius: 50%; background: var(--_primary);
  animation: atlas-embed-bounce 1.2s ease-in-out infinite; }
.atlas-embed-dot:nth-child(2) { animation-delay: 0.15s; }
.atlas-embed-dot:nth-child(3) { animation-delay: 0.30s; }
@keyframes atlas-embed-bounce { 0%,80%,100% { transform: scale(0.5); opacity: 0.4; } 40% { transform: scale(1); opacity: 1; } }

/* Indeterminate bar. */
.atlas-embed-loading[data-loading="bar"] { min-height: 132px; }
.atlas-embed-loadbar { position: relative; width: 64%; height: 4px; border-radius: 999px; overflow: hidden;
  background: color-mix(in srgb, var(--_border) 60%, transparent); }
.atlas-embed-loadbar::before { content: ""; position: absolute; top: 0; bottom: 0; width: 40%; border-radius: 999px;
  background: var(--_primary); animation: atlas-embed-slide 1.1s ease-in-out infinite; }
@keyframes atlas-embed-slide { 0% { left: -45%; } 100% { left: 105%; } }

/* Skeleton — placeholders shaped like the form. */
.atlas-embed-loading[data-loading="skeleton"] { align-items: stretch; min-height: 0; gap: 12px; }
.atlas-embed-skel { border-radius: var(--_radius); position: relative; overflow: hidden;
  background: color-mix(in srgb, var(--_border) 55%, transparent); }
.atlas-embed-skel::after { content: ""; position: absolute; inset: 0; transform: translateX(-100%);
  background: linear-gradient(90deg, transparent, color-mix(in srgb, var(--_text) 8%, transparent), transparent);
  animation: atlas-embed-shimmer 1.3s infinite; }
.atlas-embed-skel-title { height: 22px; width: 55%; margin: 2px auto 2px; }
.atlas-embed-skel-sub { height: 13px; width: 75%; margin: 0 auto 8px; }
.atlas-embed-skel-input { height: 42px; }
.atlas-embed-skel-button { height: 44px; margin-top: 6px; }
@keyframes atlas-embed-shimmer { to { transform: translateX(100%); } }

/* Reduced motion always wins — no transitions, presses, ripples, or spawn; and
   loaders swap their spin/bounce/slide/shimmer for a minimal opacity pulse. */
@media (prefers-reduced-motion: reduce) {
  .atlas-embed-root { --_motion: 0s; }
  .atlas-embed-root [class^="atlas-embed-"] { transition: none !important; }
  .atlas-embed-root .atlas-embed-button:active,
  .atlas-embed-root .atlas-embed-social-button:active { transform: none !important; }
  .atlas-embed-ripple { display: none; }
  .atlas-embed-spinner, .atlas-embed-btn-spinner, .atlas-embed-dot,
  .atlas-embed-loadbar::before, .atlas-embed-skel::after {
    animation: atlas-embed-pulse 1.4s ease-in-out infinite !important;
  }
  .atlas-embed-loadbar::before { position: static; width: 100%; }
}
@keyframes atlas-embed-pulse { 0%,100% { opacity: 0.4; } 50% { opacity: 1; } }
`;

/** Inject the sheet once per document. Safe to call on every mount. */
export function injectStyles(doc: Document = document): void {
  if (doc.querySelector(`style[data-${STYLE_MARKER}]`)) return;
  const style = doc.createElement('style');
  style.setAttribute(`data-${STYLE_MARKER}`, '');
  style.textContent = EMBED_CSS;
  (doc.head ?? doc.documentElement).appendChild(style);
}
