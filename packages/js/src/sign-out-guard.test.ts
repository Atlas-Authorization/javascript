// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SignOutGuard } from './sign-out-guard';
import { SessionTombstones, SignOutError } from './sign-out';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('SignOutGuard.revoke + settle', () => {
  it('tombstones before revoking and resolves { revoked: true }', async () => {
    const guard = new SignOutGuard({ request: vi.fn(), frontendApi: 'https://fapi.example' });
    const seen: boolean[] = [];
    const request = vi.fn(async () => {
      seen.push(guard.isSignedOut('sess_1'));
      return json({ object: 'session', status: 'revoked' });
    });
    const attempt = await guard.revoke('sess_1', { request });
    expect(seen).toEqual([true]);
    expect(guard.settle(attempt)).toEqual({ revoked: true });
    expect(guard.signal(attempt)).toEqual({ signedOut: ['sess_1'] });
  });

  it('reports the promoted session and adopts it unless signed out of', async () => {
    const guard = new SignOutGuard({ request: async () => json({ active_session_id: 'sess_2' }) });
    const attempt = await guard.revoke('sess_1');
    expect(guard.settle(attempt)).toEqual({ revoked: true, activeSessionId: 'sess_2' });
    expect(guard.promoted(attempt)).toBe('sess_2');
    guard.tombstones.add('sess_2');
    expect(guard.promoted(attempt)).toBeNull();
  });

  it('finds the cookie session when the caller knows none', async () => {
    const calls: string[] = [];
    const guard = new SignOutGuard({
      request: async (path, init) => {
        calls.push(`${init?.method ?? 'GET'} ${path}`);
        return path === '/v1/client' ? json({ session: { id: 'sess_c' } }) : json({});
      },
    });
    const attempt = await guard.revoke(null);
    expect(attempt.sessionId).toBe('sess_c');
    expect(calls).toEqual(['GET /v1/client', 'POST /v1/client/sessions/sess_c/revoke']);
  });

  it('a failed revoke resolves revoked: false, or rejects with SignOutError under strict', async () => {
    const guard = new SignOutGuard({ request: async () => json({}, 503), retryDelaysMs: [] });
    const attempt = await guard.revoke('sess_1');
    expect(guard.settle(attempt)).toEqual({ revoked: false });
    let error: unknown;
    try {
      guard.settle(attempt, { strict: true });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(SignOutError);
    expect(error).toMatchObject({ code: 'SIGN_OUT_REVOKE_FAILED', sessionId: 'sess_1', status: 503 });
    expect(guard.isSignedOut('sess_1')).toBe(true);
  });

  it('re-tries a failed revoke in the background and clears the tombstone when it lands', async () => {
    vi.useFakeTimers();
    let up = false;
    const request = vi.fn(async () => (up ? json({ status: 'revoked' }) : json({}, 503)));
    const guard = new SignOutGuard({ request, retryDelaysMs: [1_000, 5_000] });
    await guard.revoke('sess_1');
    expect(request).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(request).toHaveBeenCalledTimes(3);
    expect(guard.isSignedOut('sess_1')).toBe(true);
    up = true;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(request).toHaveBeenCalledTimes(4);
    expect(guard.isSignedOut('sess_1')).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(request).toHaveBeenCalledTimes(4);
  });
});

describe('SignOutGuard.refuse', () => {
  it('refuses a signed-out session and revokes it again, dropping the tombstone on success', async () => {
    const request = vi.fn(async () => json({ status: 'revoked' }));
    const guard = new SignOutGuard({ request });
    expect(guard.refuse('sess_1')).toBe(false);
    guard.tombstones.add('sess_1');
    expect(guard.refuse('sess_1')).toBe(true);
    await vi.waitFor(() => expect(guard.isSignedOut('sess_1')).toBe(false));
    expect(request).toHaveBeenCalledWith('/v1/client/sessions/sess_1/revoke', { method: 'POST' });
  });

  it('keeps the tombstone while the server cannot be reached', async () => {
    const request = vi.fn(async () => Promise.reject(new TypeError('offline')));
    const guard = new SignOutGuard({ request });
    guard.tombstones.add('sess_1');
    expect(guard.refuse('sess_1')).toBe(true);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    expect(guard.refuse('sess_1')).toBe(true);
  });

  it('a new guard (a tab opened later) refuses the same session', () => {
    new SignOutGuard({ request: vi.fn(), frontendApi: 'https://fapi.example' }).tombstones.add('sess_1');
    const later = new SignOutGuard({
      request: async () => json({}, 503),
      frontendApi: 'https://fapi.example',
    });
    expect(later.refuse('sess_1')).toBe(true);
    // Another Frontend API keeps its own.
    expect(new SignOutGuard({ request: vi.fn(), frontendApi: 'https://other.example' }).isSignedOut('sess_1')).toBe(false);
  });
});

describe('SignOutGuard cross-tab helpers', () => {
  it('learn() records the ids a sibling broadcast', () => {
    const guard = new SignOutGuard({ request: vi.fn() });
    expect(guard.learn({ type: 'atlas:session', signedOut: ['a', 7, 'b'] })).toEqual(['a', 'b']);
    expect(guard.isSignedOut('a') && guard.isSignedOut('b')).toBe(true);
    expect(guard.learn({ type: 'atlas:session' })).toEqual([]);
    expect(guard.learn(null)).toEqual([]);
  });

  it('watch() fires when another tab signs out of the current session', () => {
    const guard = new SignOutGuard({ request: vi.fn(), frontendApi: 'https://fapi.example' });
    const onSignedOut = vi.fn();
    const stop = guard.watch(() => 'sess_1', onSignedOut);
    const key = 'atlas:signed-out-sessions:https://fapi.example';
    localStorage.setItem(key, JSON.stringify([{ id: 'sess_other', at: Date.now() }]));
    window.dispatchEvent(new StorageEvent('storage', { key }));
    expect(onSignedOut).not.toHaveBeenCalled();
    localStorage.setItem(key, JSON.stringify([{ id: 'sess_1', at: Date.now() }]));
    window.dispatchEvent(new StorageEvent('storage', { key }));
    expect(onSignedOut).toHaveBeenCalledTimes(1);
    stop();
  });
});

describe('SessionTombstones with a custom store (native)', () => {
  it('hydrates from an async store, writes through, and merges early adds', async () => {
    const data = new Map<string, string>([['atlas:signed-out-sessions', JSON.stringify([{ id: 'old', at: Date.now() }])]]);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const store = {
      getItem: vi.fn(async (k: string) => {
        await gate;
        return data.get(k) ?? null;
      }),
      setItem: vi.fn(async (k: string, v: string) => {
        data.set(k, v);
      }),
    };
    const t = new SessionTombstones({ store });
    expect(t.has('old')).toBe(false);
    t.add('early');
    release();
    await t.ready;
    expect(t.list().sort()).toEqual(['early', 'old']);
    await vi.waitFor(() =>
      expect(JSON.parse(data.get('atlas:signed-out-sessions')!).map((e: { id: string }) => e.id).sort()).toEqual([
        'early',
        'old',
      ]),
    );
    // localStorage is never touched in store mode.
    expect(localStorage.length).toBe(0);

    const restarted = new SessionTombstones({ store });
    await restarted.ready;
    expect(restarted.has('early')).toBe(true);
    restarted.remove('early');
    await vi.waitFor(() => expect(data.get('atlas:signed-out-sessions')).not.toContain('early'));
  });

  it('a throwing store leaves memory in charge', async () => {
    const store = {
      getItem: () => {
        throw new Error('locked');
      },
      setItem: () => Promise.reject(new Error('full')),
    };
    const t = new SessionTombstones({ store, frontendApi: 'https://fapi.example' });
    await t.ready;
    t.add('s');
    expect(t.has('s')).toBe(true);
  });

  it('a guard built with a store keys it per Frontend API', async () => {
    const setItem = vi.fn();
    const guard = new SignOutGuard({ request: vi.fn(), frontendApi: 'https://fapi.example/x', store: { getItem: () => null, setItem } });
    await guard.ready;
    guard.tombstones.add('s');
    expect(setItem).toHaveBeenCalledWith('atlas:signed-out-sessions:https://fapi.example', expect.stringContaining('"s"'));
  });
});
