// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkSession, handleSilentCallback } from './check-session';

/**
 * P3 — the browser silent-check was shipped self-declared "not yet exercised in
 * an integration test". These drive the hidden-iframe + postMessage flow in a
 * DOM: the state/origin checks that keep a foreign frame from spoofing a
 * signed-in result, and the timeout-as-signed-out contract.
 */
const OPTS = {
  issuer: 'https://id.atlas.test',
  clientId: 'client_silent',
  redirectUri: 'https://app.example.com/silent-cb',
};
const CALLBACK_ORIGIN = 'https://app.example.com';

function iframeState(): string {
  const iframe = document.querySelector('iframe');
  return new URL(iframe!.src).searchParams.get('state')!;
}
function reply(data: Record<string, unknown>, origin = CALLBACK_ORIGIN) {
  window.dispatchEvent(new MessageEvent('message', { data: { source: 'atlas:silent-auth', ...data }, origin }));
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.useRealTimers();
});

describe('checkSession', () => {
  it('builds a prompt=none authorize request in a hidden iframe', () => {
    void checkSession(OPTS);
    const iframe = document.querySelector('iframe')!;
    expect(iframe.style.display).toBe('none');
    const url = new URL(iframe.src);
    expect(url.origin).toBe(OPTS.issuer);
    expect(url.pathname).toBe('/oauth2/authorize');
    expect(url.searchParams.get('prompt')).toBe('none');
    expect(url.searchParams.get('client_id')).toBe(OPTS.clientId);
  });

  it('resolves signed-in when the callback posts signedIn with our state', async () => {
    const p = checkSession(OPTS);
    reply({ state: iframeState(), signedIn: true });
    await expect(p).resolves.toEqual({ signedIn: true, error: undefined });
  });

  it('does not infer sign-in from a raw OAuth code on the channel', async () => {
    // The code must never travel over postMessage; a message carrying only a
    // code (no signedIn flag) must NOT be trusted as a signed-in result.
    const p = checkSession(OPTS);
    reply({ state: iframeState(), code: 'auth_code_123' });
    await expect(p).resolves.toEqual({ signedIn: false, error: undefined });
  });

  it('resolves signed-out on login_required', async () => {
    const p = checkSession(OPTS);
    reply({ state: iframeState(), signedIn: false, error: 'login_required' });
    await expect(p).resolves.toEqual({ signedIn: false, error: 'login_required' });
  });

  it('ignores a message from a foreign origin (no session spoofing)', async () => {
    vi.useFakeTimers();
    const p = checkSession({ ...OPTS, timeoutMs: 5000 });
    reply({ state: iframeState(), signedIn: true }, 'https://evil.example.com');
    await vi.advanceTimersByTimeAsync(5000);
    await expect(p).resolves.toEqual({ signedIn: false, error: 'timeout' });
  });

  it('ignores a message with a mismatched state', async () => {
    vi.useFakeTimers();
    const p = checkSession({ ...OPTS, timeoutMs: 5000 });
    reply({ state: 'not-our-state', signedIn: true });
    await vi.advanceTimersByTimeAsync(5000);
    await expect(p).resolves.toEqual({ signedIn: false, error: 'timeout' });
  });

  it('times out to signed-out when no callback arrives', async () => {
    vi.useFakeTimers();
    const p = checkSession({ ...OPTS, timeoutMs: 3000 });
    await vi.advanceTimersByTimeAsync(3000);
    await expect(p).resolves.toEqual({ signedIn: false, error: 'timeout' });
  });

  it('removes its iframe and message listener after resolving', async () => {
    const p = checkSession(OPTS);
    reply({ state: iframeState(), signedIn: true });
    await p;
    expect(document.querySelector('iframe')).toBeNull();
  });
});

describe('handleSilentCallback', () => {
  const realParent = Object.getOwnPropertyDescriptor(window, 'parent');
  const stubParent = (posted: Record<string, unknown>[]) =>
    Object.defineProperty(window, 'parent', {
      value: { postMessage: (msg: Record<string, unknown>) => posted.push(msg) },
      configurable: true,
    });
  afterEach(() => {
    if (realParent) Object.defineProperty(window, 'parent', realParent);
    window.history.replaceState({}, '', '/');
  });

  it('reports signed-in WITHOUT ever forwarding the raw OAuth code', () => {
    const posted: Record<string, unknown>[] = [];
    stubParent(posted);
    window.history.replaceState({}, '', '/silent-cb?state=abc&code=secret_code');
    handleSilentCallback('https://app.example.com');
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ source: 'atlas:silent-auth', state: 'abc', signedIn: true });
    // The single-use authorization code must never ride the postMessage channel.
    expect(posted[0]!.code).toBeUndefined();
    expect(JSON.stringify(posted[0])).not.toContain('secret_code');
  });

  it('reports signed-out (carrying the error, never a code) on login_required', () => {
    const posted: Record<string, unknown>[] = [];
    stubParent(posted);
    window.history.replaceState({}, '', '/silent-cb?state=abc&error=login_required');
    handleSilentCallback('https://app.example.com');
    expect(posted[0]).toMatchObject({ signedIn: false, error: 'login_required' });
    expect(posted[0]!.code).toBeUndefined();
  });
});
