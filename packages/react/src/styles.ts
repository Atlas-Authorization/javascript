/**
 * §10.3 base component styles.
 *
 * The prebuilt components emit `atlas-*` class names themed by the `--atlas-*`
 * design tokens (set on `.atlas-root` by {@link AtlasProvider}). This is the CSS
 * that gives those classes their default look. It ships AS A STRING (not a
 * `.css` file) so the plain `tsc` build carries it, and {@link AtlasProvider}
 * renders it as a `<style>` in its own output — present in the SERVER HTML (no
 * SSR flash) and on the client alike — so a consumer gets styled components from
 * `import { AtlasProvider }` with no stylesheet import and no bundler CSS step.
 * {@link injectAtlasStyles} is exported for the rare manual case (components
 * rendered outside a provider).
 *
 * Everything is scoped under `.atlas-root` so it never leaks into the host app,
 * and every value reads a token with a hard-coded fallback, so a component looks
 * right even before/without the provider's variables. Customer overrides
 * (`appearance.elements` classes, or the host's own CSS) are APPENDED and land
 * later in the cascade, so they win on equal specificity — the base never fights
 * an override.
 *
 * Accessibility floor: label text on a primary fill reads
 * `--atlas-color-text-on-primary` (contrast-picked from the primary by
 * `resolveTokens`), every interactive element gets a solid 2px
 * `:focus-visible` outline in `--atlas-color-focus-ring` (a glow alone is too
 * faint to find the focus by), and inputs are never under 16px so iOS Safari
 * does not zoom the page on focus.
 */
export const ATLAS_STYLE_ELEMENT_ID = 'atlas-base-styles';

export const ATLAS_BASE_CSS = `
.atlas-root{font-family:var(--atlas-font-family,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif);color:var(--atlas-color-text,#1c1c1f);line-height:1.5;-webkit-font-smoothing:antialiased;}
.atlas-root *,.atlas-root *::before,.atlas-root *::after{box-sizing:border-box;}

.atlas-card{display:flex;flex-direction:column;gap:calc(var(--atlas-spacing-unit,4px) * 4);width:100%;max-width:25rem;margin:0 auto;padding:calc(var(--atlas-spacing-unit,4px) * 8);background:var(--atlas-color-background,#fff);border:1px solid var(--atlas-color-border,#e4e4e9);border-radius:var(--atlas-border-radius,8px);box-shadow:0 1px 2px rgba(0,0,0,.04),0 8px 24px rgba(0,0,0,.06);}
.atlas-card form{display:flex;flex-direction:column;gap:calc(var(--atlas-spacing-unit,4px) * 3);}

.atlas-title{margin:0;font-size:1.25rem;font-weight:600;text-align:center;color:var(--atlas-color-text,#1c1c1f);}

.atlas-field{display:flex;flex-direction:column;gap:calc(var(--atlas-spacing-unit,4px) * 1.5);font-size:.875rem;}
.atlas-field > span{font-weight:500;color:var(--atlas-color-text,#1c1c1f);}

.atlas-input{width:100%;padding:10px 12px;font-size:max(16px,.95rem);font-family:inherit;color:var(--atlas-color-text,#1c1c1f);background:var(--atlas-color-background,#fff);border:1px solid var(--atlas-color-border,#e4e4e9);border-radius:var(--atlas-border-radius,8px);outline:none;transition:border-color .15s ease,box-shadow .15s ease;}
.atlas-input:focus{border-color:var(--atlas-color-primary,#5b5bd6);}
:is(.atlas-input,.atlas-button,.atlas-social-button,.atlas-menu-item,.atlas-tab,.atlas-avatar):focus-visible{outline:2px solid var(--atlas-color-focus-ring,var(--atlas-color-primary,#5b5bd6));outline-offset:2px;}

.atlas-button{display:inline-flex;align-items:center;justify-content:center;width:100%;min-height:40px;padding:10px 16px;font-size:.95rem;font-weight:600;font-family:inherit;color:var(--atlas-color-text-on-primary,#fff);background:var(--atlas-color-primary,#5b5bd6);border:1px solid transparent;border-radius:var(--atlas-border-radius,8px);cursor:pointer;transition:filter .15s ease,opacity .15s ease;}
.atlas-button:hover:not(:disabled){filter:brightness(1.06);}
.atlas-button:active:not(:disabled){filter:brightness(.94);}
.atlas-button:disabled{opacity:.6;cursor:not-allowed;}

.atlas-error{color:var(--atlas-color-danger,#d64545);font-size:.8125rem;}

.atlas-social-button:hover{filter:brightness(.98);}
.atlas-social-button:active{filter:brightness(.94);}
.atlas-social-label{font-weight:500;}
.atlas-social-icon{flex:0 0 auto;display:inline-flex;line-height:0;}
/* Size the brand mark the server inlines (provider-icons.ts). Without this the
   inlined <svg> relied solely on its own intrinsic size, and a mark drawn with
   only a viewBox (e.g. GitHub) collapsed to 0px. Mirrors the hosted page and the
   embed widget. */
.atlas-social-icon svg{width:18px;height:18px;display:block;}

.atlas-user-button{position:relative;display:inline-block;}
.atlas-avatar{display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;padding:0;border:none;border-radius:999px;overflow:hidden;background:var(--atlas-color-primary,#5b5bd6);color:var(--atlas-color-text-on-primary,#fff);font-weight:600;font-size:.875rem;cursor:pointer;}
.atlas-avatar img{width:100%;height:100%;object-fit:cover;display:block;}

.atlas-menu{position:absolute;right:0;top:100%;margin-top:6px;min-width:12rem;display:flex;flex-direction:column;padding:4px;background:var(--atlas-color-background,#fff);border:1px solid var(--atlas-color-border,#e4e4e9);border-radius:var(--atlas-border-radius,8px);box-shadow:0 8px 24px rgba(0,0,0,.12);z-index:50;}
.atlas-menu-item{display:flex;align-items:center;gap:8px;width:100%;padding:8px 10px;font-size:.875rem;font-family:inherit;text-align:left;text-decoration:none;color:var(--atlas-color-text,#1c1c1f);background:transparent;border:none;border-radius:6px;cursor:pointer;}
.atlas-menu-item:hover:not(:disabled){background:color-mix(in srgb,var(--atlas-color-text,#1c1c1f) 7%,transparent);}
.atlas-menu-item:disabled{opacity:.5;cursor:default;}

.atlas-tabs{display:flex;gap:4px;margin-bottom:12px;border-bottom:1px solid var(--atlas-color-border,#e4e4e9);}
.atlas-tab{padding:8px 12px;font-family:inherit;font-size:.875rem;color:var(--atlas-color-text,#1c1c1f);background:transparent;border:none;border-bottom:2px solid transparent;cursor:pointer;}
.atlas-tab[aria-selected="true"]{border-bottom-color:var(--atlas-color-primary,#5b5bd6);font-weight:600;}

.atlas-pricing-table{display:grid;grid-template-columns:repeat(auto-fit,minmax(15rem,1fr));gap:calc(var(--atlas-spacing-unit,4px) * 4);align-items:start;}
.atlas-pricing-table .atlas-card{max-width:none;margin:0;}
.atlas-pricing-table .atlas-card[data-current="true"]{border-color:var(--atlas-color-primary,#5b5bd6);box-shadow:0 0 0 2px color-mix(in srgb,var(--atlas-color-primary,#5b5bd6) 40%,transparent),0 8px 24px rgba(0,0,0,.06);}
.atlas-price{margin:0;font-size:1.75rem;font-weight:700;color:var(--atlas-color-text,#1c1c1f);}
.atlas-interval{font-size:.875rem;font-weight:500;opacity:.65;}
`.trim();

/**
 * Design-system rules. They apply ONLY when a design is active — the root then
 * carries `data-atlas-design` (plus the `data-atlas-*` variant attributes) and
 * the design stylesheet defines the `--atlas-*` design variables — so a
 * component with no design looks exactly as it did before the design system.
 *
 * Every selector is `:where(<root state>) .atlas-x`, i.e. the SAME specificity
 * as the base rule it refines (one class), so `appearance.elements` classes and
 * host CSS keep layering on top exactly as before. A raw legacy token the
 * design could not express (`--atlas-font-family`, a `var(--brand)` colour)
 * still wins where it applies, via the fallback order.
 *
 * In design mode the root no longer sets text colour/font on the whole host
 * app — only the components take the design's typography, so a dark-mode
 * design never recolours the app around them.
 */
export const ATLAS_DESIGN_CSS = `
.atlas-root[data-atlas-design]{color:inherit;font-family:inherit;}
:where(.atlas-root[data-atlas-design]) :is(.atlas-card,.atlas-menu,.atlas-tabs,.atlas-pricing-table,.atlas-social-button,.atlas-alert){font-family:var(--atlas-font-family,var(--atlas-font-body));font-size:var(--atlas-font-size-base);font-weight:var(--atlas-font-weight-body);color:var(--atlas-color-text);}

:where(.atlas-root[data-atlas-design]) .atlas-card{gap:var(--atlas-space-gap);max-width:var(--atlas-card-width);padding:var(--atlas-space-card);background:var(--atlas-card-background);border:var(--atlas-card-border-width) solid var(--atlas-color-border);border-radius:var(--atlas-radius-card);box-shadow:var(--atlas-shadow-card);}
:where(.atlas-root[data-atlas-card="glass"]) .atlas-card{-webkit-backdrop-filter:blur(var(--atlas-card-blur));backdrop-filter:blur(var(--atlas-card-blur));}
:where(.atlas-root[data-atlas-design]) .atlas-pricing-table .atlas-card{max-width:none;}
:where(.atlas-root[data-atlas-design]) .atlas-card form{gap:var(--atlas-space-gap);}

:where(.atlas-root[data-atlas-design]) :is(.atlas-title,.atlas-heading,.atlas-section-title,.atlas-plan-name,.atlas-price){font-family:var(--atlas-font-heading);font-weight:var(--atlas-font-weight-heading);color:var(--atlas-color-text);}
:where(.atlas-root[data-atlas-design]) .atlas-title{font-size:var(--atlas-font-size-title);}
:where(.atlas-root[data-atlas-design]) .atlas-heading{font-size:var(--atlas-font-size-title);margin:0;}
:where(.atlas-root[data-atlas-design]) .atlas-section-title,:where(.atlas-root[data-atlas-design]) .atlas-plan-name{font-size:var(--atlas-font-size-lg);margin:0;}
:where(.atlas-root[data-atlas-design]) .atlas-subtitle,:where(.atlas-root[data-atlas-design]) .atlas-text{color:var(--atlas-color-muted);margin:0;}
:where(.atlas-root[data-atlas-design]) .atlas-link{color:var(--atlas-color-primary-text);}
:where(.atlas-root[data-atlas-design]) .atlas-list{margin:0;padding-left:1.1em;display:flex;flex-direction:column;gap:calc(var(--atlas-space-unit) * 1.5);}
:where(.atlas-root[data-atlas-design]) .atlas-list-item{color:var(--atlas-color-text);}

:where(.atlas-root[data-atlas-design]) .atlas-field{gap:calc(var(--atlas-space-unit) * 1.5);font-size:var(--atlas-font-size-sm);}
:where(.atlas-root[data-atlas-design]) .atlas-field-label{color:var(--atlas-color-text);}
:where(.atlas-root[data-atlas-design]) .atlas-account-field{display:flex;flex-direction:column;gap:calc(var(--atlas-space-unit) * 1.5);font-size:var(--atlas-font-size-sm);color:var(--atlas-color-text);}
:where(.atlas-root[data-atlas-design]) .atlas-account-input{padding:6px 10px;font-family:inherit;outline:none;}

:where(.atlas-root[data-atlas-design]) :is(.atlas-input,.atlas-account-input){min-height:var(--atlas-control-height);font-size:max(16px,var(--atlas-font-size-base));color:var(--atlas-color-input-text);background:var(--atlas-color-input-background);border:var(--atlas-border-width) solid var(--atlas-color-border);border-radius:var(--atlas-radius-control);}
:where(.atlas-root[data-atlas-design]) :is(.atlas-input:focus,.atlas-account-input:focus){border-color:var(--atlas-color-primary);}
:where(.atlas-root[data-atlas-design]) :is(.atlas-input,.atlas-account-input,.atlas-button,.atlas-button-secondary,.atlas-social-button,.atlas-menu-item,.atlas-tab,.atlas-avatar):focus-visible{outline:2px solid var(--atlas-focus-outline-color,var(--atlas-color-primary));outline-offset:2px;}
:where(.atlas-root[data-atlas-input="filled"]) :is(.atlas-input,.atlas-account-input){background:color-mix(in srgb,var(--atlas-color-text) 6%,var(--atlas-color-input-background));border-color:transparent;}
:where(.atlas-root[data-atlas-input="underline"]) :is(.atlas-input,.atlas-account-input){background:transparent;border-width:0 0 max(1px,var(--atlas-border-width)) 0;border-radius:0;padding-left:0;padding-right:0;}
:where(.atlas-root[data-atlas-input="underline"]) :is(.atlas-input,.atlas-account-input):focus{box-shadow:0 1px 0 0 var(--atlas-color-primary);}

:where(.atlas-root[data-atlas-design]) .atlas-button{min-height:var(--atlas-control-height);font-size:var(--atlas-font-size-base);color:var(--atlas-color-text-on-primary,var(--atlas-color-primary-ink));background:var(--atlas-color-primary);border-width:var(--atlas-border-width);border-radius:var(--atlas-radius-control);text-transform:var(--atlas-button-text-transform);letter-spacing:var(--atlas-button-letter-spacing);}
:where(.atlas-root[data-atlas-button="outline"]) .atlas-button{background:transparent;color:var(--atlas-color-primary-text);border:max(1px,var(--atlas-border-width)) solid var(--atlas-color-primary);}
:where(.atlas-root[data-atlas-button="soft"]) .atlas-button{background:color-mix(in srgb,var(--atlas-color-primary) 14%,transparent);color:var(--atlas-color-primary-text);border-color:transparent;}
:where(.atlas-root[data-atlas-button="gradient"]) .atlas-button{background:linear-gradient(135deg,var(--atlas-color-primary),var(--atlas-color-accent));}
:where(.atlas-root[data-atlas-design]) .atlas-button-secondary{display:inline-flex;align-items:center;justify-content:center;min-height:calc(var(--atlas-control-height) - 8px);padding:0 calc(var(--atlas-space-unit) * 3);font-family:inherit;font-size:var(--atlas-font-size-sm);font-weight:500;color:var(--atlas-color-text);background:transparent;border:max(1px,var(--atlas-border-width)) solid var(--atlas-color-border);border-radius:var(--atlas-radius-control);text-transform:var(--atlas-button-text-transform);letter-spacing:var(--atlas-button-letter-spacing);cursor:pointer;}
:where(.atlas-root[data-atlas-design]) .atlas-button-secondary:disabled{opacity:.6;cursor:not-allowed;}

:where(.atlas-root[data-atlas-design]) .atlas-error,:where(.atlas-root[data-atlas-design]) .atlas-alert{color:var(--atlas-color-danger);font-size:var(--atlas-font-size-sm);}

:where(.atlas-root[data-atlas-social="icons"]) .atlas-social-label{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0;}

:where(.atlas-root[data-atlas-design]) .atlas-avatar{background:var(--atlas-color-primary);color:var(--atlas-color-text-on-primary,var(--atlas-color-primary-ink));}
:where(.atlas-root[data-atlas-design]) .atlas-menu{background:var(--atlas-color-surface);border:var(--atlas-card-border-width) solid var(--atlas-color-border);border-radius:var(--atlas-radius-card);box-shadow:var(--atlas-shadow-card);}
:where(.atlas-root[data-atlas-design]) .atlas-menu-item{color:var(--atlas-color-text);border-radius:var(--atlas-radius-control);}
:where(.atlas-root[data-atlas-design]) .atlas-tabs{border-bottom-color:var(--atlas-color-border);}
:where(.atlas-root[data-atlas-design]) .atlas-tab{color:var(--atlas-color-text);}
:where(.atlas-root[data-atlas-design]) .atlas-tab[aria-selected="true"]{border-bottom-color:var(--atlas-color-primary);}
:where(.atlas-root[data-atlas-design]) .atlas-pricing-table{gap:var(--atlas-space-gap);}
:where(.atlas-root[data-atlas-design]) .atlas-pricing-table .atlas-card[data-current="true"]{border-color:var(--atlas-color-primary);box-shadow:0 0 0 2px var(--atlas-color-focus-ring),var(--atlas-shadow-card);}
:where(.atlas-root[data-atlas-design]) .atlas-interval{color:var(--atlas-color-muted);opacity:1;}
`.trim();

/**
 * The full stylesheet the provider renders: base rules + design-system rules.
 * (Exported separately so the base rules are pinned by a hash — they change
 * only deliberately, as in 0.5.0 for accessibility.)
 */
/**
 * Rules for the create-account form and the captcha slot (added in 0.5.0). Kept
 * out of {@link ATLAS_BASE_CSS} so the base rules stay byte-identical.
 */
export const ATLAS_FLOW_CSS = `.atlas-captcha{display:flex;justify-content:center;}
.atlas-captcha:empty{display:none;}
.atlas-consent{display:flex;flex-wrap:wrap;gap:8px;align-items:flex-start;font-size:.875rem;}
.atlas-choices{display:flex;flex-direction:column;gap:6px;}
.atlas-choice{display:flex;gap:6px;align-items:center;font-weight:400;}`;

export const ATLAS_STYLES_CSS = `${ATLAS_BASE_CSS}\n${ATLAS_DESIGN_CSS}\n${ATLAS_FLOW_CSS}`;

/**
 * Inject the base stylesheet once. Idempotent (guards on the element id), so
 * multiple `<AtlasProvider>`s — or a re-mount — add it exactly once. A no-op
 * when there is no DOM (SSR); the styles land on the client at insertion time.
 */
export function injectAtlasStyles(): void {
  if (typeof document === 'undefined') return;
  if (document.getElementById(ATLAS_STYLE_ELEMENT_ID)) return;
  const style = document.createElement('style');
  style.id = ATLAS_STYLE_ELEMENT_ID;
  style.textContent = ATLAS_STYLES_CSS;
  document.head.appendChild(style);
}
