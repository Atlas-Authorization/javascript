import { describe, expect, it, vi } from 'vitest';
import {
  exchangeForSession,
  exchangeGoogleTokenForSession,
  NativeSessionManager,
  parseNativeSession,
  refreshNativeSession,
  serializeNativeSession,
  type NativeSession,
} from './native-session';

const BASE = 'https://fapi.example.test';

/** Route fake responses by `METHOD /path`; records url + init for asserts. */
function router(
  handlers: Record<string, { status?: number; body?: unknown; raw?: string }>,
): {
  fetchImpl: typeof fetch;
  calls: Array<{ method: string; path: string; init?: RequestInit }>;
} {
  const calls: Array<{ method: string; path: string; init?: RequestInit }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const path = new URL(url).pathname;
    const method = (init?.method ?? 'GET').toUpperCase();
    calls.push({ method, path, init });
    const handler = handlers[`${method} ${path}`];
    if (!handler) return new Response('null', { status: 404 });
    const { status = 200, body, raw } = handler;
    const payload = raw !== undefined ? raw : body === undefined ? null : JSON.stringify(body);
    return new Response(payload, { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

// ── exchangeGoogleTokenForSession ────────────────────────────────────────────

describe('exchangeGoogleTokenForSession', () => {
  const ok = { access_token: 'sess.jwt.g', expires_in: 60, refresh_token: 'refr_g', session_id: 'sess_g' };

  it('POSTs the Google token with its own subject_token_type and asks for a session', async () => {
    const { fetchImpl, calls } = router({ 'POST /oauth2/token': { body: ok } });
    const session = await exchangeGoogleTokenForSession({ baseUrl: BASE, clientId: 'client_ext', googleAccessToken: 'ya29.token', deviceName: 'Chrome on Mac', fetchImpl });
    expect(session).toEqual<NativeSession>({ sessionToken: 'sess.jwt.g', refreshToken: 'refr_g', sessionId: 'sess_g', expiresInSeconds: 60 });
    const form = new URLSearchParams(String(calls[0]!.init?.body));
    expect(Object.fromEntries(form)).toEqual({
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      client_id: 'client_ext',
      subject_token: 'ya29.token',
      subject_token_type: 'urn:atlas:token-type:google_access_token',
      requested_token_type: 'urn:atlas:token-type:session',
      device_name: 'Chrome on Mac',
    });
  });

  it('sends no device_name when none is given, and returns null on a refusal or a network failure', async () => {
    const { fetchImpl, calls } = router({ 'POST /oauth2/token': { status: 400, body: { error: 'invalid_grant' } } });
    expect(await exchangeGoogleTokenForSession({ baseUrl: BASE, clientId: 'c', googleAccessToken: 't', fetchImpl })).toBeNull();
    expect(new URLSearchParams(String(calls[0]!.init?.body)).has('device_name')).toBe(false);
    const down = (async () => {
      throw new Error('offline');
    }) as typeof fetch;
    expect(await exchangeGoogleTokenForSession({ baseUrl: BASE, clientId: 'c', googleAccessToken: 't', fetchImpl: down })).toBeNull();
  });
});

// ── exchangeForSession ───────────────────────────────────────────────────────

describe('exchangeForSession', () => {
  it('POSTs the token-exchange form and parses the session', async () => {
    const { fetchImpl, calls } = router({
      'POST /oauth2/token': {
        body: {
          access_token: 'sess.jwt.1',
          issued_token_type: 'urn:atlas:token-type:session',
          token_type: 'Bearer',
          expires_in: 60,
          refresh_token: 'refr_1',
          session_id: 'sess_1',
        },
      },
    });

    const session = await exchangeForSession({
      baseUrl: BASE,
      clientId: 'client_abc',
      accessToken: 'oauth-access-token',
      fetchImpl,
    });

    expect(session).toEqual<NativeSession>({
      sessionToken: 'sess.jwt.1',
      refreshToken: 'refr_1',
      sessionId: 'sess_1',
      expiresInSeconds: 60,
    });

    // The form carries the exact RFC 8693 grant + token types the server expects.
    const form = new URLSearchParams(calls[0]!.init!.body as string);
    expect(calls[0]!.path).toBe('/oauth2/token');
    expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:token-exchange');
    expect(form.get('client_id')).toBe('client_abc');
    expect(form.get('subject_token')).toBe('oauth-access-token');
    expect(form.get('subject_token_type')).toBe('urn:ietf:params:oauth:token-type:access_token');
    expect(form.get('requested_token_type')).toBe('urn:atlas:token-type:session');
    expect((calls[0]!.init!.headers as Record<string, string>)['content-type']).toBe(
      'application/x-www-form-urlencoded',
    );
  });

  it('returns null (never throws) on a non-2xx', async () => {
    const { fetchImpl } = router({ 'POST /oauth2/token': { status: 400, body: { error: 'invalid_grant' } } });
    await expect(
      exchangeForSession({ baseUrl: BASE, clientId: 'c', accessToken: 't', fetchImpl }),
    ).resolves.toBeNull();
  });

  it('returns null when the transport rejects', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    await expect(
      exchangeForSession({ baseUrl: BASE, clientId: 'c', accessToken: 't', fetchImpl }),
    ).resolves.toBeNull();
  });

  it('returns null when the body is missing the session token or id', async () => {
    const { fetchImpl } = router({ 'POST /oauth2/token': { body: { refresh_token: 'r' } } });
    await expect(
      exchangeForSession({ baseUrl: BASE, clientId: 'c', accessToken: 't', fetchImpl }),
    ).resolves.toBeNull();
  });
});

// ── refreshNativeSession ───────────────────────────────────────────────────────

describe('refreshNativeSession', () => {
  it('POSTs the refresh token with the pk header and returns the rotated session', async () => {
    const { fetchImpl, calls } = router({
      'POST /v1/client/sessions/sess_1/tokens': {
        body: {
          object: 'session_tokens',
          jwt: 'sess.jwt.2',
          session_id: 'sess_1',
          expires_in: 60,
          refresh_token: 'refr_2',
        },
      },
    });

    const session = await refreshNativeSession({
      baseUrl: BASE,
      publishableKey: 'pk_test',
      sessionId: 'sess_1',
      refreshToken: 'refr_1',
      fetchImpl,
    });

    expect(session).toEqual<NativeSession>({
      sessionToken: 'sess.jwt.2',
      refreshToken: 'refr_2', // rotated
      sessionId: 'sess_1',
      expiresInSeconds: 60,
    });

    const init = calls[0]!.init!;
    expect((init.headers as Record<string, string>)['x-publishable-key']).toBe('pk_test');
    expect(JSON.parse(init.body as string)).toEqual({ refresh_token: 'refr_1' });
  });

  it('keeps the presented refresh token when the response omits one', async () => {
    const { fetchImpl } = router({
      'POST /v1/client/sessions/sess_1/tokens': {
        body: { jwt: 'sess.jwt.2', session_id: 'sess_1', expires_in: 60 },
      },
    });
    const session = await refreshNativeSession({
      baseUrl: BASE,
      publishableKey: 'pk_test',
      sessionId: 'sess_1',
      refreshToken: 'refr_1',
      fetchImpl,
    });
    expect(session?.refreshToken).toBe('refr_1');
  });

  it('returns null on a non-2xx (expired/rotated refresh token)', async () => {
    const { fetchImpl } = router({ 'POST /v1/client/sessions/sess_1/tokens': { status: 401 } });
    await expect(
      refreshNativeSession({
        baseUrl: BASE,
        publishableKey: 'pk_test',
        sessionId: 'sess_1',
        refreshToken: 'refr_1',
        fetchImpl,
      }),
    ).resolves.toBeNull();
  });
});

// ── serialize / parse ───────────────────────────────────────────────────────

describe('serializeNativeSession / parseNativeSession', () => {
  it('round-trips a session', () => {
    const s: NativeSession = {
      sessionToken: 'j',
      refreshToken: 'r',
      sessionId: 'sess_1',
      expiresInSeconds: 60,
    };
    expect(parseNativeSession(serializeNativeSession(s))).toEqual(s);
  });

  it('returns null for absent, malformed, or incomplete values', () => {
    expect(parseNativeSession(null)).toBeNull();
    expect(parseNativeSession('')).toBeNull();
    expect(parseNativeSession('{not json')).toBeNull();
    expect(parseNativeSession(JSON.stringify({ sessionToken: 'j' }))).toBeNull();
  });
});

// ── NativeSessionManager ───────────────────────────────────────────────────────

const session1: NativeSession = {
  sessionToken: 'sess.jwt.1',
  refreshToken: 'refr_1',
  sessionId: 'sess_1',
  expiresInSeconds: 60,
};

describe('NativeSessionManager', () => {
  it('refresh rotates the session and persists via persist + onChange', async () => {
    const { fetchImpl } = router({
      'POST /v1/client/sessions/sess_1/tokens': {
        body: { jwt: 'sess.jwt.2', session_id: 'sess_1', expires_in: 60, refresh_token: 'refr_2' },
      },
    });
    const persisted: NativeSession[] = [];
    const observed: NativeSession[] = [];
    const mgr = new NativeSessionManager({
      baseUrl: BASE,
      publishableKey: 'pk_test',
      initial: session1,
      fetchImpl,
      persist: (s) => persisted.push(s),
    });
    mgr.onChange((s) => observed.push(s));

    const rotated = await mgr.refresh();

    expect(rotated?.refreshToken).toBe('refr_2');
    expect(mgr.current?.sessionToken).toBe('sess.jwt.2');
    // Seeding `initial` does NOT notify; only the rotation does.
    expect(persisted).toEqual([rotated]);
    expect(observed).toEqual([rotated]);
  });

  it('getToken auto-refreshes when the current token is near expiry', async () => {
    const { fetchImpl, calls } = router({
      'POST /v1/client/sessions/sess_1/tokens': {
        body: { jwt: 'sess.jwt.2', session_id: 'sess_1', expires_in: 60, refresh_token: 'refr_2' },
      },
    });
    let clock = 1_000_000;
    const mgr = new NativeSessionManager({
      baseUrl: BASE,
      publishableKey: 'pk_test',
      initial: session1, // expires at clock + 60s
      fetchImpl,
      now: () => clock,
    });

    // Comfortably fresh → no refresh, original token.
    expect(await mgr.getToken()).toBe('sess.jwt.1');
    expect(calls).toHaveLength(0);

    // Jump to within the 10s lead window → one refresh, rotated token.
    clock += 55_000;
    expect(await mgr.getToken()).toBe('sess.jwt.2');
    expect(calls).toHaveLength(1);
  });

  it('getToken keeps the existing token when the refresh fails', async () => {
    const { fetchImpl } = router({ 'POST /v1/client/sessions/sess_1/tokens': { status: 500 } });
    let clock = 1_000_000;
    const mgr = new NativeSessionManager({
      baseUrl: BASE,
      publishableKey: 'pk_test',
      initial: session1,
      fetchImpl,
      now: () => clock,
    });
    clock += 55_000; // inside the lead window
    expect(await mgr.getToken()).toBe('sess.jwt.1'); // stale, not null
    expect(mgr.current?.sessionToken).toBe('sess.jwt.1');
  });

  it('getToken returns null when signed out', async () => {
    const { fetchImpl } = router({});
    const mgr = new NativeSessionManager({ baseUrl: BASE, publishableKey: 'pk_test', fetchImpl });
    expect(await mgr.getToken()).toBeNull();
  });

  it('authHeaders carry the bearer and the publishable key', async () => {
    const { fetchImpl } = router({});
    const mgr = new NativeSessionManager({
      baseUrl: BASE,
      publishableKey: 'pk_test',
      initial: session1,
      fetchImpl,
      now: () => 1_000_000, // fresh, no refresh
    });
    expect(await mgr.authHeaders()).toEqual({
      Authorization: 'Bearer sess.jwt.1',
      'x-publishable-key': 'pk_test',
    });
  });

  it('authHeaders omit the bearer when signed out', async () => {
    const { fetchImpl } = router({});
    const mgr = new NativeSessionManager({ baseUrl: BASE, publishableKey: 'pk_test', fetchImpl });
    expect(await mgr.authHeaders()).toEqual({ 'x-publishable-key': 'pk_test' });
  });

  it('refresh is single-flight across concurrent callers', async () => {
    const { fetchImpl, calls } = router({
      'POST /v1/client/sessions/sess_1/tokens': {
        body: { jwt: 'sess.jwt.2', session_id: 'sess_1', expires_in: 60, refresh_token: 'refr_2' },
      },
    });
    let clock = 1_000_000;
    const mgr = new NativeSessionManager({
      baseUrl: BASE,
      publishableKey: 'pk_test',
      initial: session1,
      fetchImpl,
      now: () => clock,
    });
    clock += 55_000;
    const [a, b] = await Promise.all([mgr.getToken(), mgr.getToken()]);
    expect(a).toBe('sess.jwt.2');
    expect(b).toBe('sess.jwt.2');
    expect(calls).toHaveLength(1); // one refresh shared, not two
  });
});

describe('NativeSessionManager across contexts sharing one store', () => {
  const jwtWith = (expSeconds: number) => `h.${btoa(JSON.stringify({ exp: expSeconds })).replace(/=+$/, '')}.s`;

  it('refreshes once: the second context adopts the first one\'s rotation instead of spending the old refresh token', async () => {
    let store: NativeSession = { ...session1, sessionToken: jwtWith(1) };
    let refreshes = 0;
    const fetchImpl = (async () => {
      refreshes++;
      return new Response(JSON.stringify({ jwt: jwtWith(Math.floor(Date.now() / 1000) + 600), session_id: 'sess_1', expires_in: 600, refresh_token: 'refr_2' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const make = () =>
      new NativeSessionManager({
        baseUrl: BASE,
        publishableKey: 'pk_test',
        initial: store,
        fetchImpl,
        now: () => Date.now(),
        reload: () => store,
        persist: (s) => {
          store = s;
        },
      });
    const popup = make();
    const worker = make();

    // A Web Lock makes the two contexts take turns; model it with a chain.
    let chain: Promise<unknown> = Promise.resolve();
    vi.stubGlobal('navigator', { locks: { request: (_n: string, fn: () => Promise<unknown>) => (chain = chain.then(fn, fn)) } });
    try {
      const [a, b] = await Promise.all([popup.refresh(), worker.refresh()]);
      expect(refreshes).toBe(1);
      expect(a?.refreshToken).toBe('refr_2');
      expect(b?.refreshToken).toBe('refr_2');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('adopt ignores the same refresh token and another session', () => {
    const mgr = new NativeSessionManager({ baseUrl: BASE, publishableKey: 'pk_test', initial: session1 });
    expect(mgr.adopt(session1)).toBe(false);
    expect(mgr.adopt({ ...session1, sessionId: 'sess_other', refreshToken: 'r9' })).toBe(false);
    expect(mgr.adopt({ ...session1, refreshToken: 'refr_9' })).toBe(true);
    expect(mgr.current?.refreshToken).toBe('refr_9');
  });
});
