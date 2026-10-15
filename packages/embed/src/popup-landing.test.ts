// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { listenForPopupResult } from '@atlasauth/js';
import { AtlasWidget } from './widget';
import type { AppearanceResponse, PublicAppearance } from './appearance';

/**
 * §oauth popup mode — the widget's page can be where a sign-in popup (started by
 * an Atlas SDK on the same site) lands when the opener's
 * Cross-Origin-Opener-Policy severed `window.opener`: the result arrives in
 * `#atlas_popup_result=…`. The widget relays it to the opener over
 * BroadcastChannel and stands down; with nobody listening it finishes the
 * sign-in itself, once, however many widgets the page mounts. A redirect
 * sign-in completed inside the Atlas popup hands back to the opener and closes.
 */
class MemoryBroadcastChannel {
  static bus = new Map<string, Set<MemoryBroadcastChannel>>();
  private listeners = new Set<(event: MessageEvent) => void>();
  constructor(readonly name: string) {
    const peers = MemoryBroadcastChannel.bus.get(name) ?? new Set();
    peers.add(this);
    MemoryBroadcastChannel.bus.set(name, peers);
  }
  postMessage(data: unknown) {
    for (const peer of MemoryBroadcastChannel.bus.get(this.name) ?? []) {
      if (peer !== this) queueMicrotask(() => peer.listeners.forEach((l) => l(new MessageEvent('message', { data }))));
    }
  }
  addEventListener(_t: 'message', l: (event: MessageEvent) => void) {
    this.listeners.add(l);
  }
  removeEventListener(_t: 'message', l: (event: MessageEvent) => void) {
    this.listeners.delete(l);
  }
  close() {
    MemoryBroadcastChannel.bus.get(this.name)?.delete(this);
  }
}

const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const fragment = (payload: Record<string, unknown>) => `#atlas_popup_result=${b64(payload)}`;

const APPEARANCE = {
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
} as PublicAppearance;

const ENVELOPE: AppearanceResponse = {
  object: 'appearance',
  appearance: APPEARANCE,
  providers: [],
  strategies: { password: true, emailCode: true, emailLink: true, passkey: false, phoneCode: false, siwe: false },
};

function makeFetch() {
  const calls: { method: string; path: string; body: Record<string, unknown> | undefined }[] = [];
  const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : undefined;
    calls.push({ method, path: url.pathname, body });
    const payload = url.pathname === '/v1/appearance' ? ENVELOPE : {};
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  const exchanges = () => calls.filter((c) => c.method === 'POST' && c.path === '/v1/client/tickets/exchange');
  return { impl, calls, exchanges };
}

const OPTS = { publishableKey: 'pk_test_1', frontendApi: 'https://accounts.acme.com' };

function widget(fetchImpl: typeof fetch): { root: HTMLElement; w: AtlasWidget } {
  const root = document.createElement('div');
  document.body.appendChild(root);
  return { root, w: new AtlasWidget(root, { ...OPTS, fetchImpl }) };
}

beforeEach(() => {
  MemoryBroadcastChannel.bus.clear();
  vi.stubGlobal('BroadcastChannel', MemoryBroadcastChannel);
  localStorage.clear();
  sessionStorage.clear();
  window.name = '';
});
afterEach(() => {
  window.history.replaceState({}, '', '/');
  window.name = '';
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the severed popup landing page', () => {
  it('relays the result to the opener, does not redeem the ticket itself, scrubs the fragment and closes', async () => {
    const received: Record<string, unknown>[] = [];
    const stop = listenForPopupResult('nonce_embed_1', { onResult: (p) => received.push(p) });
    const close = vi.spyOn(window, 'close').mockImplementation(() => undefined);
    window.history.replaceState(
      {},
      '',
      `/after${fragment({ v: 1, n: 'nonce_embed_1', type: 'atlas:oauth:complete', ticket: 'tk', attemptId: 'sia_1' })}`,
    );
    const { impl, exchanges } = makeFetch();
    const { root, w } = widget(impl);

    await w.mount();
    expect(close).toHaveBeenCalled();
    expect(received).toEqual([
      expect.objectContaining({ type: 'atlas:oauth:complete', ticket: 'tk', attemptId: 'sia_1' }),
    ]);
    expect(exchanges()).toHaveLength(0);
    expect(window.location.hash).toBe('');
    expect(window.name).toBe('atlas:oauth');
    // The window is closing: no sign-in form is drawn behind it.
    expect(root.querySelector('input[name="identifier"]')).toBeNull();
    stop();
  });

  it('finishes the sign-in itself when no opener takes the result — and stays open', async () => {
    const close = vi.spyOn(window, 'close').mockImplementation(() => undefined);
    window.history.replaceState(
      {},
      '',
      `/after${fragment({ v: 1, n: 'nonce_orphan', type: 'atlas:oauth:complete', ticket: 'tk2', attemptId: 'sia_2' })}`,
    );
    const { impl, exchanges } = makeFetch();
    const { root, w } = widget(impl);
    const events: Array<Record<string, unknown>> = [];
    root.addEventListener('atlas:complete', (e) => events.push((e as CustomEvent).detail));

    await w.mount();
    expect(exchanges().map((c) => c.body)).toEqual([expect.objectContaining({ attempt_id: 'sia_2', ticket: 'tk2' })]);
    expect(window.location.hash).toBe('');
    expect(events).toEqual([expect.objectContaining({ attemptId: 'sia_2' })]);
    // Nobody acknowledged: the opener is gone, this window is now the app.
    expect(close).not.toHaveBeenCalled();
  }, 10_000);

  it('redeems the ticket once however many widgets mount on the landing page', async () => {
    vi.spyOn(window, 'close').mockImplementation(() => undefined);
    window.history.replaceState(
      {},
      '',
      `/after${fragment({ v: 1, n: 'nonce_many', type: 'atlas:oauth:complete', ticket: 'tk5', attemptId: 'sia_5' })}`,
    );
    const { impl, exchanges } = makeFetch();
    const a = widget(impl);
    const b = widget(impl);

    await Promise.all([a.w.mount(), b.w.mount()]);
    expect(exchanges()).toHaveLength(1);
    expect(window.location.hash).toBe('');
  }, 10_000);
});

describe('a sign-in completed inside the Atlas popup', () => {
  it('wakes the waiting opener and closes the popup', async () => {
    const signals: number[] = [];
    const stop = listenForPopupResult('unused_nonce', {
      onResult: () => undefined,
      onSignedIn: () => signals.push(1),
    });
    const close = vi.spyOn(window, 'close').mockImplementation(() => undefined);
    window.name = 'atlas:oauth';
    window.history.replaceState({}, '', '/after?__atlas_attempt=sia_3&__atlas_ticket=tk3');
    const { impl, exchanges } = makeFetch();
    const { w } = widget(impl);

    await w.mount();
    expect(exchanges()).toHaveLength(1);
    expect(close).toHaveBeenCalled();
    expect(signals).toEqual([1]);
    expect(window.location.search).toBe('');
    stop();
  });

  it('an ordinary tab that completes a redirect sign-in never closes', async () => {
    const close = vi.spyOn(window, 'close').mockImplementation(() => undefined);
    window.history.replaceState({}, '', '/after?__atlas_attempt=sia_4&__atlas_ticket=tk4');
    const { impl, exchanges } = makeFetch();
    const { root, w } = widget(impl);

    await w.mount();
    expect(exchanges()).toHaveLength(1);
    expect(root.textContent).toContain('You are signed in.');
    await new Promise((r) => setTimeout(r, 50));
    expect(close).not.toHaveBeenCalled();
  });
});
