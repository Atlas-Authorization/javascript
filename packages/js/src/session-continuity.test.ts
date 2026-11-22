// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SIGNED_IN_HINT_COOKIE,
  atlasReady,
  coordinatedRefresh,
  markAtlasReady,
  mayHaveSession,
  onWake,
  resetAtlasReady,
  resetCoordinatedRefresh,
} from './session-continuity';
import { signOutReasonFromClient, signOutReasonFromRefresh } from './sign-out-events';

describe('mayHaveSession', () => {
  it('reads the hint from a cookie string', () => {
    expect(SIGNED_IN_HINT_COOKIE).toBe('__atlas_uat');
    expect(mayHaveSession('a=1; __atlas_uat=1700000000; b=2')).toBe(true);
    expect(mayHaveSession('a=1; b=2')).toBe(false);
    expect(mayHaveSession('__atlas_uat=nope')).toBe(false);
    expect(mayHaveSession('x__atlas_uat=1700000000')).toBe(false);
    expect(mayHaveSession('')).toBe(false);
  });

  it('reads document.cookie by default', () => {
    document.cookie = '__atlas_uat=1700000000';
    expect(mayHaveSession()).toBe(true);
    document.cookie = '__atlas_uat=; expires=Thu, 01 Jan 1970 00:00:00 GMT';
    expect(mayHaveSession()).toBe(false);
  });
});

describe('onWake', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('coalesces visible/focus/online/pageshow within 1 s, then fires again', () => {
    const cb = vi.fn();
    const off = onWake(cb);
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('focus'));
    window.dispatchEvent(new Event('online'));
    window.dispatchEvent(new Event('pageshow'));
    expect(cb).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1_001);
    window.dispatchEvent(new Event('pageshow'));
    expect(cb).toHaveBeenCalledTimes(2);
    off();
    vi.advanceTimersByTime(2_000);
    window.dispatchEvent(new Event('focus'));
    expect(cb).toHaveBeenCalledTimes(2);
  });
});

describe('atlasReady', () => {
  it('resolves on the first mark, ignores later ones until reset', async () => {
    resetAtlasReady();
    markAtlasReady(true);
    markAtlasReady(false);
    await expect(atlasReady()).resolves.toEqual({ signedIn: true });
    resetAtlasReady();
    const next = atlasReady();
    markAtlasReady(false);
    await expect(next).resolves.toEqual({ signedIn: false });
  });
});

describe('coordinatedRefresh across two tabs', () => {
  const buses = new Map<string, Set<FakeChannel>>();
  class FakeChannel {
    private listeners = new Set<(e: MessageEvent) => void>();
    constructor(private name: string) {
      if (!buses.has(name)) buses.set(name, new Set());
      buses.get(name)!.add(this);
    }
    postMessage(data: unknown) {
      for (const peer of buses.get(this.name)!) {
        if (peer === this) continue;
        setTimeout(() => peer.listeners.forEach((l) => l({ data } as MessageEvent)), 0);
      }
    }
    addEventListener(_t: string, l: (e: MessageEvent) => void) {
      this.listeners.add(l);
    }
    removeEventListener(_t: string, l: (e: MessageEvent) => void) {
      this.listeners.delete(l);
    }
    close() {
      buses.get(this.name)?.delete(this);
    }
  }

  beforeEach(() => {
    vi.stubGlobal('BroadcastChannel', FakeChannel);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    buses.clear();
    resetCoordinatedRefresh();
  });

  it('makes one network refresh; the other tab adopts the broadcast token', async () => {
    const fresh = { jwt: 'j', expiresAt: Date.now() + 60_000, sessionId: 's1' };
    const fn = vi.fn(async () => fresh);
    // Tab B is a second module instance (own state, own channel).
    vi.resetModules();
    const b = await import('./session-continuity');
    const [ra, rb] = await Promise.all([coordinatedRefresh('k', fn), b.coordinatedRefresh('k', fn)]);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(ra).toEqual(fresh);
    expect(rb).toEqual(fresh);
    b.resetCoordinatedRefresh();
  });

  it('collapses concurrent calls inside one tab', async () => {
    const fn = vi.fn(async () => ({ jwt: 'j', expiresAt: Date.now() + 60_000, sessionId: 's1' }));
    await Promise.all([coordinatedRefresh('same', fn), coordinatedRefresh('same', fn)]);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('sign-out reason mapping', () => {
  it('maps refresh failures and server reasons', () => {
    expect(signOutReasonFromRefresh(null, null)).toBe('refresh_failed');
    expect(signOutReasonFromRefresh(503, null)).toBe('refresh_failed');
    expect(signOutReasonFromRefresh(401, {})).toBe('refresh_failed');
    expect(signOutReasonFromRefresh(401, { signed_out_reason: 'revoked' })).toBe('revoked');
    expect(signOutReasonFromRefresh(401, { signed_out_reason: 'token_invalid' })).toBe('token_invalid');
    expect(signOutReasonFromClient({ signed_out_reason: 'session_expired' })).toBe('session_expired');
    expect(signOutReasonFromClient({})).toBe('unknown');
  });
});
