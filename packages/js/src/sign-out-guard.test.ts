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

describe('SignOutGuard.endImpersonation', () => {
  it('tombstones the ended impersonation session and reports the resumed one', async () => {
    const request = vi.fn(async () =>
      new Response(JSON.stringify({ resumed: true, active_session_id: 'sess_admin', jwt: 'j' }), { status: 200 }),
    );
    const guard = new SignOutGuard({ request, frontendApi: 'https://fapi.example/imp-1' });
    const out = await guard.endImpersonation('sess_imp');
    expect(out).toMatchObject({ ended: true, resumed: true, activeSessionId: 'sess_admin' });
    expect(guard.isSignedOut('sess_imp')).toBe(true);
    expect(guard.isSignedOut('sess_admin')).toBe(false);
  });

  it('a refusal tombstones nothing; no session id makes no request', async () => {
    const request = vi.fn(async () => new Response('{}', { status: 409 }));
    const guard = new SignOutGuard({ request, frontendApi: 'https://fapi.example/imp-2' });
    expect((await guard.endImpersonation('sess_x')).ended).toBe(false);
    expect(guard.isSignedOut('sess_x')).toBe(false);
    request.mockClear();
    expect((await guard.endImpersonation(null)).ended).toBe(false);
    expect(request).not.toHaveBeenCalled();
  });
});

describe('SAML Single Logout on sign-out', () => {
  const samlUrl = 'https://fapi.example/v1/sso/saml/ssoc_1/slo/start?request=_abc';

  it('sends the browser to saml_logout_url after the local sign-out, and reports it', async () => {
    const assign = vi.fn();
    const original = window.location;
    Object.defineProperty(window, 'location', { configurable: true, value: { ...original, href: original.href, assign } });
    try {
      const guard = new SignOutGuard({ request: async () => json({ status: 'revoked', saml_logout_url: samlUrl }) });
      const attempt = await guard.revoke('sess_1');
      expect(guard.settle(attempt)).toEqual({ revoked: true, samlLogoutUrl: samlUrl });
      expect(assign).toHaveBeenCalledWith(samlUrl);
    } finally {
      Object.defineProperty(window, 'location', { configurable: true, value: original });
    }
  });

  it('stays put with samlLogout:false, or when another account was promoted', async () => {
    const assign = vi.fn();
    const original = window.location;
    Object.defineProperty(window, 'location', { configurable: true, value: { ...original, href: original.href, assign } });
    try {
      const g1 = new SignOutGuard({ request: async () => json({ saml_logout_url: samlUrl }) });
      expect(g1.settle(await g1.revoke('sess_1'), { samlLogout: false })).toEqual({ revoked: true, samlLogoutUrl: samlUrl });
      const g2 = new SignOutGuard({ request: async () => json({ saml_logout_url: samlUrl, active_session_id: 'sess_2' }) });
      g2.settle(await g2.revoke('sess_1'));
      expect(assign).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(window, 'location', { configurable: true, value: original });
    }
  });

  it('ignores a non-https saml_logout_url and forwards samlLogoutRedirectUrl to the revoke', async () => {
    const paths: string[] = [];
    const guard = new SignOutGuard({
      request: async (path) => {
        paths.push(path);
        return json({ saml_logout_url: 'javascript:alert(1)' });
      },
    });
    const attempt = await guard.revoke('sess_1', { samlLogoutRedirectUrl: 'https://app.example/bye' });
    expect(guard.settle(attempt, { samlLogout: false })).toEqual({ revoked: true });
    expect(paths).toEqual([`/v1/client/sessions/sess_1/revoke?redirect_url=${encodeURIComponent('https://app.example/bye')}`]);
  });
});

describe('a sign-out response with both upstream_logout_url and saml_logout_url', () => {
  const upstreamUrl = 'https://op.example/logout?id_token_hint=eyJ.e30.sig&state=s1';
  const samlUrl = 'https://fapi.example/v1/sso/saml/ssoc_1/slo/start?request=_abc';
  const both = () => json({ object: 'session', status: 'revoked', upstream_logout_url: upstreamUrl, saml_logout_url: samlUrl });

  it('follows upstream_logout_url first, navigates only once, and reports both URLs', async () => {
    const navigate = vi.fn();
    const assign = vi.fn();
    const original = window.location;
    Object.defineProperty(window, 'location', { configurable: true, value: { ...original, href: original.href, assign } });
    try {
      const guard = new SignOutGuard({ request: async () => both(), navigate });
      const attempt = await guard.revoke('sess_1');
      expect(guard.settle(attempt)).toEqual({ revoked: true, upstreamLogoutUrl: upstreamUrl, samlLogoutUrl: samlUrl });
      expect(navigate).toHaveBeenCalledTimes(1);
      expect(navigate).toHaveBeenCalledWith(upstreamUrl);
      expect(assign).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(window, 'location', { configurable: true, value: original });
    }
  });

  it('follows the upstream URL first without a navigate hook too (window.location)', async () => {
    const assign = vi.fn();
    const original = window.location;
    Object.defineProperty(window, 'location', { configurable: true, value: { ...original, href: original.href, assign } });
    try {
      const guard = new SignOutGuard({ request: async () => both() });
      guard.settle(await guard.revoke('sess_1'));
      expect(assign.mock.calls).toEqual([[upstreamUrl]]);
    } finally {
      Object.defineProperty(window, 'location', { configurable: true, value: original });
    }
  });

  it('follows saml_logout_url instead with upstreamLogout:false; neither when both are off', async () => {
    const navigate = vi.fn();
    const guard = new SignOutGuard({ request: async () => both(), navigate });
    expect(guard.settle(await guard.revoke('sess_1'), { upstreamLogout: false })).toEqual({
      revoked: true,
      upstreamLogoutUrl: upstreamUrl,
      samlLogoutUrl: samlUrl,
    });
    expect(navigate.mock.calls).toEqual([[samlUrl]]);

    navigate.mockClear();
    expect(guard.settle(await guard.revoke('sess_2'), { upstreamLogout: false, samlLogout: false })).toEqual({
      revoked: true,
      upstreamLogoutUrl: upstreamUrl,
      samlLogoutUrl: samlUrl,
    });
    expect(navigate).not.toHaveBeenCalled();
  });

  it('samlLogout:false alone still follows the upstream URL', async () => {
    const navigate = vi.fn();
    const guard = new SignOutGuard({ request: async () => both(), navigate });
    guard.settle(await guard.revoke('sess_1'), { samlLogout: false });
    expect(navigate.mock.calls).toEqual([[upstreamUrl]]);
  });

  it('sends returnUrl as the body return_url and samlLogoutRedirectUrl as ?redirect_url on one revoke', async () => {
    const calls: { path: string; init?: RequestInit }[] = [];
    const guard = new SignOutGuard({
      request: async (path, init) => {
        calls.push({ path, init });
        return both();
      },
      navigate: vi.fn(),
    });
    await guard.revoke('sess_1', { returnUrl: 'https://app.example/op-bye', samlLogoutRedirectUrl: 'https://app.example/saml-bye' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.path).toBe(`/v1/client/sessions/sess_1/revoke?redirect_url=${encodeURIComponent('https://app.example/saml-bye')}`);
    expect(JSON.parse(String(calls[0]!.init!.body))).toEqual({ return_url: 'https://app.example/op-bye' });
  });
});
