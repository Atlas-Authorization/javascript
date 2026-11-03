// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FapiClient } from './fapi';
import { startOauthPopup } from './redirect';
import {
  closeOAuthPopupAfterSignIn,
  completeOAuthPopupLanding,
  listenForPopupResult,
  popupChannelName,
  readPopupLanding,
} from './popup-channel';

/**
 * §oauth popup mode with a SEVERED opener. When the opener page sends
 * Cross-Origin-Opener-Policy: same-origin, the cross-origin popup lands in
 * another browsing-context group: `popup.closed` reads true to the opener at
 * once and the popup's `window.opener` is null, so no postMessage can arrive.
 * The Frontend API lands the popup on the opener's page with the result in the
 * fragment; the SDK there relays it over BroadcastChannel('atlas:oauth:<nonce>').
 */
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const fragmentFor = (payload: Record<string, unknown>) =>
  `#atlas_popup_result=${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;

function setup(clientBody: () => unknown = () => ({ session: null, user: null })) {
  const calls: string[] = [];
  let nonce = '';
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith('/v1/client/sign_ins/oauth')) {
      nonce = (JSON.parse(String(init?.body)) as { popup_nonce: string }).popup_nonce;
      return json({ authorization_url: 'https://accounts.google.com/o/oauth2/v2/auth?x=1' }, 201);
    }
    if (url.endsWith('/v1/client')) return json(clientBody());
    return json({});
  }) as unknown as typeof fetch;
  // A severed popup: the opener's handle reports it closed right away.
  const popup = { closed: false, close: vi.fn() };
  vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);
  const client = new FapiClient({ publishableKey: 'pk_test_x', baseUrl: 'https://fapi.example', fetchImpl });
  const probes = () => calls.filter((u) => u === 'https://fapi.example/v1/client').length;
  return { client, popup, calls, probes, nonce: () => nonce };
}

/** A stand-in for the popup window that landed on the opener's page. */
function landingWindow(hash: string, name = '') {
  const replaceState = vi.fn();
  const win = {
    name,
    opener: null,
    location: { hash, href: `https://app.example/after${hash}` },
    history: { state: null, replaceState },
    close: vi.fn(),
  };
  return { win: win as unknown as Window & { close: ReturnType<typeof vi.fn> }, replaceState, raw: win };
}

/**
 * An in-memory BroadcastChannel: delivers (asynchronously, like the real one)
 * to every OTHER instance with the same name — standing in for the opener and
 * the popup, two same-origin top-level windows.
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
      if (peer === this) continue;
      queueMicrotask(() => peer.listeners.forEach((l) => l(new MessageEvent('message', { data }))));
    }
  }
  addEventListener(_type: 'message', listener: (event: MessageEvent) => void) {
    this.listeners.add(listener);
  }
  removeEventListener(_type: 'message', listener: (event: MessageEvent) => void) {
    this.listeners.delete(listener);
  }
  close() {
    MemoryBroadcastChannel.bus.get(this.name)?.delete(this);
  }
}

beforeEach(() => {
  MemoryBroadcastChannel.bus.clear();
  vi.stubGlobal('BroadcastChannel', MemoryBroadcastChannel);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('severed popup detection', () => {
  it('keeps waiting with backed-off probes, and cancels only after 5 minutes', async () => {
    vi.useFakeTimers();
    const { client, popup, probes } = setup();
    const onSevered = vi.fn();
    let settled: unknown;
    void startOauthPopup(client, { provider: 'google', redirectUrl: 'https://app.example/' }, { onSevered }).then(
      (r) => (settled = r),
    );
    await vi.advanceTimersByTimeAsync(0);
    popup.closed = true; // ~immediately: the COOP severance, not the user
    await vi.advanceTimersByTimeAsync(300);
    expect(onSevered).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(settled).toBeUndefined();
    const inFirstMinute = probes();
    expect(inFirstMinute).toBeGreaterThan(1);
    // Backed off: far fewer than one probe per poll tick.
    expect(inFirstMinute).toBeLessThan(10);

    await vi.advanceTimersByTimeAsync(4 * 60_000 - 1_000);
    expect(settled).toBeUndefined();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(settled).toEqual({ error: 'popup_closed', severed: true });
  });

  it('settles signed-in as soon as a probe finds the session the popup created', async () => {
    vi.useFakeTimers();
    let session: unknown = null;
    const { client, popup } = setup(() => (session ? { session, user: { id: 'user_1' } } : { session: null, user: null }));
    const pending = startOauthPopup(client, { provider: 'google', redirectUrl: 'https://app.example/' });
    await vi.advanceTimersByTimeAsync(0);
    popup.closed = true;
    await vi.advanceTimersByTimeAsync(10_000);
    session = { id: 'sess_1' };
    await vi.advanceTimersByTimeAsync(31_000);
    await expect(pending).resolves.toEqual({ error: 'popup_closed', sessionDetected: true, severed: true });
  });

  it('a newer popup flow, or an aborted signal, cancels the waiting one', async () => {
    vi.useFakeTimers();
    const { client, popup } = setup();
    const first = startOauthPopup(client, { provider: 'google', redirectUrl: 'https://app.example/' });
    await vi.advanceTimersByTimeAsync(0);
    popup.closed = true;
    await vi.advanceTimersByTimeAsync(300);
    popup.closed = false;
    const controller = new AbortController();
    const second = startOauthPopup(client, { provider: 'github', redirectUrl: 'https://app.example/', signal: controller.signal });
    await vi.advanceTimersByTimeAsync(0);
    await expect(first).resolves.toEqual({ error: 'popup_closed', severed: true });
    controller.abort();
    await expect(second).resolves.toEqual({ error: 'popup_closed' });
  });
});

describe('cancel semantics without severance', () => {
  it('a popup the user closes after the detection window is a cancel after one final probe', async () => {
    vi.useFakeTimers();
    const { client, popup, probes } = setup();
    const onSevered = vi.fn();
    const pending = startOauthPopup(client, { provider: 'google', redirectUrl: 'https://app.example/' }, { onSevered });
    await vi.advanceTimersByTimeAsync(5_000);
    popup.closed = true;
    await vi.advanceTimersByTimeAsync(300);
    await expect(pending).resolves.toEqual({ error: 'popup_closed' });
    expect(probes()).toBe(1);
    expect(onSevered).not.toHaveBeenCalled();
  });
});

describe('BroadcastChannel completion', () => {
  it('the landing page relays the ticket, the opener settles with it and the popup closes', async () => {
    const { client, popup, nonce } = setup();
    const onComplete = vi.fn();
    const pending = startOauthPopup(client, { provider: 'google', redirectUrl: 'https://app.example/after' }, { onComplete });
    // The popup is open (and the opener listening) before anything lands.
    await vi.waitFor(() => expect(window.open).toHaveBeenCalled());
    popup.closed = true; // severed
    const landing = landingWindow(
      fragmentFor({ v: 1, n: nonce(), type: 'atlas:oauth:complete', ticket: 'tk_1', attemptId: 'sia_1' }),
    );
    const out = await completeOAuthPopupLanding({ win: landing.win });
    expect(out?.delivered).toBe(true);
    expect(landing.win.close).toHaveBeenCalled();
    // (It may land before the severance is even noticed — either way, the ticket.)
    await expect(pending).resolves.toMatchObject({ ticket: 'tk_1', attemptId: 'sia_1' });
    expect(onComplete).toHaveBeenCalledWith({ ticket: 'tk_1', attemptId: 'sia_1' });
  });

  it('an explicit error result settles the flow as that error', async () => {
    const { client, popup, nonce } = setup();
    const onError = vi.fn();
    const pending = startOauthPopup(client, { provider: 'google', redirectUrl: 'https://app.example/after' }, { onError });
    // The popup is open (and the opener listening) before anything lands.
    await vi.waitFor(() => expect(window.open).toHaveBeenCalled());
    popup.closed = true;
    await completeOAuthPopupLanding({
      win: landingWindow(fragmentFor({ v: 1, n: nonce(), type: 'atlas:oauth:error', code: 'access_denied' })).win,
    });
    await expect(pending).resolves.toMatchObject({ error: 'access_denied' });
    expect(onError).toHaveBeenCalledWith('access_denied');
  });

  it('ignores a result for another flow’s nonce', async () => {
    const { client, nonce } = setup();
    const controller = new AbortController();
    const pending = startOauthPopup(client, { provider: 'google', redirectUrl: 'https://app.example/', signal: controller.signal });
    // The popup is open (and the opener listening) before anything lands.
    await vi.waitFor(() => expect(window.open).toHaveBeenCalled());
    const out = await completeOAuthPopupLanding({
      win: landingWindow(fragmentFor({ v: 1, n: 'someoneElsesNonce', type: 'atlas:oauth:complete', ticket: 'x' })).win,
      ackTimeoutMs: 200,
    });
    expect(out?.delivered).toBe(false);
    controller.abort();
    await expect(pending).resolves.toEqual({ error: 'popup_closed' });
  });

  it('a page that signed in inside the popup wakes the opener, which probes at once', async () => {
    let session: unknown = null;
    const { client, popup, nonce } = setup(() => (session ? { session, user: { id: 'u' } } : { session: null, user: null }));
    const pending = startOauthPopup(client, { provider: 'google', redirectUrl: 'https://app.example/' });
    // The popup is open (and the opener listening) before anything lands.
    await vi.waitFor(() => expect(window.open).toHaveBeenCalled());
    popup.closed = true;
    session = { id: 'sess_1' };
    const inPopup = landingWindow('', 'atlas:oauth');
    expect(await closeOAuthPopupAfterSignIn({ win: inPopup.win })).toBe(true);
    expect(inPopup.win.close).toHaveBeenCalled();
    await expect(pending).resolves.toMatchObject({ sessionDetected: true });
  });
});

describe('localStorage fallback (no BroadcastChannel)', () => {
  it('the opener takes the result from a storage event and acknowledges it', () => {
    vi.stubGlobal('BroadcastChannel', undefined);
    const onResult = vi.fn();
    const stop = listenForPopupResult('nonce_storage_1', { onResult });
    const key = `atlas:${popupChannelName('nonce_storage_1')}`;
    // Spy on the storage instance itself: after the OAuth starts above stored
    // the SDK's device id, a Storage.prototype spy no longer sees the write
    // under happy-dom.
    const setItem = vi.spyOn(window.localStorage, 'setItem');
    window.dispatchEvent(
      new StorageEvent('storage', {
        key,
        newValue: JSON.stringify({
          message: { type: 'atlas:oauth:result', id: 'm1', result: { type: 'atlas:oauth:complete', ticket: 't' } },
          at: Date.now(),
        }),
      }),
    );
    expect(onResult).toHaveBeenCalledWith({ type: 'atlas:oauth:complete', ticket: 't' });
    // The ack went out on the same key.
    expect(setItem.mock.calls.some(([k, v]) => k === key && String(v).includes('atlas:oauth:ack'))).toBe(true);
    stop();
  });
});

describe('fragment handling', () => {
  it('reads only a well-formed v1 result', () => {
    expect(readPopupLanding(fragmentFor({ v: 1, n: 'abc12345', type: 'atlas:oauth:complete', ticket: 't' }))).toEqual({
      nonce: 'abc12345',
      payload: { v: 1, n: 'abc12345', type: 'atlas:oauth:complete', ticket: 't' },
    });
    expect(readPopupLanding('')).toBeNull();
    expect(readPopupLanding('#section-2')).toBeNull();
    expect(readPopupLanding('#atlas_popup_result=not-base64-json')).toBeNull();
    expect(readPopupLanding(fragmentFor({ v: 2, n: 'abc12345', type: 'atlas:oauth:complete' }))).toBeNull();
    expect(readPopupLanding(fragmentFor({ v: 1, type: 'atlas:oauth:complete' }))).toBeNull();
    expect(readPopupLanding(fragmentFor({ v: 1, n: 'abc12345', type: 'something' }))).toBeNull();
  });

  it('scrubs the fragment, names the window, and does not close when nobody acknowledged', async () => {
    const landing = landingWindow(fragmentFor({ v: 1, n: 'lonelyNonce1', type: 'atlas:oauth:complete', ticket: 't' }));
    const out = await completeOAuthPopupLanding({ win: landing.win, ackTimeoutMs: 100 });
    expect(out).toEqual({ payload: expect.objectContaining({ ticket: 't' }), delivered: false });
    expect(landing.replaceState).toHaveBeenCalledWith(null, '', 'https://app.example/after');
    expect(landing.raw.name).toBe('atlas:oauth');
    // The opener is gone: this window must complete the sign-in itself.
    expect(landing.win.close).not.toHaveBeenCalled();
  });

  it('is a no-op on an ordinary page', async () => {
    const page = landingWindow('');
    expect(await completeOAuthPopupLanding({ win: page.win })).toBeNull();
    expect(page.replaceState).not.toHaveBeenCalled();
  });

  it('closeOAuthPopupAfterSignIn leaves a window that is not the Atlas popup alone', async () => {
    const page = landingWindow('', '');
    expect(await closeOAuthPopupAfterSignIn({ win: page.win, ackTimeoutMs: 50 })).toBe(false);
    // The Atlas popup with nobody waiting (opener gone) also stays open.
    const orphan = landingWindow('', 'atlas:oauth');
    expect(await closeOAuthPopupAfterSignIn({ win: orphan.win, ackTimeoutMs: 50 })).toBe(false);
    expect(orphan.win.close).not.toHaveBeenCalled();
  });
});
