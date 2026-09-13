// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetGoogleIdentityServices } from '@atlasauth/js';
import { AtlasWidget } from './widget';
import { defineElements } from './element';
import type { AppearanceResponse, PublicAppearance } from './appearance';

/**
 * The widget renders in the HOST DOM and drives the real FAPI endpoints through
 * the shared @atlasauth/js flow. These tests mount it against a mocked FAPI and
 * assert what the server would see: provider buttons from the public
 * appearance, a password posted to `attempt_first_factor`, the completion
 * ticket exchanged, and a rejected redirect NEVER honoured.
 */

const BASE_APPEARANCE: PublicAppearance = {
  applicationName: 'Acme',
  logoUrl: null,
  colorPrimary: '#5b5bd6',
  colorBackground: '#ffffff',
  colorText: '#1c1c1f',
  colorAccent: '#5b5bd6',
  colorCard: '#ffffff',
  colorBorder: '#e4e4e9',
  borderRadius: '10px',
  theme: 'light',
  fontStack: 'system-ui',
  layout: 'centered',
  headline: null,
  subheadline: null,
  footer: null,
  providerOrder: [],
  providerHidden: [],
};

const envelope = (providers: string[]): AppearanceResponse => ({
  object: 'appearance',
  appearance: BASE_APPEARANCE,
  providers,
  strategies: {
    password: true,
    emailCode: true,
    emailLink: true,
    passkey: false,
    phoneCode: false,
    siwe: false,
  },
});

interface Recorded {
  method: string;
  path: string;
  search: string;
  body: Record<string, unknown> | undefined;
}

function makeFetch(
  handlers: Record<string, (body: Record<string, unknown> | undefined) => { status?: number; body: unknown }>,
) {
  const calls: Recorded[] = [];
  const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : undefined;
    calls.push({ method, path: url.pathname, search: url.search, body });
    const handler = handlers[`${method} ${url.pathname}`];
    const result = handler
      ? handler(body)
      : { status: 404, body: { errors: [{ code: 'NO_ROUTE', message: 'no route' }] } };
    return new Response(JSON.stringify(result.body ?? {}), {
      status: result.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const flush = async (times = 6): Promise<void> => {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
};

const OPTS = { publishableKey: 'pk_test_1', frontendApi: 'https://accounts.acme.com' };

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('mounting the panel', () => {
  it('renders a social button per enabled provider, in tenant order', async () => {
    const { impl } = makeFetch({
      'GET /v1/appearance': () => ({ body: envelope(['google', 'github']) }),
    });
    const root = document.createElement('div');
    document.body.appendChild(root);

    await new AtlasWidget(root, { ...OPTS, fetchImpl: impl }).mount();

    const buttons = root.querySelectorAll('[data-atlas-provider]');
    expect(buttons.length).toBe(2);
    expect(buttons[0]!.getAttribute('data-atlas-provider')).toBe('google');
    expect(buttons[0]!.textContent).toContain('Continue with Google');
    expect(root.querySelector('input[name="identifier"]')).toBeTruthy();
  });

  it('renders a native-only provider (Google GSI) even when strategies.oauthProviders is empty', async () => {
    // Regression: the platform instance has Google as a NATIVE provider (with a
    // client_id) but an empty `providers` list. The social section must still
    // render its button — gating on `providers.length` alone hid it entirely.
    const { impl } = makeFetch({
      'GET /v1/appearance': () => ({
        body: {
          ...envelope([]),
          native_providers: [{ provider: 'google', client_id: 'gid.apps.googleusercontent.com' }],
        },
      }),
    });
    const root = document.createElement('div');
    document.body.appendChild(root);

    await new AtlasWidget(root, { ...OPTS, fetchImpl: impl }).mount();

    const google = root.querySelector('[data-atlas-provider="google"]');
    expect(google).toBeTruthy();
    expect(google!.textContent).toContain('Continue with Google');
  });

  const mountSocial = async (
    providers: string[],
    appearance?: Record<string, unknown>,
  ): Promise<HTMLElement> => {
    const { impl } = makeFetch({
      'GET /v1/appearance': () => ({ body: envelope(providers) }),
    });
    const root = document.createElement('div');
    document.body.appendChild(root);
    await new AtlasWidget(root, { ...OPTS, appearance, fetchImpl: impl }).mount();
    return root;
  };

  it('defaults social buttons to a "Continue with X" bar with a brand icon', async () => {
    const root = await mountSocial(['github']);
    const btn = root.querySelector('[data-atlas-provider="github"]');
    expect(btn?.getAttribute('data-variant')).toBe('block');
    expect(btn?.textContent).toContain('Continue with GitHub');
    expect(btn?.querySelector('.atlas-embed-social-icon svg')).toBeTruthy();
  });

  it('compact variant shows just the provider name', async () => {
    const root = await mountSocial(['github'], { socialButtons: { variant: 'compact' } });
    const btn = root.querySelector('[data-atlas-provider="github"]');
    expect(btn?.getAttribute('data-variant')).toBe('compact');
    expect(btn?.textContent?.trim()).toBe('GitHub');
    expect(btn?.querySelector('.atlas-embed-social-icon svg')).toBeTruthy();
  });

  it('icon variant is icon-only, with the name as the accessible label', async () => {
    const root = await mountSocial(['github'], { socialButtons: { variant: 'icon' } });
    const btn = root.querySelector('[data-atlas-provider="github"]');
    expect(btn?.getAttribute('data-variant')).toBe('icon');
    expect(btn?.getAttribute('aria-label')).toBe('Continue with GitHub');
    expect(btn?.querySelector('.atlas-embed-social-label')).toBeFalsy();
    expect(btn?.querySelector('.atlas-embed-social-icon svg')).toBeTruthy();
  });

  it('honours a per-provider label override and the layout choice', async () => {
    const root = await mountSocial(['github'], {
      socialButtons: { layout: 'carousel', labels: { github: 'Use GitHub' } },
    });
    expect(root.querySelector('.atlas-embed-social')?.getAttribute('data-layout')).toBe('carousel');
    expect(root.querySelector('[data-atlas-provider="github"]')?.textContent).toContain('Use GitHub');
  });

  it('carries the publishable key in the query string (so CORS preflight can resolve the instance)', async () => {
    const { impl, calls } = makeFetch({
      'GET /v1/appearance': () => ({ body: envelope([]) }),
    });
    const root = document.createElement('div');
    document.body.appendChild(root);

    await new AtlasWidget(root, { ...OPTS, fetchImpl: impl }).mount();

    const appearanceCall = calls.find((c) => c.path === '/v1/appearance');
    expect(appearanceCall?.search).toContain('publishable_key=pk_test_1');
  });
});

describe('§6.5 per-provider sign-in / sign-up scoping', () => {
  const scoped = (
    providers: string[],
    scopes: Record<string, { sign_in: boolean; sign_up: boolean }>,
  ): AppearanceResponse => ({ ...envelope(providers), provider_scopes: scopes });

  it('hides a sign-in-only provider on the sign-up screen', async () => {
    const { impl } = makeFetch({
      'GET /v1/appearance': () => ({
        body: scoped(['google', 'github'], { github: { sign_in: true, sign_up: false } }),
      }),
    });
    const root = document.createElement('div');
    document.body.appendChild(root);

    await new AtlasWidget(root, { ...OPTS, mode: 'sign-up', fetchImpl: impl }).mount();

    expect(root.querySelector('[data-atlas-provider="github"]')).toBeNull();
    expect(root.querySelector('[data-atlas-provider="google"]')).toBeTruthy();
  });

  it('shows that same provider on the sign-in screen', async () => {
    const { impl } = makeFetch({
      'GET /v1/appearance': () => ({
        body: scoped(['google', 'github'], { github: { sign_in: true, sign_up: false } }),
      }),
    });
    const root = document.createElement('div');
    document.body.appendChild(root);

    await new AtlasWidget(root, { ...OPTS, mode: 'sign-in', fetchImpl: impl }).mount();

    expect(root.querySelector('[data-atlas-provider="github"]')).toBeTruthy();
  });
});

describe('Sign in with Atlas (preset OIDC connection)', () => {
  const withAtlas = (
    providers: string[],
    signInWithAtlas: { enabled: boolean; connection_id?: string },
  ): AppearanceResponse => ({ ...envelope(providers), sign_in_with_atlas: signInWithAtlas });

  it('renders a "Sign in with Atlas" button when enabled, even with no OAuth providers', async () => {
    const { impl } = makeFetch({
      'GET /v1/appearance': () => ({
        body: withAtlas([], { enabled: true, connection_id: 'ssocn_1' }),
      }),
    });
    const root = document.createElement('div');
    document.body.appendChild(root);

    await new AtlasWidget(root, { ...OPTS, fetchImpl: impl }).mount();

    const btn = root.querySelector('[data-atlas-provider="atlas"]');
    expect(btn).toBeTruthy();
    // A first-class social tile: it takes the sibling copy ("Continue with
    // Atlas" in the default block variant), not a bespoke banner label.
    expect(btn?.textContent).toContain('Atlas');
    expect(btn?.querySelector('.atlas-embed-social-icon svg')).toBeTruthy();
    expect(root.querySelector('.atlas-embed-social')).toBeTruthy();
  });

  it('clicking it opens a GSI-style popup, marks the redirect, and exchanges the handoff ticket', async () => {
    const { impl, calls } = makeFetch({
      'GET /v1/appearance': () => ({
        body: withAtlas([], { enabled: true, connection_id: 'ssocn_1' }),
      }),
      'POST /v1/client/sign_ins/sso': () => ({
        body: { authorization_url: 'https://id.atlas.test/authorize?x=1' },
      }),
      'POST /v1/client/tickets/exchange': () => ({ body: { ok: true } }),
    });
    const root = document.createElement('div');
    document.body.appendChild(root);
    const view = root.ownerDocument!.defaultView as Window & typeof globalThis;
    const popup = { location: { assign: vi.fn() }, close: vi.fn() };
    const openSpy = vi.fn(() => popup);
    (view as unknown as { open: unknown }).open = openSpy;

    await new AtlasWidget(root, { ...OPTS, fetchImpl: impl }).mount();
    const btn = root.querySelector<HTMLButtonElement>('[data-atlas-provider="atlas"]');
    btn?.click();
    await flush();

    // A popup opened and was navigated to the authorize URL — the host page is untouched.
    expect(openSpy).toHaveBeenCalled();
    expect(popup.location.assign).toHaveBeenCalledWith('https://id.atlas.test/authorize?x=1');
    // The start carried the popup marker so the callback hands back via postMessage.
    const ssoCall = calls.find((c) => c.path === '/v1/client/sign_ins/sso');
    expect(ssoCall?.body?.connection_id).toBe('ssocn_1');
    expect(String(ssoCall?.body?.redirect_url)).toContain('__atlas_display=popup');

    // The handoff posts the ticket from the FAPI origin; the widget exchanges it.
    view.dispatchEvent(
      new MessageEvent('message', {
        origin: 'https://accounts.acme.com',
        data: { type: 'atlas-sso', status: 'complete', attempt_id: 'sia_9', ticket: 'tkt_9' },
      }),
    );
    await flush();
    const exch = calls.find((c) => c.path === '/v1/client/tickets/exchange');
    expect(exch?.body?.attempt_id).toBe('sia_9');
    expect(exch?.body?.ticket).toBe('tkt_9');
    expect(popup.close).toHaveBeenCalled();
  });

  it('ignores a handoff message from a foreign origin (postMessage spoofing guard)', async () => {
    const { impl, calls } = makeFetch({
      'GET /v1/appearance': () => ({
        body: withAtlas([], { enabled: true, connection_id: 'ssocn_1' }),
      }),
      'POST /v1/client/sign_ins/sso': () => ({
        body: { authorization_url: 'https://id.atlas.test/authorize?x=1' },
      }),
      'POST /v1/client/tickets/exchange': () => ({ body: { ok: true } }),
    });
    const root = document.createElement('div');
    document.body.appendChild(root);
    const view = root.ownerDocument!.defaultView as Window & typeof globalThis;
    const popup = { location: { assign: vi.fn() }, close: vi.fn() };
    (view as unknown as { open: unknown }).open = vi.fn(() => popup);

    await new AtlasWidget(root, { ...OPTS, fetchImpl: impl }).mount();
    root.querySelector<HTMLButtonElement>('[data-atlas-provider="atlas"]')?.click();
    await flush();

    // A ticket posted from an ATTACKER origin must be ignored — no exchange.
    view.dispatchEvent(
      new MessageEvent('message', {
        origin: 'https://evil.example.com',
        data: { type: 'atlas-sso', status: 'complete', attempt_id: 'sia_x', ticket: 'tkt_x' },
      }),
    );
    await flush();
    expect(calls.find((c) => c.path === '/v1/client/tickets/exchange')).toBeUndefined();
  });

  it('falls back to a full-page redirect when the popup is blocked', async () => {
    const { impl, calls } = makeFetch({
      'GET /v1/appearance': () => ({
        body: withAtlas([], { enabled: true, connection_id: 'ssocn_1' }),
      }),
      'POST /v1/client/sign_ins/sso': () => ({
        body: { authorization_url: 'https://id.atlas.test/authorize?x=1' },
      }),
    });
    const root = document.createElement('div');
    document.body.appendChild(root);
    const view = root.ownerDocument!.defaultView as Window & typeof globalThis;
    (view as unknown as { open: unknown }).open = vi.fn(() => null); // popup blocked
    const assign = vi.fn();
    vi.stubGlobal('location', { href: 'https://app.acme.com/login', origin: 'https://app.acme.com', assign });

    await new AtlasWidget(root, { ...OPTS, fetchImpl: impl }).mount();
    root.querySelector<HTMLButtonElement>('[data-atlas-provider="atlas"]')?.click();
    await flush();

    // Fell back to the redirect flow: navigate the main window, no popup marker.
    expect(assign).toHaveBeenCalledWith('https://id.atlas.test/authorize?x=1');
    const ssoCall = calls.find((c) => c.path === '/v1/client/sign_ins/sso');
    expect(String(ssoCall?.body?.redirect_url)).not.toContain('__atlas_display=popup');
  });

  it('renders no Atlas button when disabled', async () => {
    const { impl } = makeFetch({
      'GET /v1/appearance': () => ({ body: withAtlas(['google'], { enabled: false }) }),
    });
    const root = document.createElement('div');
    document.body.appendChild(root);

    await new AtlasWidget(root, { ...OPTS, fetchImpl: impl }).mount();

    expect(root.querySelector('[data-atlas-provider="atlas"]')).toBeNull();
  });
});

describe('driving the password sign-in flow', () => {
  it('posts a password to attempt_first_factor and exchanges the completion ticket', async () => {
    const { impl, calls } = makeFetch({
      'GET /v1/appearance': () => ({ body: envelope([]) }),
      'POST /v1/client/sign_ins': () => ({ status: 201, body: { id: 'sia_1', status: 'needs_first_factor' } }),
      'POST /v1/client/sign_ins/sia_1/attempt_first_factor': () => ({
        body: { id: 'sia_1', status: 'complete', ticket: 'tkt_1' },
      }),
      'POST /v1/client/tickets/exchange': () => ({ body: {} }),
    });
    const root = document.createElement('div');
    document.body.appendChild(root);
    const events: Array<Record<string, unknown>> = [];
    root.addEventListener('atlas:complete', (e) => events.push((e as CustomEvent).detail));

    await new AtlasWidget(root, { ...OPTS, fetchImpl: impl }).mount();

    // Identifier step.
    (root.querySelector('input[name="identifier"]') as HTMLInputElement).value = 'ada@example.com';
    root.querySelector('form')!.dispatchEvent(new Event('submit'));
    await flush();

    // Password step now rendered.
    const pw = root.querySelector('input[name="password"]') as HTMLInputElement;
    expect(pw).toBeTruthy();
    pw.value = 'hunter2';
    root.querySelector('form')!.dispatchEvent(new Event('submit'));
    await flush();

    const attempt = calls.find((c) => c.path.endsWith('/attempt_first_factor'));
    expect(attempt?.body).toEqual({ strategy: 'password', password: 'hunter2' });
    // The credential never leaked into the wrong endpoint.
    expect(calls.some((c) => c.path === '/v1/client/tickets/exchange')).toBe(true);
    expect(events).toHaveLength(1);
  });

  it('shows a "Remember me" checkbox only when the instance enables it, and unticking it sends remember:false to the exchange', async () => {
    const { impl, calls } = makeFetch({
      'GET /v1/appearance': () => ({ body: { ...envelope([]), rememberMe: true } }),
      'POST /v1/client/sign_ins': () => ({ status: 201, body: { id: 'sia_r', status: 'needs_first_factor' } }),
      'POST /v1/client/sign_ins/sia_r/attempt_first_factor': () => ({
        body: { id: 'sia_r', status: 'complete', ticket: 'tkt_r' },
      }),
      'POST /v1/client/tickets/exchange': () => ({ body: {} }),
    });
    const root = document.createElement('div');
    document.body.appendChild(root);
    await new AtlasWidget(root, { ...OPTS, fetchImpl: impl }).mount();

    // On the single-screen sign-in box the checkbox is present and ticked by default.
    const box = root.querySelector('.atlas-embed-remember-check') as HTMLInputElement;
    expect(box).toBeTruthy();
    expect(box.checked).toBe(true);
    // The user opts out of a persistent session.
    box.checked = false;
    box.dispatchEvent(new Event('change'));

    (root.querySelector('input[name="identifier"]') as HTMLInputElement).value = 'ada@example.com';
    (root.querySelector('input[name="password"]') as HTMLInputElement).value = 'hunter2';
    root.querySelector('form')!.dispatchEvent(new Event('submit'));
    await flush();

    const exchange = calls.find((c) => c.path === '/v1/client/tickets/exchange');
    expect(exchange?.body).toMatchObject({ remember: false });
  });

  it('omits the "Remember me" checkbox when the instance has it disabled', async () => {
    const { impl } = makeFetch({
      'GET /v1/appearance': () => ({ body: envelope([]) }),
    });
    const root = document.createElement('div');
    document.body.appendChild(root);
    await new AtlasWidget(root, { ...OPTS, fetchImpl: impl }).mount();
    expect(root.querySelector('.atlas-embed-remember-check')).toBeNull();
  });

  it('preview mode completes the flow but never exchanges the ticket (no session cookie)', async () => {
    const { impl, calls } = makeFetch({
      'GET /v1/appearance': () => ({ body: envelope([]) }),
      'POST /v1/client/sign_ins': () => ({ status: 201, body: { id: 'sia_p', status: 'needs_first_factor' } }),
      'POST /v1/client/sign_ins/sia_p/attempt_first_factor': () => ({
        body: { id: 'sia_p', status: 'complete', ticket: 'tkt_p' },
      }),
      'POST /v1/client/tickets/exchange': () => ({ body: {} }),
    });
    const root = document.createElement('div');
    document.body.appendChild(root);
    const events: Array<Record<string, unknown>> = [];
    root.addEventListener('atlas:complete', (e) => events.push((e as CustomEvent).detail));

    await new AtlasWidget(root, { ...OPTS, preview: true, fetchImpl: impl }).mount();

    (root.querySelector('input[name="identifier"]') as HTMLInputElement).value = 'ada@example.com';
    root.querySelector('form')!.dispatchEvent(new Event('submit'));
    await flush();
    const pw = root.querySelector('input[name="password"]') as HTMLInputElement;
    pw.value = 'hunter2';
    root.querySelector('form')!.dispatchEvent(new Event('submit'));
    await flush();

    // The flow ran (first factor posted) and completed…
    expect(calls.some((c) => c.path.endsWith('/attempt_first_factor'))).toBe(true);
    expect(events).toHaveLength(1);
    // …but the ticket was NEVER exchanged, so no session cookie is set.
    expect(calls.some((c) => c.path === '/v1/client/tickets/exchange')).toBe(false);
    // A preview note is shown instead of a redirect / "signed in".
    expect(root.textContent).toContain('preview');
  });

  it('starts OAuth by navigating to the provider authorization URL', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { origin: 'https://app.customer.com', href: 'https://app.customer.com/login', assign });
    const { impl, calls } = makeFetch({
      'GET /v1/appearance': () => ({ body: envelope(['google']) }),
      'POST /v1/client/sign_ins/oauth': () => ({
        status: 201,
        body: { id: 'sia_2', status: 'needs_oauth_callback', authorization_url: 'https://accounts.google.com/o/oauth2/v2/auth?x=1' },
      }),
    });
    const root = document.createElement('div');
    document.body.appendChild(root);

    await new AtlasWidget(root, { ...OPTS, fetchImpl: impl }).mount();
    (root.querySelector('[data-atlas-provider="google"]') as HTMLButtonElement).click();
    await flush();

    const start = calls.find((c) => c.path === '/v1/client/sign_ins/oauth');
    expect((start?.body as { provider?: string }).provider).toBe('google');
  });

  it('Bluesky collects a handle first, then starts OAuth with the identifier', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { origin: 'https://app.customer.com', href: 'https://app.customer.com/login', search: '', assign });
    const { impl, calls } = makeFetch({
      'GET /v1/appearance': () => ({ body: envelope(['bluesky']) }),
      'POST /v1/client/sign_ins/oauth': () => ({
        status: 201,
        body: { id: 'sia_bsky', status: 'needs_oauth_callback', authorization_url: 'https://pds.example/authorize?x=1' },
      }),
    });
    const root = document.createElement('div');
    document.body.appendChild(root);

    await new AtlasWidget(root, { ...OPTS, fetchImpl: impl }).mount();

    // Clicking Bluesky shows the handle prompt, NOT an immediate OAuth start.
    (root.querySelector('[data-atlas-provider="bluesky"]') as HTMLButtonElement).click();
    await flush();
    expect(calls.find((c) => c.path === '/v1/client/sign_ins/oauth')).toBeUndefined();
    const input = root.querySelector('input[name="identifier"]') as HTMLInputElement;
    expect(input).toBeTruthy();

    // Entering a handle and submitting starts OAuth WITH the identifier.
    input.value = 'alice.bsky.social';
    root.querySelector('form')!.dispatchEvent(new Event('submit'));
    await flush();

    const start = calls.find((c) => c.path === '/v1/client/sign_ins/oauth');
    expect(start?.body).toMatchObject({ provider: 'bluesky', identifier: 'alice.bsky.social' });
    expect(assign).toHaveBeenCalledWith('https://pds.example/authorize?x=1');
  });

  it('Bluesky handle prompt rejects an empty handle without calling the server', async () => {
    vi.stubGlobal('location', { origin: 'https://app.customer.com', href: 'https://app.customer.com/login', search: '', assign: vi.fn() });
    const { impl, calls } = makeFetch({
      'GET /v1/appearance': () => ({ body: envelope(['bluesky']) }),
    });
    const root = document.createElement('div');
    document.body.appendChild(root);
    await new AtlasWidget(root, { ...OPTS, fetchImpl: impl }).mount();

    (root.querySelector('[data-atlas-provider="bluesky"]') as HTMLButtonElement).click();
    await flush();
    root.querySelector('form')!.dispatchEvent(new Event('submit'));
    await flush();

    expect(calls.find((c) => c.path === '/v1/client/sign_ins/oauth')).toBeUndefined();
    expect(root.querySelector('.atlas-embed-form-error')?.textContent).toContain('handle');
  });
});

describe('the redirect gate', () => {
  it('does NOT navigate to a rejected cross-origin http redirect — it emits instead', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { origin: 'https://app.customer.com', href: 'https://app.customer.com/login', search: '', assign });
    const { impl } = makeFetch({
      'GET /v1/appearance': () => ({ body: envelope([]) }),
      'POST /v1/client/sign_ins': () => ({ status: 201, body: { id: 'sia_1', status: 'complete', ticket: 'tkt_1' } }),
      'POST /v1/client/tickets/exchange': () => ({ body: {} }),
    });
    const root = document.createElement('div');
    document.body.appendChild(root);
    const events: Array<Record<string, unknown>> = [];
    root.addEventListener('atlas:complete', (e) => events.push((e as CustomEvent).detail));

    await new AtlasWidget(root, { ...OPTS, redirect: 'http://evil.example.com', fetchImpl: impl }).mount();
    (root.querySelector('input[name="identifier"]') as HTMLInputElement).value = 'ada@example.com';
    root.querySelector('form')!.dispatchEvent(new Event('submit'));
    await flush();

    expect(assign).not.toHaveBeenCalled();
    expect(events).toHaveLength(1);
    expect(events[0]!.redirected).toBe(false);
  });
});

describe('the custom elements', () => {
  it('registers <atlas-sign-in> and mounts on connect', async () => {
    const { impl } = makeFetch({ 'GET /v1/appearance': () => ({ body: envelope([]) }) });
    vi.stubGlobal('fetch', impl);
    defineElements();
    expect(customElements.get('atlas-sign-in')).toBeTruthy();

    const el = document.createElement('atlas-sign-in');
    el.setAttribute('data-atlas-key', 'pk_test_1');
    el.setAttribute('data-atlas-fapi', 'https://accounts.acme.com');
    document.body.appendChild(el);
    await flush();

    expect(el.querySelector('.atlas-embed-card')).toBeTruthy();
  });

  it('shows guidance instead of a blank box when required config is missing', () => {
    defineElements();
    const el = document.createElement('atlas-sign-up');
    document.body.appendChild(el);
    expect(el.textContent).toContain('data-atlas-key');
  });
});

describe('native Google (GSI)', () => {
  afterEach(() => {
    resetGoogleIdentityServices();
    delete (window as unknown as { google?: unknown }).google;
  });

  it('shows OUR uniform button for google with Google’s real button invisibly overlaid', async () => {
    // Stub GSI so the loader resolves and renderButton actually fires.
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    document.head.appendChild(s);
    let renderedInto: HTMLElement | null = null;
    let clientId: string | undefined;
    (window as unknown as { google: unknown }).google = {
      accounts: {
        id: {
          initialize: (cfg: { client_id?: string }) => {
            clientId = cfg.client_id;
          },
          prompt: () => {},
          renderButton: (parent: HTMLElement) => {
            renderedInto = parent;
          },
          cancel: () => {},
        },
      },
    };
    resetGoogleIdentityServices();

    const withNative: AppearanceResponse = {
      ...envelope(['google', 'github']),
      native_providers: [{ provider: 'google', client_id: 'gid-123.apps.googleusercontent.com' }],
    };
    const { impl } = makeFetch({ 'GET /v1/appearance': () => ({ body: withNative }) });
    const root = document.createElement('div');
    document.body.appendChild(root);
    await new AtlasWidget(root, { ...OPTS, fetchImpl: impl }).mount();
    await flush();

    const google = root.querySelector('[data-atlas-provider="google"]') as HTMLElement | null;
    const github = root.querySelector('[data-atlas-provider="github"]');
    // Google wears OUR uniform button styling (not a Google-styled container) —
    // and carries our own label, initialised with the public client_id.
    expect(google?.className).toContain('atlas-embed-social-button');
    expect(google?.textContent).toContain('Continue with');
    expect(clientId).toBe('gid-123.apps.googleusercontent.com');
    expect(github?.tagName).toBe('BUTTON');
    // Google's REAL button is rendered into an INVISIBLE overlay INSIDE our button.
    expect(renderedInto).toBeTruthy();
    expect(google?.contains(renderedInto)).toBe(true);
    expect((renderedInto as unknown as HTMLElement).style.opacity).toBe('0');
  });

  it('falls back to a redirect button for google when no native client_id is offered', async () => {
    const { impl } = makeFetch({ 'GET /v1/appearance': () => ({ body: envelope(['google']) }) });
    const root = document.createElement('div');
    document.body.appendChild(root);
    await new AtlasWidget(root, { ...OPTS, fetchImpl: impl }).mount();
    await flush();
    const google = root.querySelector('[data-atlas-provider="google"]');
    expect(google?.tagName).toBe('BUTTON');
    expect(google?.textContent).toContain('Continue with');
  });
});

describe('§5 sign-up with configurable fields', () => {
  const SIGN_UP_FIELDS = [
    { key: 'first_name', label: 'First name', type: 'text' as const, required: true, placeholder: null, options: [], builtin: true },
    { key: 'company', label: 'Company', type: 'text' as const, required: false, placeholder: null, options: [], builtin: false },
  ];

  it('renders the configured fields + email + password and posts them to sign_ups', async () => {
    let posted: Record<string, unknown> | undefined;
    const { impl } = makeFetch({
      'GET /v1/appearance': () => ({
        body: { ...envelope([]), appearance: { ...BASE_APPEARANCE, signUpFields: SIGN_UP_FIELDS } },
      }),
      'POST /v1/client/sign_ups': (body) => {
        posted = body;
        return { status: 201, body: { object: 'sign_up_attempt', id: 'sua_1', status: 'needs_email_verification' } };
      },
    });
    const root = document.createElement('div');
    document.body.appendChild(root);
    await new AtlasWidget(root, { ...OPTS, mode: 'sign-up', fetchImpl: impl }).mount();
    await flush();

    const val = (name: string, v: string) => {
      const input = root.querySelector(`[name="${name}"]`) as HTMLInputElement;
      expect(input).toBeTruthy();
      input.value = v;
    };
    val('first_name', 'Ada');
    val('company', 'Acme');
    val('identifier', 'ada@example.com');
    val('password', 'sup3rSecretPw!');

    root.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flush();

    expect(posted).toEqual({
      email: 'ada@example.com',
      password: 'sup3rSecretPw!',
      fields: { first_name: 'Ada', company: 'Acme' },
      // §5.1 no consent gate configured → consent is implicit (true).
      consent: true,
    });
    // The server asked for email verification → the code step is now shown.
    expect(root.querySelector('[name="code"]')).toBeTruthy();
  });

  it('§5 renders the sign-up captcha and attaches its token to sign_ups', async () => {
    // A fake Turnstile that solves immediately.
    (window as unknown as Record<string, unknown>).turnstile = {
      render: (_el: HTMLElement, opts: { callback: (t: string) => void }) => {
        setTimeout(() => opts.callback('ts-signup-token'), 0);
        return 'w';
      },
    };
    let posted: Record<string, unknown> | undefined;
    const { impl } = makeFetch({
      'GET /v1/appearance': () => ({
        body: {
          ...envelope([]),
          captchaFlows: {
            signUp: { enabled: true, provider: 'turnstile', siteKey: 'sk', widget: 'managed' },
          },
        },
      }),
      'POST /v1/client/sign_ups': (body) => {
        posted = body;
        return { status: 201, body: { object: 'sign_up_attempt', id: 'sua_2', status: 'needs_email_verification' } };
      },
    });
    const root = document.createElement('div');
    document.body.appendChild(root);
    await new AtlasWidget(root, { ...OPTS, mode: 'sign-up', fetchImpl: impl }).mount();
    await flush();

    (root.querySelector('[name="identifier"]') as HTMLInputElement).value = 'ada@example.com';
    (root.querySelector('[name="password"]') as HTMLInputElement).value = 'sup3rSecretPw!';
    root.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flush();

    expect(posted?.captcha_token).toBe('ts-signup-token');
    delete (window as unknown as Record<string, unknown>).turnstile;
  });
});

describe('§5 richer sign-up field types', () => {
  const FIELDS = [
    { key: 'role', label: 'Role', type: 'radio' as const, required: false, placeholder: null, options: ['Dev', 'Design'], builtin: false },
    { key: 'stack', label: 'Stack', type: 'multiselect' as const, required: false, placeholder: null, options: ['TS', 'Go', 'Rust'], builtin: false },
    { key: 'bio', label: 'Bio', type: 'textarea' as const, required: false, placeholder: null, options: [], builtin: false },
  ];

  it('collects radio (one), multi-select (many joined) and textarea values', async () => {
    let posted: Record<string, unknown> | undefined;
    const { impl } = makeFetch({
      'GET /v1/appearance': () => ({
        body: { ...envelope([]), appearance: { ...BASE_APPEARANCE, signUpFields: FIELDS } },
      }),
      'POST /v1/client/sign_ups': (body) => {
        posted = body;
        return { status: 201, body: { object: 'sign_up_attempt', id: 's1', status: 'needs_email_verification' } };
      },
    });
    const root = document.createElement('div');
    document.body.appendChild(root);
    await new AtlasWidget(root, { ...OPTS, mode: 'sign-up', fetchImpl: impl }).mount();
    await flush();

    (root.querySelector('input[type="radio"][value="Design"]') as HTMLInputElement).checked = true;
    (root.querySelector('input[type="checkbox"][value="TS"]') as HTMLInputElement).checked = true;
    (root.querySelector('input[type="checkbox"][value="Rust"]') as HTMLInputElement).checked = true;
    (root.querySelector('textarea[name="bio"]') as HTMLTextAreaElement).value = 'hello';
    (root.querySelector('[name="identifier"]') as HTMLInputElement).value = 'a@b.co';
    (root.querySelector('[name="password"]') as HTMLInputElement).value = 'sup3rSecretPw!';

    root.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flush();

    expect((posted as { fields: unknown }).fields).toEqual({
      role: 'Design',
      stack: 'TS, Rust',
      bio: 'hello',
    });
  });
});

describe('single-screen sign-in (email + password together)', () => {
  it('shows both fields and auto-submits the first factor in one click', async () => {
    const calls: string[] = [];
    const { impl } = makeFetch({
      'GET /v1/appearance': () => ({ body: envelope([]) }), // strategies.password = true
      'POST /v1/client/sign_ins': () => {
        calls.push('sign_ins');
        return { body: { object: 'sign_in_attempt', id: 'sia_1', status: 'needs_first_factor' } };
      },
      'POST /v1/client/sign_ins/sia_1/attempt_first_factor': (body) => {
        calls.push('first_factor:' + JSON.stringify(body));
        return { body: { object: 'sign_in_attempt', id: 'sia_1', status: 'complete', ticket: 'tkt_1' } };
      },
      'POST /v1/client/tickets/exchange': () => {
        calls.push('exchange');
        return { body: {} };
      },
    });
    const root = document.createElement('div');
    document.body.appendChild(root);
    let completed = false;
    root.addEventListener('atlas:complete', () => { completed = true; });

    await new AtlasWidget(root, { ...OPTS, mode: 'sign-in', fetchImpl: impl }).mount();
    await flush();

    const emailInput = root.querySelector('input[name="identifier"]') as HTMLInputElement;
    const pwInput = root.querySelector('input[name="password"]') as HTMLInputElement;
    expect(emailInput).toBeTruthy();
    expect(pwInput).toBeTruthy(); // password on the FIRST screen

    emailInput.value = 'a@b.co';
    pwInput.value = 'secret';
    root.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flush();

    expect(calls[0]).toBe('sign_ins');
    expect(calls[1]).toContain('first_factor');
    expect(calls[1]).toContain('"password":"secret"');
    expect(completed).toBe(true);
  });
});

describe('social button search (socialButtons.search)', () => {
  const MANY = ['google', 'github', 'gitlab', 'slack', 'discord', 'spotify', 'twitch', 'dropbox', 'box', 'zoom'];

  const envelopeWith = (providers: string[], search: 'auto' | 'always' | 'never'): AppearanceResponse => ({
    ...envelope(providers),
    appearance: { ...BASE_APPEARANCE, socialButtons: { search } },
  });

  const mountWith = async (providers: string[], search: 'auto' | 'always' | 'never') => {
    const { impl } = makeFetch({ 'GET /v1/appearance': () => ({ body: envelopeWith(providers, search) }) });
    const root = document.createElement('div');
    document.body.appendChild(root);
    await new AtlasWidget(root, { ...OPTS, fetchImpl: impl }).mount();
    await flush();
    return root;
  };

  it('shows the search box for a long list under "auto" (>8 providers)', async () => {
    const root = await mountWith(MANY, 'auto');
    expect(root.querySelector('.atlas-embed-social-search')).toBeTruthy();
  });

  it('hides the search box for a short list under "auto" (<=8 providers)', async () => {
    const root = await mountWith(['google', 'github', 'gitlab'], 'auto');
    expect(root.querySelector('.atlas-embed-social-search')).toBeNull();
  });

  it('"always" shows the box even for a short list; "never" hides it for a long one', async () => {
    const always = await mountWith(['google', 'github'], 'always');
    expect(always.querySelector('.atlas-embed-social-search')).toBeTruthy();
    const never = await mountWith(MANY, 'never');
    expect(never.querySelector('.atlas-embed-social-search')).toBeNull();
  });

  it('filters the buttons by provider name as the user types', async () => {
    const root = await mountWith(MANY, 'always');
    const input = root.querySelector('.atlas-embed-social-search') as HTMLInputElement;
    const visible = () =>
      Array.from(root.querySelectorAll('[data-atlas-provider]')).filter((b) => !b.hasAttribute('hidden'));

    // All visible before typing.
    expect(visible().length).toBe(MANY.length);

    // "git" narrows to github + gitlab.
    input.value = 'git';
    input.dispatchEvent(new Event('input'));
    const keys = visible().map((b) => b.getAttribute('data-atlas-provider')).sort();
    expect(keys).toEqual(['github', 'gitlab']);

    // A no-match query hides everything and shows the empty note.
    input.value = 'zzzzz';
    input.dispatchEvent(new Event('input'));
    expect(visible().length).toBe(0);
    expect(root.querySelector('.atlas-embed-social-empty')?.hasAttribute('hidden')).toBe(false);

    // Clearing restores all.
    input.value = '';
    input.dispatchEvent(new Event('input'));
    expect(visible().length).toBe(MANY.length);
  });
});

describe('carousel layout scroll controls', () => {
  const envCarousel = (providers: string[]): AppearanceResponse => ({
    ...envelope(providers),
    appearance: { ...BASE_APPEARANCE, socialButtons: { layout: 'carousel' } },
  });

  it('wraps the carousel row in prev/next controls, keeping the buttons', async () => {
    const { impl } = makeFetch({
      'GET /v1/appearance': () => ({ body: envCarousel(['google', 'github', 'gitlab']) }),
    });
    const root = document.createElement('div');
    document.body.appendChild(root);
    await new AtlasWidget(root, { ...OPTS, fetchImpl: impl }).mount();
    await flush();

    const shell = root.querySelector('.atlas-embed-carousel');
    expect(shell, 'a carousel gets a control shell').toBeTruthy();
    expect(root.querySelectorAll('.atlas-embed-carousel-nav').length, 'prev + next').toBe(2);
    // The scroll row lives inside the shell, and the buttons inside the row.
    expect(shell!.querySelector('.atlas-embed-social[data-layout="carousel"]')).toBeTruthy();
    expect(root.querySelectorAll('[data-atlas-provider]').length).toBe(3);
  });

  it('non-carousel layouts get no scroll controls', async () => {
    const { impl } = makeFetch({
      'GET /v1/appearance': () => ({ body: envelope(['google', 'github']) }),
    });
    const root = document.createElement('div');
    document.body.appendChild(root);
    await new AtlasWidget(root, { ...OPTS, fetchImpl: impl }).mount();
    await flush();
    expect(root.querySelector('.atlas-embed-carousel')).toBeNull();
  });
});

describe('verification code step (segmented input + continuation context)', () => {
  // Drive the widget from the identifier step to the email-code step.
  const mountAtCode = async (over: Partial<AppearanceResponse['appearance']> = {}) => {
    const { impl } = makeFetch({
      'GET /v1/appearance': () => ({ body: { ...envelope([]), appearance: { ...BASE_APPEARANCE, ...over } } }),
      'POST /v1/client/sign_ins': () => ({ status: 201, body: { id: 'sia_x', status: 'needs_email_verification' } }),
      // Any auto-submit of a full code is a harmless no-op that stays on the step.
      'POST /v1/client/sign_ups/sia_x/attempt_verification': () => ({ body: { id: 'sia_x', status: 'needs_email_verification' } }),
    });
    const root = document.createElement('div');
    document.body.appendChild(root);
    await new AtlasWidget(root, { ...OPTS, fetchImpl: impl }).mount();
    await flush();
    (root.querySelector('input[name="identifier"]') as HTMLInputElement).value = 'ada@example.com';
    root.querySelector('form')!.dispatchEvent(new Event('submit'));
    await flush();
    return root;
  };

  const boxes = (root: HTMLElement) =>
    Array.from(root.querySelectorAll('.atlas-embed-code-box')) as HTMLInputElement[];
  const type = (box: HTMLInputElement, v: string) => {
    box.value = v;
    box.dispatchEvent(new Event('input', { bubbles: true }));
  };

  it('renders 6 boxes + a hidden code field, the email context, and a back link', async () => {
    const root = await mountAtCode();
    expect(boxes(root).length).toBe(6);
    const hidden = root.querySelector('input[name="code"]') as HTMLInputElement;
    expect(hidden.getAttribute('type')).toBe('hidden');
    expect(root.querySelector('.atlas-embed-step-context')!.textContent).toContain('ada@example.com');
    expect(root.querySelector('.atlas-embed-step-back')).toBeTruthy();
  });

  it('assembles the code across boxes and auto-advances focus', async () => {
    const root = await mountAtCode();
    const bs = boxes(root);
    type(bs[0]!, '1');
    type(bs[1]!, '2');
    type(bs[2]!, '3');
    const hidden = root.querySelector('input[name="code"]') as HTMLInputElement;
    expect(hidden.value).toBe('123');
    // The most recent input advanced focus to the next box.
    expect(root.ownerDocument.activeElement).toBe(bs[3]);
  });

  it('distributes a pasted code across the boxes', async () => {
    const root = await mountAtCode();
    const bs = boxes(root);
    const event = new Event('paste', { bubbles: true }) as unknown as ClipboardEvent;
    // 5 digits: fills without hitting the 6-digit auto-submit (which would re-render).
    Object.defineProperty(event, 'clipboardData', { value: { getData: () => '65432' } });
    bs[0]!.dispatchEvent(event);
    expect((root.querySelector('input[name="code"]') as HTMLInputElement).value).toBe('65432');
    expect(bs[0]!.value).toBe('6');
    expect(bs[4]!.value).toBe('2');
  });

  it('auto-submits once the 6th digit lands', async () => {
    const { impl, calls } = makeFetch({
      'GET /v1/appearance': () => ({ body: { ...envelope([]), appearance: BASE_APPEARANCE } }),
      'POST /v1/client/sign_ins': () => ({ status: 201, body: { id: 'sia_x', status: 'needs_email_verification' } }),
      // needs_email_verification → the SDK verifies via the sign-up verify path.
      'POST /v1/client/sign_ups/sia_x/attempt_verification': () => ({ body: { id: 'sia_x', status: 'complete', ticket: 'tk' } }),
      'POST /v1/client/tickets/exchange': () => ({ body: { object: 'session' } }),
    });
    const root = document.createElement('div');
    document.body.appendChild(root);
    await new AtlasWidget(root, { ...OPTS, fetchImpl: impl }).mount();
    await flush();
    (root.querySelector('input[name="identifier"]') as HTMLInputElement).value = 'ada@example.com';
    root.querySelector('form')!.dispatchEvent(new Event('submit'));
    await flush();

    const bs = boxes(root);
    for (let i = 0; i < 6; i++) type(bs[i]!, String(i + 1));
    await flush();
    // A full code submitted itself — the code reached the verify endpoint.
    const verify = calls.find((c) => c.path.endsWith('/attempt_verification'));
    expect(verify, 'a full code auto-submits').toBeTruthy();
    expect(verify!.body?.code).toBe('123456');
  });

  it('honours codeInput:"single" — one plain field, no boxes', async () => {
    const root = await mountAtCode({ codeInput: 'single' });
    expect(boxes(root).length).toBe(0);
    const input = root.querySelector('input[name="code"]') as HTMLInputElement;
    expect(input.getAttribute('type')).toBe('text');
  });
});

describe('two-factor step backup-code fallback', () => {
  it('swaps the digit boxes for a single backup-code field and back', async () => {
    const { impl } = makeFetch({
      'GET /v1/appearance': () => ({ body: { ...envelope([]), appearance: BASE_APPEARANCE } }),
      'POST /v1/client/sign_ins': () => ({ status: 201, body: { id: 'sia_2', status: 'needs_second_factor' } }),
    });
    const root = document.createElement('div');
    document.body.appendChild(root);
    await new AtlasWidget(root, { ...OPTS, fetchImpl: impl }).mount();
    await flush();
    (root.querySelector('input[name="identifier"]') as HTMLInputElement).value = 'ada@example.com';
    root.querySelector('form')!.dispatchEvent(new Event('submit'));
    await flush();

    // Authenticator step: boxes + a "use a backup code" toggle.
    expect(root.querySelectorAll('.atlas-embed-code-box').length).toBe(6);
    const toggle = root.querySelector('.atlas-embed-step-back') as HTMLButtonElement;
    expect(toggle.textContent).toContain('backup code');

    toggle.click();
    // Now a single free-text backup field (recovery codes are not fixed digits).
    expect(root.querySelectorAll('.atlas-embed-code-box').length).toBe(0);
    const field = root.querySelector('input[name="code"]') as HTMLInputElement;
    expect(field.getAttribute('type')).toBe('text');
    expect((root.querySelector('.atlas-embed-step-back') as HTMLElement).textContent).toContain('authenticator');
  });
});

describe('§5.3 "Remember this device" at two-factor', () => {
  const to2fa = async (extra: Partial<AppearanceResponse>) => {
    let secondBody: Record<string, unknown> | undefined;
    const { impl, calls } = makeFetch({
      'GET /v1/appearance': () => ({ body: { ...envelope([]), ...extra } }),
      'POST /v1/client/sign_ins': () => ({ status: 201, body: { id: 'sia_td', status: 'needs_second_factor' } }),
      'POST /v1/client/sign_ins/sia_td/attempt_second_factor': (body) => {
        secondBody = body;
        return { body: { id: 'sia_td', status: 'complete', ticket: 'tkt' } };
      },
      'POST /v1/client/tickets/exchange': () => ({ body: {} }),
    });
    const root = document.createElement('div');
    document.body.appendChild(root);
    await new AtlasWidget(root, { ...OPTS, fetchImpl: impl }).mount();
    await flush();
    (root.querySelector('input[name="identifier"]') as HTMLInputElement).value = 'ada@example.com';
    root.querySelector('form')!.dispatchEvent(new Event('submit'));
    await flush();
    return { root, calls, secondBody: () => secondBody };
  };

  it('shows the checkbox only when enabled and sends remember_device:true when ticked', async () => {
    const { root, secondBody } = await to2fa({ rememberDevice: true });

    const box = root.querySelector('.atlas-embed-remember-check') as HTMLInputElement;
    expect(box, 'the remember-this-device checkbox is shown').toBeTruthy();
    // Opt-in: unticked by default.
    expect(box.checked).toBe(false);
    box.checked = true;
    box.dispatchEvent(new Event('change'));

    // Fill the six digit boxes and submit.
    root.querySelectorAll('.atlas-embed-code-box').forEach((el, i) => {
      (el as HTMLInputElement).value = String(i);
    });
    (root.querySelector('input[name="code"]') as HTMLInputElement | null);
    root.querySelector('form')!.dispatchEvent(new Event('submit'));
    await flush();

    expect(secondBody()).toMatchObject({ remember_device: true });
  });

  it('omits the checkbox when the instance has it disabled', async () => {
    const { root } = await to2fa({});
    expect(root.querySelector('.atlas-embed-remember-check')).toBeNull();
  });
});

describe('single-screen sign-in never loses the email field on a wrong credential', () => {
  it('a wrong password keeps the email field (prefilled) + shows the error, not a bare password screen', async () => {
    const { impl } = makeFetch({
      'GET /v1/appearance': () => ({ body: envelope([]) }),
      'POST /v1/client/sign_ins': () => ({ status: 201, body: { id: 'sia_1', status: 'needs_first_factor', supported_first_factors: ['password'] } }),
      'POST /v1/client/sign_ins/sia_1/attempt_first_factor': () => ({ status: 400, body: { errors: [{ code: 'verification_failed', message: 'Incorrect password.' }] } }),
    });
    const root = document.createElement('div');
    document.body.appendChild(root);
    await new AtlasWidget(root, { ...OPTS, fetchImpl: impl }).mount();
    await flush();

    (root.querySelector('input[name="identifier"]') as HTMLInputElement).value = 'ada@example.com';
    (root.querySelector('input[name="password"]') as HTMLInputElement).value = 'wrongpass';
    root.querySelector('form')!.dispatchEvent(new Event('submit'));
    await flush();

    // The regression: the email field must STILL be present (and prefilled), the
    // password field too, and the error visible — not a password-only screen.
    const email = root.querySelector('input[name="identifier"]') as HTMLInputElement;
    expect(email, 'email field must not vanish on a wrong password').toBeTruthy();
    expect(email.value).toBe('ada@example.com');
    expect(root.querySelector('input[name="password"]')).toBeTruthy();
    expect(root.textContent).toContain('Incorrect password');
  });
});

describe('forgot password (§5.4) — the reset sub-flow in the panel', () => {
  const clickForgot = (root: HTMLElement) => {
    const forgot = Array.from(root.querySelectorAll('.atlas-embed-step-back')).find((b) =>
      (b.textContent ?? '').includes('Forgot'),
    ) as HTMLButtonElement | undefined;
    forgot?.click();
  };

  it('offers "Forgot password?" and opens the reset email step', async () => {
    const { impl } = makeFetch({ 'GET /v1/appearance': () => ({ body: envelope([]) }) });
    const root = document.createElement('div');
    document.body.appendChild(root);
    await new AtlasWidget(root, { ...OPTS, fetchImpl: impl }).mount();
    await flush();

    expect(
      Array.from(root.querySelectorAll('.atlas-embed-step-back')).some((b) =>
        (b.textContent ?? '').includes('Forgot'),
      ),
      'a Forgot password? link is shown on the sign-in box',
    ).toBe(true);

    clickForgot(root);
    expect(root.textContent).toContain('Reset your password');
    expect(root.querySelector('input[name="email"]')).toBeTruthy();
    expect(root.textContent).toContain('Send reset code');
    // And a way back to sign in.
    expect(
      Array.from(root.querySelectorAll('.atlas-embed-step-back')).some((b) =>
        (b.textContent ?? '').includes('Back to sign in'),
      ),
    ).toBe(true);
  });

  it('runs email → code → new password to a signed-in state', async () => {
    const { impl, calls } = makeFetch({
      'GET /v1/appearance': () => ({ body: envelope([]) }),
      'POST /v1/client/password_resets': () => ({ status: 201, body: { id: 'pr_1', status: 'needs_email_verification' } }),
      'POST /v1/client/password_resets/pr_1/attempt_verification': () => ({ body: { id: 'pr_1', status: 'needs_new_password' } }),
      'POST /v1/client/password_resets/pr_1/set_new_password': () => ({ body: { id: 'pr_1', status: 'complete', ticket: 'tk' } }),
      'POST /v1/client/tickets/exchange': () => ({ body: { object: 'session' } }),
      'GET /v1/client': () => ({ body: { user: { id: 'u1' }, session: { id: 's1' } } }),
    });
    const root = document.createElement('div');
    document.body.appendChild(root);
    await new AtlasWidget(root, { ...OPTS, fetchImpl: impl }).mount();
    await flush();

    clickForgot(root);
    // 1. Email → send code.
    (root.querySelector('input[name="email"]') as HTMLInputElement).value = 'ada@example.com';
    root.querySelector('form')!.dispatchEvent(new Event('submit'));
    await flush();

    // 2. Code step — 6 boxes, context shows the email. Filling all six auto-submits.
    const bs = Array.from(root.querySelectorAll('.atlas-embed-code-box')) as HTMLInputElement[];
    expect(bs.length).toBe(6);
    expect(root.textContent).toContain('ada@example.com');
    for (let i = 0; i < 6; i++) {
      bs[i]!.value = String(i + 1);
      bs[i]!.dispatchEvent(new Event('input', { bubbles: true }));
    }
    await flush();

    // 3. New password step.
    const pw = root.querySelector('input[name="password"]') as HTMLInputElement;
    expect(pw, 'reaches the new-password step').toBeTruthy();
    pw.value = 'a-brand-new-passphrase-9';
    root.querySelector('form')!.dispatchEvent(new Event('submit'));
    await flush();

    // Completed: set_new_password + the ticket exchange both happened.
    expect(calls.some((c) => c.path.endsWith('/set_new_password'))).toBe(true);
    expect(calls.some((c) => c.path.endsWith('/tickets/exchange'))).toBe(true);
  });

  it('can go back to sign in from the reset flow', async () => {
    const { impl } = makeFetch({ 'GET /v1/appearance': () => ({ body: envelope([]) }) });
    const root = document.createElement('div');
    document.body.appendChild(root);
    await new AtlasWidget(root, { ...OPTS, fetchImpl: impl }).mount();
    await flush();

    clickForgot(root);
    expect(root.querySelector('input[name="email"]')).toBeTruthy();
    const back = Array.from(root.querySelectorAll('.atlas-embed-step-back')).find((b) =>
      (b.textContent ?? '').includes('Back to sign in'),
    ) as HTMLButtonElement;
    back.click();
    // Back to the sign-in box: identifier field present, reset title gone.
    expect(root.querySelector('input[name="identifier"]')).toBeTruthy();
    expect(root.textContent).not.toContain('Reset your password');
  });
});

describe('force-login after password reset (no session)', () => {
  it('returns to the sign-in box with a confirmation when the reset issues no ticket', async () => {
    const { impl, calls } = makeFetch({
      'GET /v1/appearance': () => ({ body: envelope([]) }),
      'POST /v1/client/password_resets': () => ({ status: 201, body: { id: 'pr_2', status: 'needs_email_verification' } }),
      'POST /v1/client/password_resets/pr_2/attempt_verification': () => ({ body: { id: 'pr_2', status: 'needs_new_password' } }),
      // Force-login: complete WITHOUT a ticket.
      'POST /v1/client/password_resets/pr_2/set_new_password': () => ({ body: { id: 'pr_2', status: 'complete', sessions_revoked: 1 } }),
    });
    const root = document.createElement('div');
    document.body.appendChild(root);
    await new AtlasWidget(root, { ...OPTS, fetchImpl: impl }).mount();
    await flush();

    (Array.from(root.querySelectorAll('.atlas-embed-step-back')).find((b) => (b.textContent ?? '').includes('Forgot')) as HTMLButtonElement).click();
    (root.querySelector('input[name="email"]') as HTMLInputElement).value = 'ada@example.com';
    root.querySelector('form')!.dispatchEvent(new Event('submit'));
    await flush();
    const bs = Array.from(root.querySelectorAll('.atlas-embed-code-box')) as HTMLInputElement[];
    for (let i = 0; i < 6; i++) { bs[i]!.value = String(i + 1); bs[i]!.dispatchEvent(new Event('input', { bubbles: true })); }
    await flush();
    const pw = root.querySelector('input[name="password"]') as HTMLInputElement;
    pw.value = 'a-brand-new-passphrase-9';
    root.querySelector('form')!.dispatchEvent(new Event('submit'));
    await flush();

    // No ticket → no exchange, and we are back on the sign-in box with the flash.
    expect(calls.some((c) => c.path.endsWith('/tickets/exchange'))).toBe(false);
    expect(root.querySelector('input[name="identifier"]')).toBeTruthy();
    expect(root.querySelector('.atlas-embed-flash')?.textContent).toContain('Password updated');
    // The email is prefilled from the reset, ready to sign in.
    expect((root.querySelector('input[name="identifier"]') as HTMLInputElement).value).toBe('ada@example.com');
  });
});

describe('password show/hide toggle', () => {
  it('reveals and re-hides the password field', async () => {
    const { impl } = makeFetch({ 'GET /v1/appearance': () => ({ body: envelope([]) }) });
    const root = document.createElement('div');
    document.body.appendChild(root);
    await new AtlasWidget(root, { ...OPTS, fetchImpl: impl }).mount();
    await flush();

    const pw = root.querySelector('input[name="password"]') as HTMLInputElement;
    expect(pw.type).toBe('password');
    const toggle = root.querySelector('.atlas-embed-password-toggle') as HTMLButtonElement;
    expect(toggle, 'a show/hide toggle sits on the password field').toBeTruthy();
    toggle.click();
    expect(pw.type).toBe('text');
    toggle.click();
    expect(pw.type).toBe('password');
  });
});

describe('legal consent on sign-up (§5.1)', () => {
  const withLegal = (legal: Partial<NonNullable<PublicAppearance['legal']>>): AppearanceResponse => ({
    ...envelope([]),
    appearance: { ...BASE_APPEARANCE, legal: legal as PublicAppearance['legal'] },
  });

  it('required consent shows the links, gates the button until ticked, and sends consent:true', async () => {
    let signUpBody: Record<string, unknown> | undefined;
    const { impl } = makeFetch({
      'GET /v1/appearance': () => ({ body: withLegal({ termsUrl: 'https://acme.com/terms', privacyUrl: 'https://acme.com/privacy', required: true }) }),
      'POST /v1/client/sign_ups': (body) => {
        signUpBody = body;
        return { status: 201, body: { id: 'sua_1', status: 'needs_email_verification' } };
      },
    });
    const root = document.createElement('div');
    document.body.appendChild(root);
    await new AtlasWidget(root, { ...OPTS, mode: 'sign-up', fetchImpl: impl }).mount();
    await flush();

    const consent = root.querySelector('.atlas-embed-consent') as HTMLElement;
    expect(consent).toBeTruthy();
    const links = consent.querySelectorAll('a');
    expect(links.length).toBe(2);
    expect(links[0]!.getAttribute('href')).toBe('https://acme.com/terms');
    expect(links[1]!.getAttribute('href')).toBe('https://acme.com/privacy');
    expect(links[0]!.getAttribute('rel')).toContain('noopener');

    const submit = root.querySelector('button[type="submit"]') as HTMLButtonElement;
    expect(submit.disabled, 'the button is disabled until consent is given').toBe(true);
    const check = consent.querySelector('input[type="checkbox"]') as HTMLInputElement;
    check.checked = true;
    check.dispatchEvent(new Event('change', { bubbles: true }));
    expect(submit.disabled).toBe(false);

    // Ticked → the sign-up posts consent:true so the server can enforce it.
    (root.querySelector('input[name="identifier"]') as HTMLInputElement).value = 'ada@acme.com';
    (root.querySelector('input[name="password"]') as HTMLInputElement).value = 'sup3rSecretPw!';
    root.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flush();
    expect(signUpBody).toMatchObject({ consent: true });
  });

  it('non-required consent shows links but no checkbox and never blocks the button', async () => {
    const { impl } = makeFetch({
      'GET /v1/appearance': () => ({ body: withLegal({ termsUrl: 'https://acme.com/terms', required: false }) }),
    });
    const root = document.createElement('div');
    document.body.appendChild(root);
    await new AtlasWidget(root, { ...OPTS, mode: 'sign-up', fetchImpl: impl }).mount();
    await flush();

    const consent = root.querySelector('.atlas-embed-consent') as HTMLElement;
    expect(consent.querySelector('input[type="checkbox"]')).toBeNull();
    expect(consent.querySelector('a')!.getAttribute('href')).toBe('https://acme.com/terms');
    expect((root.querySelector('button[type="submit"]') as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('loading state (no blank flash)', () => {
  it('shows the configured loading indicator while appearance resolves, then the form', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const impl = vi.fn(async () => {
      await gate;
      return new Response(JSON.stringify(envelope(['google'])), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const root = document.createElement('div');
    document.body.appendChild(root);
    const mounting = new AtlasWidget(root, {
      ...OPTS,
      appearance: { interaction: { loading: 'dots' } },
      fetchImpl: impl,
    }).mount();

    // Before appearance resolves the widget shows a real loading state — never blank.
    await flush(1);
    const loading = root.querySelector('.atlas-embed-loading');
    expect(loading).toBeTruthy();
    expect(loading!.getAttribute('data-loading')).toBe('dots');
    expect(loading!.querySelectorAll('.atlas-embed-dot').length).toBe(3);
    expect(root.querySelector('[role="status"]')).toBeTruthy();

    release();
    await mounting;
    await flush();
    // Resolved → the loader is replaced by the form.
    expect(root.querySelector('.atlas-embed-loading')).toBeFalsy();
    expect(root.querySelector('input[name="identifier"]')).toBeTruthy();
  });

  it('swaps the submit label for a spinner while a form is submitting', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const appearanceBody = {
      ...envelope([]),
      strategies: { password: true, emailCode: false, emailLink: false, passkey: false, phoneCode: false, siwe: false },
    };
    const impl = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === 'string' ? input : input.toString());
      if (url.pathname === '/v1/appearance') {
        return new Response(JSON.stringify(appearanceBody), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.pathname === '/v1/client/sign_ins') {
        await gate;
        return new Response(JSON.stringify({ id: 'att_1', status: 'needs_first_factor' }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;

    const root = document.createElement('div');
    document.body.appendChild(root);
    await new AtlasWidget(root, { ...OPTS, fetchImpl: impl }).mount();
    await flush();

    (root.querySelector('input[name="identifier"]') as HTMLInputElement).value = 'a@b.com';
    root.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flush(1);

    // Mid-submit: the button is disabled and shows a spinner instead of its label.
    const btn = root.querySelector('.atlas-embed-button[type="submit"]') as HTMLButtonElement;
    expect(btn).toBeTruthy();
    expect(btn.hasAttribute('data-busy')).toBe(true);
    expect(btn.querySelector('.atlas-embed-btn-spinner')).toBeTruthy();
    expect(btn.disabled).toBe(true);

    release();
    await flush();
  });
});

describe('passkey sign-in (§5.5)', () => {
  it('shows a passkey button, runs the ceremony, and completes', async () => {
    // Feature-detect + a fake authenticator.
    vi.stubGlobal('PublicKeyCredential', class {});
    const get = vi.fn(async () => ({
      rawId: new Uint8Array([1, 2, 3]).buffer,
      id: 'AQID',
      response: {
        authenticatorData: new Uint8Array([10]).buffer,
        clientDataJSON: new Uint8Array([20]).buffer,
        signature: new Uint8Array([30]).buffer,
      },
    }));
    vi.stubGlobal('navigator', { credentials: { get, create: vi.fn() } });

    const base = envelope([]);
    const { impl, calls } = makeFetch({
      'GET /v1/appearance': () => ({
        body: { ...base, strategies: { ...base.strategies, passkey: true } },
      }),
      'POST /v1/client/sign_ins/passkey/begin': () => ({
        status: 201,
        body: { handle: 'wa_x', challenge: 'Y2hhbA', rpId: 'accounts.acme.com', allowCredentials: [], userVerification: 'preferred' },
      }),
      'POST /v1/client/sign_ins/passkey/finish': () => ({
        body: { object: 'sign_in_attempt', status: 'complete', created_session_id: 'sess_1' },
      }),
    });

    const root = document.createElement('div');
    document.body.appendChild(root);
    let completed = false;
    root.addEventListener('atlas:complete', () => {
      completed = true;
    });
    await new AtlasWidget(root, { ...OPTS, fetchImpl: impl }).mount();
    await flush();

    const btn = root.querySelector('[data-atlas-passkey]') as HTMLButtonElement;
    expect(btn).toBeTruthy();
    expect(btn.textContent).toContain('passkey');

    btn.click();
    await flush();

    // The ceremony ran and the finish call was made, then the widget completed.
    expect(get).toHaveBeenCalledTimes(1);
    const finish = calls.find((c) => c.path === '/v1/client/sign_ins/passkey/finish');
    expect(finish?.body).toMatchObject({ handle: 'wa_x', challenge: 'Y2hhbA' });
    expect(completed).toBe(true);

    vi.unstubAllGlobals();
  });

  it('does NOT show the passkey button when the instance has passkeys off', async () => {
    vi.stubGlobal('PublicKeyCredential', class {});
    vi.stubGlobal('navigator', { credentials: { get: vi.fn(), create: vi.fn() } });
    const { impl } = makeFetch({ 'GET /v1/appearance': () => ({ body: envelope([]) }) }); // passkey:false
    const root = document.createElement('div');
    document.body.appendChild(root);
    await new AtlasWidget(root, { ...OPTS, fetchImpl: impl }).mount();
    await flush();
    expect(root.querySelector('[data-atlas-passkey]')).toBeNull();
    vi.unstubAllGlobals();
  });
});

describe('passkey conditional-UI autofill (§5.5)', () => {
  it('arms a background conditional ceremony and completes when a passkey is chosen', async () => {
    vi.stubGlobal('PublicKeyCredential', {
      isConditionalMediationAvailable: async () => true,
    });
    let seenMediation: string | undefined;
    const get = vi.fn(async (o: { mediation?: string }) => {
      seenMediation = o.mediation;
      return {
        rawId: new Uint8Array([1]).buffer,
        id: 'AQ',
        response: {
          authenticatorData: new Uint8Array([2]).buffer,
          clientDataJSON: new Uint8Array([3]).buffer,
          signature: new Uint8Array([4]).buffer,
        },
      };
    });
    vi.stubGlobal('navigator', { credentials: { get, create: vi.fn() } });

    const base = envelope([]);
    const { impl } = makeFetch({
      'GET /v1/appearance': () => ({ body: { ...base, strategies: { ...base.strategies, passkey: true } } }),
      'POST /v1/client/sign_ins/passkey/begin': () => ({
        status: 201,
        body: { handle: 'wa_c', challenge: 'Y2hhbA', rpId: 'accounts.acme.com', allowCredentials: [], userVerification: 'preferred' },
      }),
      'POST /v1/client/sign_ins/passkey/finish': () => ({ body: { status: 'complete', created_session_id: 's1' } }),
    });

    const root = document.createElement('div');
    document.body.appendChild(root);
    let completed = false;
    root.addEventListener('atlas:complete', () => {
      completed = true;
    });
    await new AtlasWidget(root, { ...OPTS, fetchImpl: impl }).mount();
    await flush(10);

    // The conditional ceremony ran (mediation:'conditional') and completed sign-in.
    expect(get).toHaveBeenCalled();
    expect(seenMediation).toBe('conditional');
    expect(completed).toBe(true);

    vi.unstubAllGlobals();
  });

  it('does not arm conditional UI when the browser lacks it', async () => {
    vi.stubGlobal('PublicKeyCredential', {}); // no isConditionalMediationAvailable
    const get = vi.fn();
    vi.stubGlobal('navigator', { credentials: { get, create: vi.fn() } });
    const base = envelope([]);
    const { impl } = makeFetch({
      'GET /v1/appearance': () => ({ body: { ...base, strategies: { ...base.strategies, passkey: true } } }),
    });
    const root = document.createElement('div');
    document.body.appendChild(root);
    await new AtlasWidget(root, { ...OPTS, fetchImpl: impl }).mount();
    await flush(5);
    expect(get).not.toHaveBeenCalled();
    // The email field still opts into passkey autofill (autocomplete token present).
    const email = root.querySelector('input[name="identifier"]') as HTMLInputElement;
    expect(email.getAttribute('autocomplete')).toBe('username webauthn');
    vi.unstubAllGlobals();
  });
});
