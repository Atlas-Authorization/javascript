/**
 * `AtlasLock` — the drop-in login widget.
 *
 * It is a thin presentation + orchestration layer. The ACTUAL authentication UI
 * is the `@atlasauth/embed` `AtlasWidget`, which drives the shared
 * `@atlasauth/js` flow machine against FAPI — so multi-factor, step-up, captcha,
 * passkeys, social, errors and sessions all come for free and cannot diverge
 * from the React `<SignIn/>` or the hosted page. Lock adds the modal/inline
 * shell, the sign-in/up tab switcher, `@atlasauth/themes` theming of that chrome,
 * a method allow-list, accessibility, and the `onAuthenticated`/`onError`
 * callbacks a batteries-included widget is expected to expose.
 */
import { AtlasWidget, type WidgetOptions } from '@atlasauth/embed';
import {
  normalizeConfig,
  type AtlasLockConfig,
  type AtlasLockScreen,
  type AtlasLockSession,
  type NormalizedConfig,
} from './options';
import { buildWidgetAppearance, resolveChromeTokens } from './theme';
import { applyMethodFilter } from './methods';
import {
  createShell,
  injectStyles,
  trapFocus,
  type ShellParts,
} from './shell';

let lockSeq = 0;

const DEFAULT_TITLES: Record<AtlasLockScreen, string> = {
  'sign-in': 'Sign in',
  'sign-up': 'Create your account',
};

export class AtlasLock {
  readonly config: NormalizedConfig;
  /** The embedded widget for the current screen, once shown. */
  widget: AtlasWidget | null = null;
  /** The screen currently displayed. */
  screen: AtlasLockScreen;
  /** Whether the shell is attached to the page. */
  visible = false;

  private shell: ShellParts | null = null;
  private cleanups: Array<() => void> = [];
  private observer: MutationObserver | null = null;
  private previousFocus: HTMLElement | null = null;
  private ready: Promise<void> = Promise.resolve();
  private lastErrorSig = '';
  private readonly id: string;

  constructor(config: AtlasLockConfig) {
    this.config = normalizeConfig(config);
    this.screen = this.config.screen;
    this.id = `atlas-lock-${(lockSeq += 1)}`;
  }

  private get doc(): Document {
    const fromContainer =
      this.config.container && typeof this.config.container !== 'string'
        ? this.config.container.ownerDocument
        : null;
    return fromContainer ?? document;
  }

  /** Show the widget (open the modal, or render the inline panel). Chainable. */
  show(): this {
    if (this.visible) return this;
    const doc = this.doc;
    injectStyles(doc);

    const tokens = resolveChromeTokens({
      theme: this.config.theme,
      primaryColor: this.config.primaryColor,
      appearance: this.config.appearance,
    });

    const shell = createShell({
      doc,
      display: this.config.display,
      closable: this.config.closable,
      tabs: this.config.tabs,
      allowSignIn: this.config.allowSignIn,
      allowSignUp: this.config.allowSignUp,
      logo: this.config.logo,
      title: this.config.title,
      subtitle: this.config.subtitle,
      tokens,
      dialogId: this.id,
    });
    this.shell = shell;

    this.renderHeader();
    this.wireChrome();

    // Attach to the page.
    if (this.config.display === 'modal') {
      doc.body.appendChild(shell.mountNode);
      // Kick the open transition on the next frame.
      requestAnimationFrame?.(() => shell.mountNode.setAttribute('data-open', 'true'));
      shell.mountNode.setAttribute('data-open', 'true');
    } else {
      const host = this.resolveContainer();
      if (!host) throw new Error('@atlasauth/lock: inline `container` could not be resolved.');
      host.textContent = '';
      host.appendChild(shell.mountNode);
    }

    this.visible = true;

    // Accessibility: remember focus, trap it, move into the dialog.
    if (this.config.display === 'modal') {
      this.previousFocus = doc.activeElement as HTMLElement | null;
      this.cleanups.push(
        trapFocus(shell.dialog, this.config.closable ? () => this.hide() : null),
      );
    }

    this.ready = this.mountScreen(this.screen);
    this.config.options.onShow?.();
    return this;
  }

  /** Hide the widget and tear down its DOM + listeners. Chainable. */
  hide(): this {
    if (!this.visible) return this;
    this.teardownScreen();
    for (const fn of this.cleanups.splice(0)) fn();
    if (this.shell) {
      this.shell.mountNode.remove();
      this.shell = null;
    }
    this.visible = false;
    if (this.previousFocus && typeof this.previousFocus.focus === 'function') {
      this.previousFocus.focus();
    }
    this.previousFocus = null;
    this.config.options.onHide?.();
    return this;
  }

  /** Permanently dispose: hide and drop references. */
  destroy(): void {
    this.hide();
  }

  /** Resolves once the current screen's widget has mounted and rendered. */
  whenReady(): Promise<void> {
    return this.ready;
  }

  /** Switch to the sign-in / sign-up screen (re-mounts the widget). */
  switchTo(screen: AtlasLockScreen): this {
    if (screen === this.screen && this.widget) return this;
    if (screen === 'sign-in' && !this.config.allowSignIn) return this;
    if (screen === 'sign-up' && !this.config.allowSignUp) return this;
    this.screen = screen;
    this.renderHeader();
    this.syncTabs();
    if (this.visible) this.ready = this.mountScreen(screen);
    return this;
  }

  // ---- internals ---------------------------------------------------------

  private resolveContainer(): HTMLElement | null {
    const c = this.config.container;
    if (!c) return null;
    const node = typeof c === 'string' ? this.doc.querySelector(c) : c;
    return node instanceof HTMLElement ? node : null;
  }

  private renderHeader(): void {
    if (!this.shell) return;
    const { titleEl, subtitleEl, dialog, body } = this.shell;
    const hasTitle = Boolean(this.config.title);
    const hasSubtitle = Boolean(this.config.subtitle);

    titleEl.textContent = this.config.title ?? DEFAULT_TITLES[this.screen];
    subtitleEl.textContent = this.config.subtitle ?? '';
    titleEl.hidden = !hasTitle;
    subtitleEl.hidden = !hasSubtitle;

    const header = titleEl.parentElement;
    const hasHeader = hasTitle || hasSubtitle || Boolean(this.config.logo);
    if (header) header.hidden = !hasHeader;
    // When the shell shows its own title, suppress the widget's duplicate one.
    body.classList.toggle('atlas-lock-suppress-widget-head', hasTitle);
    void dialog;
  }

  private wireChrome(): void {
    const shell = this.shell;
    if (!shell) return;

    if (shell.closeButton) {
      const onClose = (): void => void this.hide();
      shell.closeButton.addEventListener('click', onClose);
      this.cleanups.push(() => shell.closeButton?.removeEventListener('click', onClose));
    }

    if (this.config.display === 'modal' && this.config.closable) {
      const onBackdrop = (event: MouseEvent): void => {
        if (event.target === shell.mountNode) this.hide();
      };
      shell.mountNode.addEventListener('click', onBackdrop);
      this.cleanups.push(() => shell.mountNode.removeEventListener('click', onBackdrop));
    }

    if (shell.signInTab) {
      const onIn = (): void => void this.switchTo('sign-in');
      shell.signInTab.addEventListener('click', onIn);
      this.cleanups.push(() => shell.signInTab?.removeEventListener('click', onIn));
    }
    if (shell.signUpTab) {
      const onUp = (): void => void this.switchTo('sign-up');
      shell.signUpTab.addEventListener('click', onUp);
      this.cleanups.push(() => shell.signUpTab?.removeEventListener('click', onUp));
    }
    this.syncTabs();
  }

  private syncTabs(): void {
    const shell = this.shell;
    if (!shell) return;
    const set = (tab: HTMLButtonElement | null, selected: boolean): void => {
      if (!tab) return;
      tab.setAttribute('aria-selected', selected ? 'true' : 'false');
      tab.tabIndex = selected ? 0 : -1;
    };
    set(shell.signInTab, this.screen === 'sign-in');
    set(shell.signUpTab, this.screen === 'sign-up');
  }

  private teardownScreen(): void {
    this.observer?.disconnect();
    this.observer = null;
    this.widget = null;
    this.lastErrorSig = '';
  }

  /** Mount the embedded widget for a screen and wire the method filter + events. */
  private async mountScreen(screen: AtlasLockScreen): Promise<void> {
    const shell = this.shell;
    if (!shell) return;
    this.teardownScreen();

    const body = shell.body;
    body.textContent = '';

    const options: WidgetOptions = {
      publishableKey: this.config.publishableKey,
      frontendApi: this.config.frontendApi,
      mode: screen,
      preview: this.config.preview,
      appearance: buildWidgetAppearance({
        theme: this.config.theme,
        primaryColor: this.config.primaryColor,
        appearance: this.config.appearance,
      }),
    };
    if (this.config.redirectUrl) options.redirect = this.config.redirectUrl;
    if (this.config.fetchImpl) options.fetchImpl = this.config.fetchImpl;

    const widget = new AtlasWidget(body, options);
    this.widget = widget;

    // Completion → callback (+ auto-close the modal when we are not navigating).
    const onComplete = (event: Event): void => {
      const detail = (event as CustomEvent).detail as AtlasLockSession;
      this.config.options.onAuthenticated?.(detail);
      if (!detail?.redirected && this.config.display === 'modal') this.hide();
    };
    body.addEventListener('atlas:complete', onComplete);
    this.cleanups.push(() => body.removeEventListener('atlas:complete', onComplete));

    await widget.mount();

    // First filter pass + observe re-renders to re-apply it and surface errors.
    applyMethodFilter(body, this.config.methods);
    this.installObserver(body);
    this.config.options.onReady?.();
  }

  /** Re-run the method filter on every re-render, and surface form errors. */
  private installObserver(body: HTMLElement): void {
    const Obs = this.doc.defaultView?.MutationObserver ?? (globalThis as { MutationObserver?: typeof MutationObserver }).MutationObserver;
    if (!Obs) return;
    this.observer = new Obs(() => {
      applyMethodFilter(body, this.config.methods);
      this.surfaceErrors(body);
    });
    this.observer.observe(body, { childList: true, subtree: true });
  }

  private surfaceErrors(body: HTMLElement): void {
    const onError = this.config.options.onError;
    if (!onError) return;
    const messages = Array.from(body.querySelectorAll('.atlas-embed-error'))
      .map((n) => (n.textContent ?? '').trim())
      .filter(Boolean);
    const sig = messages.join('\u0000');
    if (!messages.length) {
      this.lastErrorSig = '';
      return;
    }
    if (sig === this.lastErrorSig) return;
    this.lastErrorSig = sig;
    onError({ message: messages[0]!, messages, source: 'form' });
  }
}

/** Convenience factory mirroring the constructor. */
export function createLock(config: AtlasLockConfig): AtlasLock {
  return new AtlasLock(config);
}
