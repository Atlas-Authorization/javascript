import { ContextConsumer, ContextProvider } from '@lit/context';
import { LitElement, html, nothing, type PropertyValues } from 'lit';
import { resolveFrontendApi } from '@atlasauth/js';
import { createAtlasClient, type AtlasClient } from './client';
import { atlasContext, loadingSnapshot, type AtlasState } from './context';
import { mountAtlasWidget, type WidgetMode, type WidgetMounter } from './widget';

/**
 * `<atlas-provider publishable-key="pk_…" frontend-api="https://auth.example.com">`
 *
 * Creates the Atlas client in the browser, boots the session (completing an OAuth redirect if the
 * page is one), refreshes the token before it expires, and shares the state with every Atlas
 * element below it. Put it once near the top of the page. `frontend-api` is required; a missing
 * or malformed value throws an `AtlasConfigError` when the element connects.
 */
export class AtlasProvider extends LitElement {
  static override properties = {
    publishableKey: { type: String, attribute: 'publishable-key' },
    frontendApi: { type: String, attribute: 'frontend-api' },
  };

  declare publishableKey: string;
  declare frontendApi: string;
  /** Replace `fetch` (tests, custom transports). */
  fetchImpl?: typeof fetch;

  private client: AtlasClient | null = null;
  private unsubscribe: (() => void) | null = null;
  private readonly provider = new ContextProvider(this, {
    context: atlasContext,
    initialValue: { client: null, snapshot: loadingSnapshot, publishableKey: '', frontendApi: '' } as AtlasState,
  });

  constructor() {
    super();
    this.publishableKey = '';
    this.frontendApi = '';
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this.start();
  }

  override disconnectedCallback(): void {
    this.stop();
    super.disconnectedCallback();
  }

  protected override willUpdate(changed: PropertyValues): void {
    // A changed key or API origin means a different instance: rebuild the client.
    if (this.isConnected && this.client && (changed.has('publishableKey') || changed.has('frontendApi'))) {
      this.stop();
      this.start();
    }
  }

  private start(): void {
    if (this.client || !this.publishableKey) return;
    const frontendApi = resolveFrontendApi(this.frontendApi, { component: '<atlas-provider>' });
    const client = createAtlasClient({
      publishableKey: this.publishableKey,
      frontendApi: this.frontendApi,
      ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}),
    });
    this.client = client;
    const publish = () =>
      this.provider.setValue({ client, snapshot: client.snapshot(), publishableKey: this.publishableKey, frontendApi });
    this.unsubscribe = client.subscribe(publish);
    publish();
    void client.boot();
  }

  private stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.client?.destroy();
    this.client = null;
    this.provider.setValue({ client: null, snapshot: loadingSnapshot, publishableKey: '', frontendApi: '' });
  }

  protected override render() {
    return html`<slot></slot>`;
  }
}

/** Base class for elements that read the Atlas state: re-renders on every change. */
export abstract class AtlasElement extends LitElement {
  private readonly consumer = new ContextConsumer(this, { context: atlasContext, subscribe: true });

  protected get atlas(): AtlasState {
    return this.consumer.value ?? { client: null, snapshot: loadingSnapshot, publishableKey: '', frontendApi: '' };
  }
}

/** `<atlas-signed-in>…</atlas-signed-in>` renders its children only for a signed-in user. */
export class AtlasSignedIn extends AtlasElement {
  protected override render() {
    return this.atlas.snapshot.status === 'signed_in' ? html`<slot></slot>` : nothing;
  }
}

/** `<atlas-signed-out>…</atlas-signed-out>` renders its children only once the session is known to be signed out. */
export class AtlasSignedOut extends AtlasElement {
  protected override render() {
    return this.atlas.snapshot.status === 'signed_out' ? html`<slot></slot>` : nothing;
  }
}

/** `<atlas-loading>…</atlas-loading>` renders its children until the first boot settles. */
export class AtlasLoading extends AtlasElement {
  protected override render() {
    return this.atlas.snapshot.status === 'loading' ? html`<slot></slot>` : nothing;
  }
}

/**
 * `<atlas-protect permission="org:billing:read">…</atlas-protect>` renders its children when the
 * signed-in session satisfies the condition, else the `fallback` slot. Conditions: `permission`,
 * `require-role` (the `role` attribute is ARIA's). A signed-out visitor, or an unknown state, never passes. This hides UI only; your API
 * is what enforces access.
 */
export class AtlasProtect extends AtlasElement {
  static override properties = {
    permission: { type: String },
    requireRole: { type: String, attribute: 'require-role' },
  };

  declare permission: string | undefined;
  declare requireRole: string | undefined;

  protected override render() {
    const { client, snapshot } = this.atlas;
    const allowed =
      snapshot.status === 'signed_in' &&
      !!client &&
      client.has({
        ...(this.permission ? { permission: this.permission } : {}),
        ...(this.requireRole ? { role: this.requireRole } : {}),
      });
    return allowed ? html`<slot></slot>` : html`<slot name="fallback"></slot>`;
  }
}

/** `<atlas-sign-out-button>Sign out</atlas-sign-out-button>` signs out and fires `atlas-signed-out`. */
export class AtlasSignOutButton extends AtlasElement {
  protected override render() {
    if (this.atlas.snapshot.status !== 'signed_in') return nothing;
    return html`<button type="button" @click=${this.onClick}><slot>Sign out</slot></button>`;
  }

  private readonly onClick = async () => {
    await this.atlas.client?.signOut();
    this.dispatchEvent(new CustomEvent('atlas-signed-out', { bubbles: true, composed: true }));
  };
}

/** Shared by the two widget elements: mounts the Atlas panel into this element's light DOM. */
abstract class AtlasWidgetElement extends AtlasElement {
  static override properties = {
    redirect: { type: String },
    locale: { type: String },
  };

  declare redirect: string | undefined;
  declare locale: string | undefined;
  /** Replace the mount function (tests). */
  mounter?: WidgetMounter;

  protected abstract readonly mode: WidgetMode;
  private cleanup: (() => void) | null = null;
  private mountedFor = '';
  private readonly slotEl = document.createElement('div');

  // The widget draws its own panel, so render into this element, not a shadow root.
  protected override createRenderRoot(): HTMLElement {
    return this;
  }

  protected override updated(): void {
    const { publishableKey, frontendApi } = this.atlas;
    const key = `${publishableKey}|${frontendApi}|${this.redirect ?? ''}|${this.locale ?? ''}`;
    if (!publishableKey || !frontendApi || key === this.mountedFor) return;
    this.cleanup?.();
    this.mountedFor = key;
    // Mount into a child Lit does not manage: writing into `this` would wipe Lit's own render markers.
    if (!this.slotEl.isConnected) this.append(this.slotEl);
    this.cleanup = mountAtlasWidget(this.slotEl, this.mode, {
      publishableKey,
      frontendApi,
      ...(this.redirect ? { redirect: this.redirect } : {}),
      ...(this.locale ? { locale: this.locale } : {}),
      ...(this.mounter ? { mounter: this.mounter } : {}),
    });
  }

  override disconnectedCallback(): void {
    this.cleanup?.();
    this.cleanup = null;
    this.mountedFor = '';
    super.disconnectedCallback();
  }

  protected override render() {
    return nothing;
  }
}

/** `<atlas-sign-in redirect="/app">` mounts the Atlas sign-in panel. */
export class AtlasSignIn extends AtlasWidgetElement {
  protected readonly mode = 'sign-in' as const;
}

/** `<atlas-sign-up redirect="/app">` mounts the Atlas sign-up panel. */
export class AtlasSignUp extends AtlasWidgetElement {
  protected readonly mode = 'sign-up' as const;
}

const TAGS: Array<[string, CustomElementConstructor]> = [
  ['atlas-provider', AtlasProvider],
  ['atlas-signed-in', AtlasSignedIn],
  ['atlas-signed-out', AtlasSignedOut],
  ['atlas-loading', AtlasLoading],
  ['atlas-protect', AtlasProtect],
  ['atlas-sign-out-button', AtlasSignOutButton],
  ['atlas-sign-in', AtlasSignIn],
  ['atlas-sign-up', AtlasSignUp],
];

/** Register every element (idempotent). Importing the package already does this. */
export function defineAtlasElements(): void {
  for (const [tag, ctor] of TAGS) if (!customElements.get(tag)) customElements.define(tag, ctor);
}
