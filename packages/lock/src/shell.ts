/**
 * The presentation shell — the modal overlay (or inline panel) that frames the
 * embedded widget, plus its accessibility behaviour.
 *
 * The shell owns ONLY chrome: backdrop, header (logo/title/subtitle + close),
 * the sign-in/sign-up tab switcher, and the body element the widget mounts
 * into. It never touches the auth flow. Accessibility lives here too: a focus
 * trap, `role="dialog"` + `aria-modal`, Escape-to-close, focus restoration, and
 * a stylesheet that honours `prefers-reduced-motion`.
 */
import type { ChromeTokens } from './theme';

export const STYLE_MARKER = 'atlas-lock-styles';

export const LOCK_CSS = `
.atlas-lock-overlay {
  position: fixed; inset: 0; z-index: 2147483000;
  display: flex; align-items: center; justify-content: center;
  padding: 16px;
  background: rgba(17, 18, 23, 0.55);
  font-family: var(--atlas-lock-font, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif);
  opacity: 0; transition: opacity var(--atlas-lock-motion, 0.18s) ease;
  -webkit-font-smoothing: antialiased;
}
.atlas-lock-overlay[data-open="true"] { opacity: 1; }
.atlas-lock-inline {
  font-family: var(--atlas-lock-font, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif);
}
.atlas-lock-dialog {
  position: relative;
  width: 100%; max-width: 420px;
  max-height: calc(100vh - 32px); overflow-y: auto;
  background: var(--atlas-lock-bg, #ffffff);
  color: var(--atlas-lock-text, #1c1c1f);
  border: 1px solid var(--atlas-lock-border, #e4e4e9);
  border-radius: calc(var(--atlas-lock-radius, 10px) + 6px);
  box-shadow: 0 10px 40px rgba(0, 0, 0, 0.22), 0 2px 8px rgba(0, 0, 0, 0.12);
  padding: 22px 22px 26px;
  box-sizing: border-box;
  transform: translateY(8px) scale(0.98);
  transition: transform var(--atlas-lock-motion, 0.18s) ease;
}
.atlas-lock-inline .atlas-lock-dialog {
  box-shadow: none; transform: none; max-height: none; margin: 0 auto;
}
.atlas-lock-overlay[data-open="true"] .atlas-lock-dialog { transform: translateY(0) scale(1); }
.atlas-lock-dialog *, .atlas-lock-dialog *::before, .atlas-lock-dialog *::after { box-sizing: border-box; }

.atlas-lock-close {
  position: absolute; top: 12px; right: 12px;
  width: 30px; height: 30px; display: inline-flex; align-items: center; justify-content: center;
  border: 0; border-radius: 8px; cursor: pointer; padding: 0;
  background: transparent; color: var(--atlas-lock-text, #1c1c1f); opacity: 0.6; line-height: 0;
}
.atlas-lock-close:hover { opacity: 1; background: rgba(127,127,127,0.12); }
.atlas-lock-close svg { width: 16px; height: 16px; display: block; }

.atlas-lock-header { text-align: center; margin: 0 0 14px; }
.atlas-lock-logo { display: block; max-height: 42px; margin: 2px auto 12px; }
.atlas-lock-title { font-size: 19px; font-weight: 650; margin: 0 0 3px; }
.atlas-lock-subtitle { font-size: 13.5px; opacity: 0.65; margin: 0; }

.atlas-lock-tabs {
  display: flex; gap: 4px; padding: 4px; margin: 0 0 16px;
  background: rgba(127,127,127,0.1);
  border-radius: calc(var(--atlas-lock-radius, 10px));
}
.atlas-lock-tab {
  flex: 1; padding: 8px 10px; font: inherit; font-size: 14px; font-weight: 550;
  border: 0; border-radius: calc(var(--atlas-lock-radius, 10px) - 2px);
  background: transparent; color: var(--atlas-lock-text, #1c1c1f); opacity: 0.6; cursor: pointer;
  transition: background var(--atlas-lock-motion, 0.18s) ease, opacity var(--atlas-lock-motion, 0.18s) ease;
}
.atlas-lock-tab[aria-selected="true"] {
  background: var(--atlas-lock-bg, #ffffff); opacity: 1;
  box-shadow: 0 1px 2px rgba(0,0,0,0.12);
}
.atlas-lock-tab:focus-visible { outline: 2px solid var(--atlas-lock-primary, #5b5bd6); outline-offset: 1px; }
.atlas-lock-close:focus-visible { outline: 2px solid var(--atlas-lock-primary, #5b5bd6); outline-offset: 1px; }

.atlas-lock-body { min-height: 40px; }
/* The widget draws its own card; inside the shell we drop its frame so the
   dialog is the single surface. */
.atlas-lock-body .atlas-embed-card {
  border: 0 !important; box-shadow: none !important; padding: 0 !important; max-width: none !important;
}
/* When the shell renders its own title, hide the widget's duplicate heading. */
.atlas-lock-suppress-widget-head .atlas-embed-title,
.atlas-lock-suppress-widget-head .atlas-embed-subtitle { display: none; }

@media (max-width: 480px) {
  .atlas-lock-dialog { max-width: 100%; }
}
@media (prefers-reduced-motion: reduce) {
  .atlas-lock-overlay, .atlas-lock-dialog, .atlas-lock-tab { transition: none !important; }
}
`;

/** Inject the shell stylesheet once per document. */
export function injectStyles(doc: Document): void {
  if (doc.querySelector(`style[data-${STYLE_MARKER}]`)) return;
  const style = doc.createElement('style');
  style.setAttribute(`data-${STYLE_MARKER}`, '');
  style.textContent = LOCK_CSS;
  doc.head.appendChild(style);
}

const CLOSE_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';

export interface ShellParts {
  /** The outermost node to append to the page (overlay) or into the container (panel). */
  mountNode: HTMLElement;
  dialog: HTMLElement;
  body: HTMLElement;
  titleEl: HTMLElement;
  subtitleEl: HTMLElement;
  closeButton: HTMLButtonElement | null;
  signInTab: HTMLButtonElement | null;
  signUpTab: HTMLButtonElement | null;
}

export interface ShellOptions {
  doc: Document;
  display: 'modal' | 'inline';
  closable: boolean;
  tabs: boolean;
  allowSignIn: boolean;
  allowSignUp: boolean;
  logo?: string;
  title?: string;
  subtitle?: string;
  tokens: ChromeTokens;
  dialogId: string;
}

/** Build the shell DOM (not yet attached to the page). */
export function createShell(opts: ShellOptions): ShellParts {
  const d = opts.doc;
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string): HTMLElementTagNameMap[K] => {
    const node = d.createElement(tag);
    node.className = cls;
    return node;
  };

  const dialog = el('div', 'atlas-lock-dialog');
  dialog.id = opts.dialogId;
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', opts.display === 'modal' ? 'true' : 'false');
  dialog.setAttribute('aria-labelledby', `${opts.dialogId}-title`);
  dialog.tabIndex = -1;

  applyTokens(dialog, opts.tokens);

  // Close button (modal + closable only).
  let closeButton: HTMLButtonElement | null = null;
  if (opts.display === 'modal' && opts.closable) {
    closeButton = el('button', 'atlas-lock-close');
    closeButton.type = 'button';
    closeButton.setAttribute('aria-label', 'Close');
    closeButton.innerHTML = CLOSE_ICON;
    dialog.appendChild(closeButton);
  }

  // Header.
  const header = el('div', 'atlas-lock-header');
  if (opts.logo) {
    const logo = el('img', 'atlas-lock-logo');
    logo.src = opts.logo;
    logo.alt = '';
    header.appendChild(logo);
  }
  const titleEl = el('h1', 'atlas-lock-title');
  titleEl.id = `${opts.dialogId}-title`;
  const subtitleEl = el('p', 'atlas-lock-subtitle');
  header.appendChild(titleEl);
  header.appendChild(subtitleEl);
  dialog.appendChild(header);

  // Tabs.
  let signInTab: HTMLButtonElement | null = null;
  let signUpTab: HTMLButtonElement | null = null;
  if (opts.tabs && opts.allowSignIn && opts.allowSignUp) {
    const tablist = el('div', 'atlas-lock-tabs');
    tablist.setAttribute('role', 'tablist');
    signInTab = makeTab(d, 'Sign in', `${opts.dialogId}-tab-in`);
    signUpTab = makeTab(d, 'Sign up', `${opts.dialogId}-tab-up`);
    tablist.appendChild(signInTab);
    tablist.appendChild(signUpTab);
    dialog.appendChild(tablist);
  }

  // Body — the widget mounts here.
  const body = el('div', 'atlas-lock-body');
  dialog.appendChild(body);

  let mountNode: HTMLElement;
  if (opts.display === 'modal') {
    mountNode = el('div', 'atlas-lock-overlay');
    mountNode.appendChild(dialog);
  } else {
    mountNode = el('div', 'atlas-lock-inline');
    applyTokens(mountNode, opts.tokens);
    mountNode.appendChild(dialog);
  }

  return { mountNode, dialog, body, titleEl, subtitleEl, closeButton, signInTab, signUpTab };
}

function makeTab(d: Document, label: string, id: string): HTMLButtonElement {
  const tab = d.createElement('button');
  tab.className = 'atlas-lock-tab';
  tab.type = 'button';
  tab.id = id;
  tab.textContent = label;
  tab.setAttribute('role', 'tab');
  return tab;
}

/** Reflect the chrome tokens onto an element as `--atlas-lock-*` variables. */
export function applyTokens(node: HTMLElement, tokens: ChromeTokens): void {
  node.style.setProperty('--atlas-lock-bg', tokens.colorBackground);
  node.style.setProperty('--atlas-lock-text', tokens.colorText);
  node.style.setProperty('--atlas-lock-primary', tokens.colorPrimary);
  node.style.setProperty('--atlas-lock-border', tokens.colorBorder);
  node.style.setProperty('--atlas-lock-danger', tokens.colorDanger);
  node.style.setProperty('--atlas-lock-radius', tokens.borderRadius);
  node.style.setProperty('--atlas-lock-font', tokens.fontFamily);
}

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** The focusable descendants of a container, in DOM order, that are visible. */
export function focusables(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (node) => node.offsetParent !== null || node === container.ownerDocument.activeElement,
  );
}

/**
 * A modal focus trap. Returns a cleanup function. Tab / Shift+Tab cycle within
 * the dialog; Escape invokes `onEscape` (when closable). Reduced motion is a CSS
 * concern — this only manages focus and key handling.
 */
export function trapFocus(
  dialog: HTMLElement,
  onEscape: (() => void) | null,
): () => void {
  const doc = dialog.ownerDocument;
  const handler = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && onEscape) {
      event.stopPropagation();
      onEscape();
      return;
    }
    if (event.key !== 'Tab') return;
    const items = focusables(dialog);
    if (items.length === 0) {
      event.preventDefault();
      dialog.focus();
      return;
    }
    const first = items[0]!;
    const last = items[items.length - 1]!;
    const active = doc.activeElement as HTMLElement | null;
    if (event.shiftKey && (active === first || active === dialog || !dialog.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  };
  dialog.addEventListener('keydown', handler);
  return () => dialog.removeEventListener('keydown', handler);
}
