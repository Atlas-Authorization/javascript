import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import { listenForPopupResult } from '@atlasauth/js';
import { createAtlasClient, type AtlasClient } from '../lib/context';

/**
 * §oauth popup mode — the page the provider popup lands on when the opener's
 * Cross-Origin-Opener-Policy severed `window.opener`: the app's own page, with
 * the result in `#atlas_popup_result=…`. The client's boot relays it to the
 * opener over BroadcastChannel and closes; with nobody listening it finishes the
 * sign-in itself. A page that completes a sign-in inside the popup closes too.
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
const JWT = `${b64({ alg: 'none' })}.${b64({ sid: 'sess_1', sub: 'user_1', exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;
const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const fragment = (payload: Record<string, unknown>) => `#atlas_popup_result=${b64(payload)}`;

const clients: AtlasClient[] = [];
beforeEach(() => {
  MemoryBroadcastChannel.bus.clear();
  vi.stubGlobal('BroadcastChannel', MemoryBroadcastChannel);
  localStorage.clear();
  sessionStorage.clear();
  window.name = '';
});
afterEach(() => {
  for (const client of clients.splice(0)) client.destroy();
  window.history.replaceState({}, '', '/');
  window.name = '';
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Boot a client (in the background, as `initAtlas` does) against a scripted FAPI. */
function mount() {
  let signedIn = false;
  const calls: string[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    if (url.endsWith('/v1/client/tickets/exchange')) {
      signedIn = true;
      return json({ object: 'session', id: 'sess_1' });
    }
    if (url.endsWith('/v1/client')) {
      return json(
        signedIn
          ? { session: { id: 'sess_1', status: 'active', last_active_organization_id: null }, user: { id: 'user_1' }, jwt: JWT }
          : { session: null, user: null },
      );
    }
    return json({});
  }) as unknown as typeof fetch;
  const client = createAtlasClient({
    publishableKey: 'pk_test_x',
    frontendApi: 'https://fapi.example',
    fetchImpl,
    manualBoot: true,
  });
  clients.push(client);
  const booted = client.boot();
  return { client, calls, booted };
}

describe('the severed popup landing page', () => {
  it('relays the result to the opener, does not redeem the ticket itself, scrubs the fragment and closes', async () => {
    const received: Record<string, unknown>[] = [];
    const stop = listenForPopupResult('nonce_svelte_1', { onResult: (p) => received.push(p) });
    const close = vi.spyOn(window, 'close').mockImplementation(() => undefined);
    window.history.replaceState(
      {},
      '',
      `/after${fragment({ v: 1, n: 'nonce_svelte_1', type: 'atlas:oauth:complete', ticket: 'tk', attemptId: 'sia_1' })}`,
    );

    const { client, calls, booted } = mount();
    await booted;
    expect(close).toHaveBeenCalled();
    expect(received).toEqual([expect.objectContaining({ type: 'atlas:oauth:complete', ticket: 'tk', attemptId: 'sia_1' })]);
    expect(calls.some((c) => c.endsWith('/tickets/exchange'))).toBe(false);
    expect(window.location.hash).toBe('');
    expect(window.name).toBe('atlas:oauth');
    expect(get(client.status)).toBe('signed_out');
    stop();
  });

  it('finishes the sign-in itself when no opener takes the result — and stays open', async () => {
    const close = vi.spyOn(window, 'close').mockImplementation(() => undefined);
    window.history.replaceState(
      {},
      '',
      `/after${fragment({ v: 1, n: 'nonce_orphan', type: 'atlas:oauth:complete', ticket: 'tk2', attemptId: 'sia_2' })}`,
    );

    const { client, calls, booted } = mount();
    await booted;
    expect(get(client.status)).toBe('signed_in');
    expect(calls).toContain('POST https://fapi.example/v1/client/tickets/exchange');
    expect(window.location.hash).toBe('');
    // Nobody acknowledged: the opener is gone, this window is now the app.
    await new Promise((r) => setTimeout(r, 1_700));
    expect(close).not.toHaveBeenCalled();
  });
});

describe('a sign-in completed inside the Atlas popup', () => {
  it('wakes the waiting opener and closes the popup', async () => {
    const signals: number[] = [];
    const stop = listenForPopupResult('unused_nonce', { onResult: () => undefined, onSignedIn: () => signals.push(1) });
    const close = vi.spyOn(window, 'close').mockImplementation(() => undefined);
    window.name = 'atlas:oauth';
    window.history.replaceState({}, '', '/after?__atlas_attempt=sia_3&__atlas_ticket=tk3');

    const { client, calls, booted } = mount();
    await booted;
    expect(get(client.status)).toBe('signed_in');
    expect(calls).toContain('POST https://fapi.example/v1/client/tickets/exchange');
    await vi.waitFor(() => expect(close).toHaveBeenCalled());
    expect(signals).toEqual([1]);
    stop();
  });

  it('an ordinary tab that completes a redirect sign-in never closes', async () => {
    const close = vi.spyOn(window, 'close').mockImplementation(() => undefined);
    window.history.replaceState({}, '', '/after?__atlas_attempt=sia_4&__atlas_ticket=tk4');

    const { client, booted } = mount();
    await booted;
    expect(get(client.status)).toBe('signed_in');
    expect(window.location.search).toBe('');
    await new Promise((r) => setTimeout(r, 50));
    expect(close).not.toHaveBeenCalled();
  });
});
