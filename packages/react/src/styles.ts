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

.atlas-input{width:100%;padding:10px 12px;font-size:.95rem;font-family:inherit;color:var(--atlas-color-text,#1c1c1f);background:var(--atlas-color-background,#fff);border:1px solid var(--atlas-color-border,#e4e4e9);border-radius:var(--atlas-border-radius,8px);outline:none;transition:border-color .15s ease,box-shadow .15s ease;}
.atlas-input:focus{border-color:var(--atlas-color-primary,#5b5bd6);box-shadow:0 0 0 3px color-mix(in srgb,var(--atlas-color-primary,#5b5bd6) 25%,transparent);}

.atlas-button{display:inline-flex;align-items:center;justify-content:center;width:100%;min-height:40px;padding:10px 16px;font-size:.95rem;font-weight:600;font-family:inherit;color:#fff;background:var(--atlas-color-primary,#5b5bd6);border:1px solid transparent;border-radius:var(--atlas-border-radius,8px);cursor:pointer;transition:filter .15s ease,opacity .15s ease;}
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
.atlas-avatar{display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;padding:0;border:none;border-radius:999px;overflow:hidden;background:var(--atlas-color-primary,#5b5bd6);color:#fff;font-weight:600;font-size:.875rem;cursor:pointer;}
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
 * Inject the base stylesheet once. Idempotent (guards on the element id), so
 * multiple `<AtlasProvider>`s — or a re-mount — add it exactly once. A no-op
 * when there is no DOM (SSR); the styles land on the client at insertion time.
 */
export function injectAtlasStyles(): void {
  if (typeof document === 'undefined') return;
  if (document.getElementById(ATLAS_STYLE_ELEMENT_ID)) return;
  const style = document.createElement('style');
  style.id = ATLAS_STYLE_ELEMENT_ID;
  style.textContent = ATLAS_BASE_CSS;
  document.head.appendChild(style);
}
