import { HOST_VARIABLE_NAMES, hostVariableBridgeCss } from './css';

/**
 * Strict-CSP-friendly stylesheet injection for the components that render on a
 * customer's page. A constructable stylesheet (`document.adoptedStyleSheets`)
 * is not subject to `style-src`, so a page whose Content-Security-Policy has no
 * `'unsafe-inline'` still styles the component. Browsers without it get a
 * `<style>` element carrying the CSP nonce (`setStyleNonce`, or the nonce of a
 * `<meta name="csp-nonce">` / the first nonced `<script>` on the page).
 */

interface SheetDoc {
  adoptedStyleSheets?: unknown[];
  head?: { appendChild(n: unknown): unknown; querySelector?(s: string): unknown } | null;
  documentElement?: unknown;
  createElement(tag: string): { setAttribute(k: string, v: string): void; textContent: string | null; nonce?: string };
  querySelector?(sel: string): { getAttribute(k: string): string | null; nonce?: string } | null;
}

let explicitNonce: string | null = null;

/** The CSP nonce to put on fallback `<style>` elements (pass the same nonce your page's CSP names). */
export function setStyleNonce(nonce: string | null): void {
  explicitNonce = typeof nonce === 'string' && /^[A-Za-z0-9+/=_-]{1,256}$/.test(nonce) ? nonce : null;
}

/** The nonce in use: the explicit one, else one found on the page. */
export function styleNonce(doc: SheetDoc): string | null {
  if (explicitNonce) return explicitNonce;
  try {
    const meta = doc.querySelector?.('meta[name="csp-nonce"]');
    const m = meta?.getAttribute('content');
    if (m) return m;
    const s = doc.querySelector?.('script[nonce]');
    const n = s ? s.nonce || s.getAttribute('nonce') : null;
    if (n) return n;
  } catch {
    /* no DOM access */
  }
  return null;
}

const adopted = new WeakMap<object, Map<string, unknown>>();
const adoptedText = new WeakMap<object, Map<string, string>>();

/**
 * The CSS text Atlas applied to this document as constructable sheets, by id
 * (or all of it joined). For tests and debugging: a constructable sheet has no
 * element to read back.
 */
export function adoptedCss(doc: object, id?: string): string {
  const m = adoptedText.get(doc);
  if (!m) return '';
  return id !== undefined ? (m.get(id) ?? '') : [...m.values()].join('\n');
}

/**
 * Add (or replace) the stylesheet `id` on the document. Returns how it was
 * applied: `adopted` (constructable sheet), `style` (a `<style>` element) or
 * `none` (no DOM).
 */
export function adoptStylesheet(doc: SheetDoc | undefined, id: string, css: string): 'adopted' | 'style' | 'none' {
  if (!doc || typeof doc.createElement !== 'function') return 'none';
  if (adoptConstructable(doc, id, css)) return 'adopted';
  const head = doc.head ?? (doc.documentElement as SheetDoc['head']);
  if (!head) return 'none';
  const existing = doc.querySelector?.(`style[data-atlas-sheet="${id}"]`) as { textContent: string | null } | null;
  if (existing) {
    existing.textContent = css;
    return 'style';
  }
  const style = doc.createElement('style');
  style.setAttribute('data-atlas-sheet', id);
  applyStyleNonce(doc, style);
  style.textContent = css;
  head.appendChild(style);
  return 'style';
}

/** Put the page's CSP nonce (if any) on a `<style>` element about to be inserted. */
export function applyStyleNonce(
  doc: SheetDoc,
  style: { setAttribute(k: string, v: string): void; nonce?: string },
): void {
  const nonce = styleNonce(doc);
  if (!nonce) return;
  style.setAttribute('nonce', nonce);
  try {
    style.nonce = nonce;
  } catch {
    /* read-only in some engines */
  }
}

/**
 * Apply `css` as the constructable stylesheet `id` (replacing its text when it
 * exists). False when the browser has no constructable stylesheets: insert a
 * nonced `<style>` instead.
 */
export function adoptConstructable(doc: SheetDoc, id: string, css: string): boolean {
  const Ctor = (globalThis as { CSSStyleSheet?: new () => { replaceSync(css: string): void } }).CSSStyleSheet;
  if (Ctor && Array.isArray(doc.adoptedStyleSheets) && typeof Ctor.prototype?.replaceSync === 'function') {
    try {
      let byId = adopted.get(doc as object);
      if (!byId) adopted.set(doc as object, (byId = new Map()));
      let texts = adoptedText.get(doc as object);
      if (!texts) adoptedText.set(doc as object, (texts = new Map()));
      texts.set(id, css);
      let sheet = byId.get(id) as { replaceSync(css: string): void } | undefined;
      if (!sheet) {
        sheet = new Ctor();
        byId.set(id, sheet);
        sheet.replaceSync(css);
        doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, sheet];
      } else {
        sheet.replaceSync(css);
      }
      return true;
    } catch {
      /* fall through to a <style> element */
    }
  }
  return false;
}

/** Whether a stylesheet `id` was already applied to this document. */
export function hasStylesheet(doc: SheetDoc | undefined, id: string): boolean {
  if (!doc) return false;
  if (adopted.get(doc as object)?.has(id)) return true;
  try {
    return Boolean(doc.querySelector?.(`style[data-atlas-sheet="${id}"]`));
  } catch {
    return false;
  }
}

/**
 * The `--atlas-host-*` variables the host page sets on its root element, read from
 * the computed style (an empty value = not set).
 */
export function hostVariablesSet(win: { getComputedStyle?(el: unknown): { getPropertyValue(n: string): string } } | undefined, root: unknown): string[] {
  if (!win?.getComputedStyle || !root) return [];
  try {
    const cs = win.getComputedStyle(root);
    return HOST_VARIABLE_NAMES.filter((n) => cs.getPropertyValue(n).trim() !== '');
  } catch {
    return [];
  }
}

/** Apply the `--atlas-host-*` bridge for `scope` on this document, when the page sets any of them. */
export function applyHostVariableBridge(doc: SheetDoc | undefined, scope = '.atlas-root'): boolean {
  if (!doc) return false;
  const win = (globalThis as { window?: { getComputedStyle?(el: unknown): { getPropertyValue(n: string): string } } }).window;
  const css = hostVariableBridgeCss(hostVariablesSet(win, doc.documentElement), scope);
  if (!css) return false;
  adoptStylesheet(doc, `host-vars:${scope}`, css);
  return true;
}
