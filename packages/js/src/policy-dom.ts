/**
 * Vanilla-DOM policy UI: the consent block (checkboxes + in-page viewer), the
 * clickwrap sentence, and the unskippable scroll modal. The Vue, Svelte,
 * Angular and Solid components and the embed widget host these; React draws
 * the same markup natively. Both use the `atlas-policy-*` classes from
 * {@link POLICY_CSS}, so an `appearance.elements` class on any of them works
 * everywhere.
 */

import {
  PolicyAcceptanceController,
  formatPolicyDate,
  isPolicyAcceptanceRequired,
  observeScrollEnd,
  policyHtml,
  splitTemplate,
  trapFocus,
  type Policy,
} from './policy-acceptance';

/** Translate a key with `{vars}`; unknown keys fall back to English in the caller's translator. */
export type PolicyT = (key: string, vars?: Record<string, string>) => string;

/** Extra class names per element, appended to the defaults (the `appearance.elements` hooks). */
export type PolicyClasses = Partial<
  Record<'root' | 'checkbox' | 'text' | 'link' | 'viewer' | 'viewerBody' | 'overlay' | 'modal' | 'button' | 'primaryButton' | 'error' | 'summary', string>
>;

export const POLICY_CSS = `.atlas-policy-consent{display:flex;flex-direction:column;gap:8px;font-size:.875rem;}
.atlas-policy-row{display:flex;gap:8px;align-items:flex-start;}
.atlas-policy-link{padding:0;font:inherit;color:var(--atlas-color-primary,#5b5bd6);background:none;border:0;cursor:pointer;text-decoration:underline;}
.atlas-policy-clickwrap{margin:0;font-size:.8125rem;color:var(--atlas-color-muted,#666);text-align:center;}
.atlas-policy-viewer{display:flex;flex-direction:column;gap:8px;border:1px solid var(--atlas-color-border,#e4e4e9);border-radius:var(--atlas-border-radius,8px);padding:12px;}
.atlas-policy-viewer-head{display:flex;justify-content:space-between;align-items:center;gap:8px;}
.atlas-policy-meta{margin:0;font-size:.75rem;color:var(--atlas-color-muted,#666);}
.atlas-policy-body{max-height:min(50vh,22rem);overflow:auto;padding:0 4px;font-size:.875rem;line-height:1.55;overscroll-behavior:contain;}
.atlas-policy-body:focus-visible{outline:2px solid var(--atlas-color-focus-ring,var(--atlas-color-primary,#5b5bd6));outline-offset:2px;}
.atlas-policy-sentinel{display:block;height:1px;}
.atlas-policy-overlay{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(0,0,0,.55);}
.atlas-policy-modal{display:flex;flex-direction:column;gap:12px;width:100%;max-width:36rem;max-height:calc(100vh - 32px);padding:20px;background:var(--atlas-color-background,#fff);color:var(--atlas-color-text,#1c1c1f);border:1px solid var(--atlas-color-border,#e4e4e9);border-radius:var(--atlas-border-radius,8px);box-shadow:0 12px 40px rgba(0,0,0,.3);font-family:var(--atlas-font-family,ui-sans-serif,system-ui,sans-serif);}
.atlas-policy-modal h2{margin:0;font-size:1.125rem;}
.atlas-policy-summary{padding:8px 12px;font-size:.8125rem;background:var(--atlas-color-surface,rgba(91,91,214,.08));border-radius:var(--atlas-border-radius,8px);}
.atlas-policy-summary strong{display:block;margin-bottom:2px;}
.atlas-policy-hint{margin:0;font-size:.8125rem;color:var(--atlas-color-muted,#666);}
.atlas-policy-actions{display:flex;justify-content:flex-end;gap:8px;}
.atlas-policy-actions button{min-height:40px;padding:8px 16px;font:inherit;font-weight:600;border-radius:var(--atlas-border-radius,8px);cursor:pointer;border:1px solid var(--atlas-color-border,#e4e4e9);background:transparent;color:inherit;}
.atlas-policy-actions button.atlas-policy-accept{color:var(--atlas-color-text-on-primary,#fff);background:var(--atlas-color-primary,#5b5bd6);border-color:transparent;}
.atlas-policy-actions button:disabled{opacity:.55;cursor:not-allowed;}
.atlas-policy-banner{display:flex;flex-wrap:wrap;gap:8px;align-items:center;justify-content:space-between;padding:10px 14px;font-size:.875rem;border:1px solid var(--atlas-color-border,#e4e4e9);border-radius:var(--atlas-border-radius,8px);background:var(--atlas-color-surface,rgba(91,91,214,.08));}`;

const STYLE_ID = 'atlas-policy-styles';

/** Inject {@link POLICY_CSS} once (idempotent). Hosts that carry their own base stylesheet need not call it. */
export function injectPolicyStyles(doc: Document = document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = POLICY_CSS;
  doc.head.appendChild(style);
}

const FORBIDDEN_TAGS = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'FORM', 'LINK', 'META', 'BASE', 'SVG', 'MATH']);

/**
 * Defence in depth on top of the server's sanitiser: strip active content from
 * policy HTML before it is put in the page. Unparseable input (no DOM) is
 * escaped to text.
 */
export function sanitizePolicyHtml(html: string): string {
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') {
    return html.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  }
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  const walk = (node: Element) => {
    for (const child of Array.from(node.children)) {
      if (FORBIDDEN_TAGS.has(child.tagName.toUpperCase())) {
        child.remove();
        continue;
      }
      for (const attr of Array.from(child.attributes)) {
        const name = attr.name.toLowerCase();
        const value = attr.value.trim().toLowerCase().replace(/[\s\u0000-\u001f]/g, '');
        if (name.startsWith('on') || name === 'style' || ((name === 'href' || name === 'src' || name === 'xlink:href') && /^(javascript|data|vbscript):/.test(value))) {
          child.removeAttribute(attr.name);
        }
      }
      if (child.tagName === 'A') {
        child.setAttribute('target', '_blank');
        child.setAttribute('rel', 'noopener noreferrer');
      }
      walk(child);
    }
  };
  walk(tpl.content as unknown as Element);
  return tpl.innerHTML;
}

/** The safe HTML string to draw for a policy. */
export function renderPolicyContent(policy: Pick<Policy, 'contentHtml' | 'contentMarkdown'>): string {
  return sanitizePolicyHtml(policyHtml(policy));
}

interface DomOptions {
  t: PolicyT;
  classes?: PolicyClasses;
  /** The document to build in (tests, iframes). */
  document?: Document;
}

function el<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  className?: string,
  attrs: Record<string, string> = {},
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text !== undefined) node.textContent = text;
  return node;
}

const cx = (...parts: (string | undefined)[]) => parts.filter(Boolean).join(' ');

let uid = 0;
const reading = new WeakSet<PolicyAcceptanceController>();
interface StepHandlers {
  hasOthers: boolean;
  onSubmit: PolicyAcceptStepOptions['onSubmit'];
  onDecline: PolicyAcceptStepOptions['onDecline'];
}
// The step currently showing for a controller (a repaint swaps it while a dialog is open).
const activeStep = new WeakMap<PolicyAcceptanceController, StepHandlers>();

/** A policy name that opens the document in the viewer. */
function docLink(doc: Document, policy: Policy, controller: PolicyAcceptanceController, o: DomOptions): HTMLButtonElement {
  const b = el(doc, 'button', cx('atlas-policy-link', o.classes?.link), { type: 'button', 'data-atlas-policy-open': policy.key, 'aria-haspopup': 'dialog' }, policy.title);
  b.addEventListener('click', (e) => {
    e.preventDefault();
    controller.openDocument(policy.key);
  });
  return b;
}

/** Append a sentence template with `{policies}` replaced by the given nodes (joined "A, B and C"). */
function sentence(doc: Document, tpl: string, nodes: Node[], and: string): DocumentFragment {
  const [before, after] = splitTemplate(tpl, 'policies');
  const frag = doc.createDocumentFragment();
  frag.append(before);
  nodes.forEach((n, i) => {
    if (i > 0) frag.append(i === nodes.length - 1 ? ` ${and} ` : ', ');
    frag.append(n);
  });
  frag.append(after);
  return frag;
}

export interface MountedPolicyUi {
  destroy(): void;
  /** Re-render now (normally automatic on controller changes). */
  render(): void;
}

/**
 * The consent block: one combined checkbox ("I agree to the Terms and Privacy
 * Policy") or one per policy, with each name opening the in-page viewer. While a
 * document is open the viewer replaces the checkboxes; "Back" returns.
 */
export function mountPolicyConsent(host: HTMLElement, controller: PolicyAcceptanceController, options: DomOptions): MountedPolicyUi {
  const doc = options.document ?? host.ownerDocument;
  const { t, classes } = options;
  let stopScroll: (() => void) | null = null;

  const render = () => {
    stopScroll?.();
    stopScroll = null;
    host.textContent = '';
    host.className = cx('atlas-policy-consent', classes?.root);
    host.setAttribute('data-atlas-policies', '');
    const viewing = controller.viewing;
    if (viewing) {
      host.append(renderViewer(doc, viewing, controller, options, (stop) => (stopScroll = stop)));
      return;
    }
    const boxes = controller.checkboxPolicies();
    if (boxes.length === 0) return;
    const and = t('policy.and');
    if (controller.combined) {
      const id = `atlas-policy-${++uid}`;
      const row = el(doc, 'div', 'atlas-policy-row atlas-consent');
      const input = el(doc, 'input', cx('atlas-policy-checkbox', classes?.checkbox), { type: 'checkbox', id, name: 'policies', 'data-atlas-policy-all': '' });
      input.checked = controller.snapshot().combinedChecked;
      input.addEventListener('change', () => controller.setAllChecked(input.checked));
      const label = el(doc, 'label', cx('atlas-text', classes?.text), { for: id });
      label.append(sentence(doc, t('policy.agreeCombined'), boxes.map((p) => docLink(doc, p, controller, options)), and));
      row.append(input, label);
      host.append(row);
    } else {
      for (const p of boxes) {
        const id = `atlas-policy-${++uid}`;
        const row = el(doc, 'div', 'atlas-policy-row atlas-consent');
        const input = el(doc, 'input', cx('atlas-policy-checkbox', classes?.checkbox), { type: 'checkbox', id, name: `policy_${p.key}`, 'data-atlas-policy-box': p.key });
        input.checked = controller.isChecked(p.key);
        input.addEventListener('change', () => controller.setChecked(p.key, input.checked));
        const label = el(doc, 'label', cx('atlas-text', classes?.text), { for: id });
        const [before, after] = splitTemplate(t('policy.agreeOne'), 'policy');
        label.append(before, docLink(doc, p, controller, options), after);
        row.append(input, label);
        host.append(row);
      }
    }
  };

  const off = controller.subscribe(render);
  render();
  return {
    render,
    destroy() {
      off();
      stopScroll?.();
      host.textContent = '';
    },
  };
}

/** The clickwrap sentence for `link`-mode policies: "By continuing you agree to the Terms and Privacy Policy." */
export function mountPolicyClickwrap(host: HTMLElement, controller: PolicyAcceptanceController, options: DomOptions): MountedPolicyUi {
  const doc = options.document ?? host.ownerDocument;
  const { t, classes } = options;
  const render = () => {
    host.textContent = '';
    const links = controller.linkPolicies();
    host.hidden = links.length === 0;
    if (links.length === 0) return;
    host.className = cx('atlas-policy-clickwrap', classes?.text);
    host.setAttribute('data-atlas-policy-clickwrap', '');
    host.append(sentence(doc, t('policy.clickwrap'), links.map((p) => docLink(doc, p, controller, options)), t('policy.and')));
  };
  const off = controller.subscribe(render);
  render();
  return {
    render,
    destroy() {
      off();
      host.textContent = '';
    },
  };
}

function renderViewer(
  doc: Document,
  policy: Policy,
  controller: PolicyAcceptanceController,
  o: DomOptions,
  track: (stop: () => void) => void,
): HTMLElement {
  const { t, classes } = o;
  const wrap = el(doc, 'div', cx('atlas-policy-viewer', classes?.viewer), { role: 'region', 'aria-label': policy.title, 'data-atlas-policy-viewer': policy.key });
  const head = el(doc, 'div', 'atlas-policy-viewer-head');
  head.append(el(doc, 'strong', undefined, {}, policy.title));
  const back = el(doc, 'button', cx('atlas-policy-link', classes?.link), { type: 'button', 'data-atlas-policy-back': '' }, t('policy.viewerBack'));
  back.addEventListener('click', () => controller.closeDocument());
  head.append(back);
  const meta = [policy.version ? t('policy.version', { version: policy.version }) : '', policy.effectiveAt ? t('policy.effective', { date: formatPolicyDate(policy.effectiveAt) }) : '']
    .filter(Boolean)
    .join(' · ');
  const body = el(doc, 'div', cx('atlas-policy-body', classes?.viewerBody), { tabindex: '0', 'data-atlas-policy-content': '' });
  body.innerHTML = renderPolicyContent(policy);
  const sentinel = el(doc, 'span', 'atlas-policy-sentinel', { 'aria-hidden': 'true' });
  body.append(sentinel);
  wrap.append(head);
  if (meta) wrap.append(el(doc, 'p', 'atlas-policy-meta', {}, meta));
  wrap.append(body);
  track(observeScrollEnd(body, sentinel, () => controller.markScrolledToEnd(policy.key)));
  return wrap;
}

export interface PolicyModalOptions extends DomOptions {
  /** A re-acceptance of an updated policy: shows the summary of changes and the "updated" heading. */
  reaccept?: boolean;
  /** Where to attach the overlay (default `document.body`). */
  container?: HTMLElement;
  /** The controller to record the reading clock and scroll evidence on. */
  controller?: PolicyAcceptanceController;
  onAccept(): void;
  onDecline(): void;
}

export interface PolicyModalHandle {
  close(): void;
  /** Whether Accept is currently enabled (the end was seen or the text fits). */
  readonly acceptEnabled: boolean;
}

/**
 * The unskippable policy modal: `role="dialog" aria-modal="true"`, focus trapped,
 * no close button and Escape disabled. Accept is enabled only once an end
 * sentinel is visible (IntersectionObserver) or the text fits; Decline calls
 * `onDecline`. A re-acceptance also shows the version's summary of changes.
 */
export function openPolicyModal(policy: Policy, options: PolicyModalOptions): PolicyModalHandle {
  const doc = options.document ?? document;
  const { t, classes, controller } = options;
  const n = ++uid;
  const titleId = `atlas-policy-title-${n}`;
  const hintId = `atlas-policy-hint-${n}`;
  const overlay = el(doc, 'div', cx('atlas-policy-overlay', classes?.overlay), { 'data-atlas-policy-modal': policy.key });
  const modal = el(doc, 'div', cx('atlas-policy-modal', classes?.modal), {
    role: 'dialog',
    'aria-modal': 'true',
    'aria-labelledby': titleId,
    'aria-describedby': hintId,
    tabindex: '-1',
  });
  modal.append(el(doc, 'h2', undefined, { id: titleId }, options.reaccept && policy.reaccept !== false ? t('policy.reacceptTitle', { policy: policy.title }) : policy.title));
  if (options.reaccept && policy.reaccept !== false && policy.summaryOfChanges) {
    const sum = el(doc, 'div', cx('atlas-policy-summary', classes?.summary), { 'data-atlas-policy-summary': '' });
    sum.append(el(doc, 'strong', undefined, {}, t('policy.summaryTitle')), el(doc, 'span', undefined, {}, policy.summaryOfChanges));
    modal.append(sum);
  }
  const body = el(doc, 'div', cx('atlas-policy-body', classes?.viewerBody), { tabindex: '0', role: 'region', 'aria-label': policy.title, 'data-atlas-policy-content': '' });
  body.innerHTML = renderPolicyContent(policy);
  const sentinel = el(doc, 'span', 'atlas-policy-sentinel', { 'aria-hidden': 'true', 'data-atlas-policy-end': '' });
  body.append(sentinel);
  const hint = el(doc, 'p', 'atlas-policy-hint', { id: hintId, 'aria-live': 'polite' }, t('policy.scrollHint'));
  const actions = el(doc, 'div', 'atlas-policy-actions');
  const decline = el(doc, 'button', cx(classes?.button), { type: 'button', 'data-atlas-policy-decline': '' }, t('policy.decline'));
  const accept = el(doc, 'button', cx('atlas-policy-accept', classes?.primaryButton), { type: 'button', 'data-atlas-policy-accept': '', disabled: '', 'aria-disabled': 'true' }, t('policy.accept'));
  actions.append(decline, accept);
  modal.append(body, hint, actions);
  overlay.append(modal);
  (options.container ?? doc.body).append(overlay);

  let enabled = false;
  const stopObserve = observeScrollEnd(body, sentinel, () => {
    enabled = true;
    accept.disabled = false;
    accept.removeAttribute('disabled');
    accept.setAttribute('aria-disabled', 'false');
    hint.textContent = '';
    controller?.markScrolledToEnd(policy.key);
  });
  controller?.startClock(policy.key);
  const release = trapFocus(modal, { initialFocus: body });
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    stopObserve();
    release();
    controller?.stopClock(policy.key);
    overlay.remove();
  };
  accept.addEventListener('click', () => {
    if (!enabled) return;
    close();
    options.onAccept();
  });
  decline.addEventListener('click', () => {
    close();
    options.onDecline();
  });
  return {
    close,
    get acceptEnabled() {
      return enabled;
    },
  };
}

/**
 * Walk the controller's unread scroll-mode policies one modal at a time.
 * Resolves `true` when all were accepted, `false` when the user declined.
 */
export function runScrollPolicies(controller: PolicyAcceptanceController, options: DomOptions & { reaccept?: boolean; container?: HTMLElement }): Promise<boolean> {
  return new Promise((resolve) => {
    const next = () => {
      const policy = controller.pendingScroll();
      if (!policy) {
        resolve(true);
        return;
      }
      openPolicyModal(policy, {
        ...options,
        controller,
        onAccept: () => {
          controller.acceptScroll(policy.key);
          next();
        },
        onDecline: () => resolve(false),
      });
    };
    next();
  });
}

/** The user-facing message when a required policy was declined or is unticked. */
export function policyRequiredMessage(controller: PolicyAcceptanceController, t: PolicyT, errors?: Parameters<typeof isPolicyAcceptanceRequired>[0]): string {
  const missing = controller.missing();
  if (missing.length === 1) return t('policy.required', { policy: missing[0]!.title });
  if (missing.length > 1) return t('policy.requiredGeneric');
  return errors && isPolicyAcceptanceRequired(errors) ? t('policy.requiredGeneric') : '';
}


/**
 * Submit-time check for a sign-up form: opens the unskippable dialog for each
 * unread scroll-mode policy. `ok` is false when the user declined one (`declined`
 * is its title) — the form should not submit, and should say why.
 */
export async function confirmPolicies(
  controller: PolicyAcceptanceController,
  options: DomOptions & { container?: HTMLElement },
): Promise<{ ok: boolean; declined: string | null }> {
  if (!controller.pendingScroll()) return { ok: true, declined: null };
  const ok = await runScrollPolicies(controller, options);
  if (ok) return { ok: true, declined: null };
  const declined = controller.policies.find((p) => p.display === 'scroll' && !controller.isChecked(p.key))?.title ?? null;
  return { ok: false, declined };
}

export interface PolicyAcceptStepOptions extends DomOptions {
  /** Where the scroll dialog attaches (default `document.body`). */
  container?: HTMLElement;
  /** The user accepted everything required: send these as `policy_acceptances`. */
  onSubmit(acceptances: ReturnType<PolicyAcceptanceController['build']>): void;
  /** The user declined a policy: cancel the attempt. */
  onDecline(policy: Policy): void;
}

export interface MountedPolicyStep extends MountedPolicyUi {
  /** Disable the continue button while a request is in flight. */
  setBusy(busy: boolean): void;
}

/**
 * The sign-in step for `needs_policy_acceptance`, as plain DOM: scroll-mode
 * policies open their dialog at once, the rest are checkboxes / a clickwrap
 * sentence with an "Accept and continue" button. Used by the framework SDKs'
 * sign-in components and the embed widget.
 */
export function mountPolicyAcceptStep(host: HTMLElement, controller: PolicyAcceptanceController, options: PolicyAcceptStepOptions): MountedPolicyStep {
  const doc = options.document ?? host.ownerDocument;
  const { t, classes } = options;
  let busy = false;
  let alive = true;
  host.textContent = '';
  host.setAttribute('data-atlas-policy-step', '');
  const hasOthers = controller.policies.some((p) => p.display !== 'scroll');
  host.append(el(doc, 'p', cx('atlas-text', classes?.text), {}, t('policy.pendingIntro')));
  const consent = el(doc, 'div');
  const clickwrap = el(doc, 'p');
  const mountedConsent = mountPolicyConsent(consent, controller, options);
  const mountedWrap = mountPolicyClickwrap(clickwrap, controller, options);
  host.append(consent);
  let button: HTMLButtonElement | null = null;
  const sync = () => {
    if (button) button.disabled = busy || !controller.canSubmit() || controller.pendingScroll() !== null;
  };
  if (hasOthers) {
    button = el(doc, 'button', cx('atlas-button', classes?.primaryButton), { type: 'button', 'data-atlas-policy-continue': '' }, t('policy.submit'));
    button.addEventListener('click', () => options.onSubmit(controller.build()));
    host.append(button);
  }
  host.append(clickwrap);
  const off = controller.subscribe(sync);
  sync();
  const me: StepHandlers = { hasOthers, onSubmit: options.onSubmit, onDecline: options.onDecline };
  activeStep.set(controller, me);
  const open = () => {
    // One dialog queue per controller, even if the host repaints the step.
    if (!alive || reading.has(controller) || !controller.pendingScroll()) return;
    reading.add(controller);
    void runScrollPolicies(controller, { ...options, reaccept: true }).then((ok) => {
      reading.delete(controller);
      const current = activeStep.get(controller);
      if (!current) return;
      if (!ok) {
        const declined = controller.policies.find((p) => p.display === 'scroll' && !controller.isChecked(p.key));
        if (declined) current.onDecline(declined);
      } else if (!current.hasOthers) {
        current.onSubmit(controller.build());
      }
    });
  };
  open();
  return {
    render() {
      mountedConsent.render();
      mountedWrap.render();
      sync();
    },
    setBusy(next) {
      busy = next;
      sync();
    },
    destroy() {
      alive = false;
      if (activeStep.get(controller) === me) activeStep.delete(controller);
      off();
      mountedConsent.destroy();
      mountedWrap.destroy();
      host.textContent = '';
    },
  };
}
