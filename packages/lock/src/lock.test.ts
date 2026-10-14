// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppearanceResponse, PublicAppearance } from '@atlasauth/embed';
import { AtlasLock } from './lock';

/**
 * Lock mounts the real `@atlasauth/embed` widget — which drives the shared
 * `@atlasauth/js` flow against FAPI — inside its modal/inline shell. These tests
 * mount it against a mocked FAPI and assert the composed surface: the shell
 * opens, the widget renders the instance's methods, the `methods` allow-list
 * prunes the rest, the theme recolours both chrome and form, and
 * `onAuthenticated` fires when the mocked attempt completes.
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

const envelope = (providers: string[], overrides: Partial<AppearanceResponse> = {}): AppearanceResponse => ({
  object: 'appearance',
  appearance: BASE_APPEARANCE,
  providers,
  strategies: { password: true, emailCode: true, emailLink: true, passkey: true, phoneCode: false, siwe: false },
  ...overrides,
});

interface Recorded { method: string; path: string; body: Record<string, unknown> | undefined; }

function makeFetch(
  handlers: Record<string, (body: Record<string, unknown> | undefined) => { status?: number; body: unknown }>,
) {
  const calls: Recorded[] = [];
  const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : undefined;
    calls.push({ method, path: url.pathname, body });
    const handler = handlers[`${method} ${url.pathname}`];
    const result = handler ? handler(body) : { status: 404, body: { errors: [{ code: 'NO_ROUTE', message: 'no route' }] } };
    return new Response(JSON.stringify(result.body ?? {}), {
      status: result.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const flush = async (times = 8): Promise<void> => {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
};

const OPTS = { publishableKey: 'pk_test_1', domain: 'accounts.acme.com' };

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('showing the widget', () => {
  it('opens a modal dialog with the configured chrome and renders the instance methods', async () => {
    const { impl } = makeFetch({ 'GET /v1/appearance': () => ({ body: envelope(['google', 'github']) }) });
    const lock = new AtlasLock({ ...OPTS, fetchImpl: impl });
    lock.show();
    await lock.whenReady();
    await flush();

    const overlay = document.querySelector('.atlas-lock-overlay');
    expect(overlay).toBeTruthy();
    const dialog = document.querySelector('.atlas-lock-dialog')!;
    expect(dialog.getAttribute('role')).toBe('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    // Close button + tab switcher present (both screens allowed by default).
    expect(dialog.querySelector('.atlas-lock-close')).toBeTruthy();
    expect(dialog.querySelectorAll('.atlas-lock-tab').length).toBe(2);
    // The embedded widget rendered the social buttons the instance enabled.
    const providers = dialog.querySelectorAll('[data-atlas-provider]');
    expect(providers.length).toBe(2);
    expect(dialog.querySelector('input[name="identifier"]')).toBeTruthy();
    expect(lock.visible).toBe(true);
  });

  it('renders inline into a container when display:inline', async () => {
    const { impl } = makeFetch({ 'GET /v1/appearance': () => ({ body: envelope([]) }) });
    const host = document.createElement('div');
    host.id = 'slot';
    document.body.appendChild(host);

    const lock = new AtlasLock({ ...OPTS, container: '#slot', options: { display: 'inline' }, fetchImpl: impl });
    lock.show();
    await lock.whenReady();
    await flush();

    expect(document.querySelector('.atlas-lock-overlay')).toBeNull();
    expect(host.querySelector('.atlas-lock-inline')).toBeTruthy();
    expect(host.querySelector('input[name="identifier"]')).toBeTruthy();
  });

  it('hide() removes the shell and restores visibility state', async () => {
    const { impl } = makeFetch({ 'GET /v1/appearance': () => ({ body: envelope([]) }) });
    const lock = new AtlasLock({ ...OPTS, fetchImpl: impl });
    lock.show();
    await lock.whenReady();
    await flush();
    expect(document.querySelector('.atlas-lock-dialog')).toBeTruthy();

    lock.hide();
    expect(document.querySelector('.atlas-lock-dialog')).toBeNull();
    expect(lock.visible).toBe(false);
  });

  it('Escape closes a closable modal', async () => {
    const { impl } = makeFetch({ 'GET /v1/appearance': () => ({ body: envelope([]) }) });
    const lock = new AtlasLock({ ...OPTS, fetchImpl: impl });
    lock.show();
    await lock.whenReady();
    await flush();

    const dialog = document.querySelector('.atlas-lock-dialog') as HTMLElement;
    dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(lock.visible).toBe(false);
  });
});

describe('the methods allow-list', () => {
  it('prunes social + passkey buttons not in the allow-list', async () => {
    const { impl } = makeFetch({ 'GET /v1/appearance': () => ({ body: envelope(['google', 'github']) }) });
    const lock = new AtlasLock({ ...OPTS, options: { methods: ['password'] }, fetchImpl: impl });
    lock.show();
    await lock.whenReady();
    await flush();

    const dialog = document.querySelector('.atlas-lock-dialog')!;
    expect(dialog.querySelectorAll('[data-atlas-provider]').length).toBe(0);
    expect(dialog.querySelector('[data-atlas-passkey]')).toBeNull();
    // Password-based identifier field survives.
    expect(dialog.querySelector('input[name="identifier"]')).toBeTruthy();
  });

  it('keeps social when it is in the allow-list', async () => {
    const { impl } = makeFetch({ 'GET /v1/appearance': () => ({ body: envelope(['google']) }) });
    const lock = new AtlasLock({ ...OPTS, options: { methods: ['password', 'social'] }, fetchImpl: impl });
    lock.show();
    await lock.whenReady();
    await flush();
    expect(document.querySelector('[data-atlas-provider="google"]')).toBeTruthy();
  });
});

describe('theming', () => {
  it('applies @atlasauth/themes dark tokens to both the shell chrome and the widget', async () => {
    const { impl } = makeFetch({ 'GET /v1/appearance': () => ({ body: envelope([]) }) });
    const lock = new AtlasLock({ ...OPTS, options: { theme: 'dark' }, fetchImpl: impl });
    lock.show();
    await lock.whenReady();
    await flush();

    const dialog = document.querySelector('.atlas-lock-dialog') as HTMLElement;
    // Shell chrome recoloured from the dark preset.
    expect(dialog.style.getPropertyValue('--atlas-lock-bg')).toBe('#14171c');
    expect(dialog.style.getPropertyValue('--atlas-lock-primary')).toBe('#818cf8');
    // The embedded widget root got the mapped embed token.
    const widgetRoot = dialog.querySelector('.atlas-embed-root') as HTMLElement;
    expect(widgetRoot.style.getPropertyValue('--atlas-embed-color-background')).toBe('#14171c');
  });

  it('primaryColor overrides the accent on both surfaces', async () => {
    const { impl } = makeFetch({ 'GET /v1/appearance': () => ({ body: envelope([]) }) });
    const lock = new AtlasLock({ ...OPTS, options: { primaryColor: '#16a34a' }, fetchImpl: impl });
    lock.show();
    await lock.whenReady();
    await flush();
    const dialog = document.querySelector('.atlas-lock-dialog') as HTMLElement;
    expect(dialog.style.getPropertyValue('--atlas-lock-primary')).toBe('#16a34a');
    const widgetRoot = dialog.querySelector('.atlas-embed-root') as HTMLElement;
    expect(widgetRoot.style.getPropertyValue('--atlas-embed-color-primary')).toBe('#16a34a');
  });
});

describe('onAuthenticated', () => {
  it('fires with the completion detail when a mocked password sign-in completes', async () => {
    const { impl } = makeFetch({
      'GET /v1/appearance': () => ({ body: envelope([]) }),
      'POST /v1/client/sign_ins': () => ({ status: 201, body: { id: 'sia_1', status: 'needs_first_factor' } }),
      'POST /v1/client/sign_ins/sia_1/attempt_first_factor': () => ({
        body: { id: 'sia_1', status: 'complete', ticket: 'tkt_1' },
      }),
      'POST /v1/client/tickets/exchange': () => ({ body: {} }),
    });
    const authed: unknown[] = [];
    const lock = new AtlasLock({
      ...OPTS,
      fetchImpl: impl,
      options: { onAuthenticated: (s) => authed.push(s) },
    });
    lock.show();
    await lock.whenReady();
    await flush();

    const dialog = document.querySelector('.atlas-lock-dialog')!;
    (dialog.querySelector('input[name="identifier"]') as HTMLInputElement).value = 'ada@example.com';
    (dialog.querySelector('input[name="password"]') as HTMLInputElement).value = 'hunter2';
    dialog.querySelector('form')!.dispatchEvent(new Event('submit'));
    await flush();

    expect(authed).toHaveLength(1);
    expect(authed[0]).toMatchObject({ redirected: false });
    // No redirect was configured, so the modal auto-closed on completion.
    expect(lock.visible).toBe(false);
  });
});

describe('tab switching', () => {
  it('re-mounts the widget in sign-up mode when the sign-up tab is clicked', async () => {
    const { impl, calls } = makeFetch({ 'GET /v1/appearance': () => ({ body: envelope([]) }) });
    const lock = new AtlasLock({ ...OPTS, fetchImpl: impl });
    lock.show();
    await lock.whenReady();
    await flush();
    expect(lock.screen).toBe('sign-in');

    const upTab = document.querySelectorAll('.atlas-lock-tab')[1] as HTMLButtonElement;
    upTab.click();
    await lock.whenReady();
    await flush();

    expect(lock.screen).toBe('sign-up');
    expect(upTab.getAttribute('aria-selected')).toBe('true');
    // The widget re-fetched appearance for the new mount.
    expect(calls.filter((c) => c.path === '/v1/appearance').length).toBeGreaterThanOrEqual(2);
  });
});
