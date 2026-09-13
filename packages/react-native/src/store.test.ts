import { describe, expect, it } from 'vitest';
import { AtlasStore, createAtlasStore } from './store';
import type { TokenStorage } from './storage';

/**
 * These tests exercise the REAL store against the REAL `@atlasauth/js` flow driver,
 * with only `fetch` and the storage adapter faked. No DOM, no renderer, no RN
 * runtime — the store is where all behaviour lives, so this is where it is
 * pinned.
 */

const FRONTEND = 'https://fapi.example.test';

function b64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj))
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** A syntactically real, unsigned JWT the store can decode for claims. */
function makeJwt(claims: Record<string, unknown>): string {
  return `eyJhbGciOiJub25lIn0.${b64url(claims)}.sig`;
}

/** A fake TokenStorage backed by a mutable local, so tests can inspect it. */
function fakeStorage(initial: string | null = null): TokenStorage & { value: string | null } {
  const store = {
    value: initial,
    getToken: () => store.value,
    setToken: (t: string) => {
      store.value = t;
    },
    clearToken: () => {
      store.value = null;
    },
  };
  return store;
}

type Handler = (init?: RequestInit) => { status?: number; body?: unknown };

/** Route fake responses by `METHOD /path`. Records every request for asserts. */
function router(handlers: Record<string, Handler>): {
  fetchImpl: typeof fetch;
  calls: Array<{ method: string; path: string; body: unknown }>;
} {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const path = new URL(url).pathname;
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ method, path, body });
    const handler = handlers[`${method} ${path}`];
    if (!handler) return new Response('null', { status: 404 });
    const { status = 200, body: resBody } = handler(init);
    return new Response(resBody === undefined ? null : JSON.stringify(resBody), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const USER = {
  id: 'user_1',
  first_name: 'Ada',
  last_name: 'Lovelace',
  username: null,
  image_url: null,
  public_metadata: {},
  unsafe_metadata: {},
  mfa_enabled: false,
  has_password: true,
};
const SESSION = { id: 'sess_1', status: 'active', last_active_organization_id: null };

function makeStore(
  handlers: Record<string, Handler>,
  storage: TokenStorage,
): { store: AtlasStore; calls: Array<{ method: string; path: string; body: unknown }> } {
  const { fetchImpl, calls } = router(handlers);
  const store = createAtlasStore({
    publishableKey: 'pk_test_123',
    frontendApi: FRONTEND,
    storage,
    fetchImpl,
  });
  return { store, calls };
}

describe('AtlasStore bootstrap', () => {
  it('boots signed-in from a token in storage and fetches the user', async () => {
    const storage = fakeStorage(makeJwt({ sub: 'user_1', sid: 'sess_1', exp: 9999999999 }));
    const { store } = makeStore({ 'GET /v1/client': () => ({ body: { user: USER, session: SESSION } }) }, storage);

    await store.bootstrap();

    const state = store.getSnapshot();
    expect(state.status).toBe('signed_in');
    expect(state.user?.id).toBe('user_1');
    expect(state.claims?.sub).toBe('user_1');
    expect(await store.getToken()).toBe(storage.getToken());
  });

  it('boots signed-out when storage is empty', async () => {
    const { store } = makeStore({}, fakeStorage(null));
    await store.bootstrap();
    expect(store.getSnapshot().status).toBe('signed_out');
  });

  it('clears a token the server no longer accepts and boots signed-out', async () => {
    const storage = fakeStorage(makeJwt({ sub: 'user_1', sid: 'sess_1', exp: 9999999999 }));
    const { store } = makeStore({ 'GET /v1/client': () => ({ body: { user: null, session: null } }) }, storage);

    await store.bootstrap();

    expect(store.getSnapshot().status).toBe('signed_out');
    expect(storage.value).toBeNull();
  });
});

describe('AtlasStore password sign-in', () => {
  const jwt = makeJwt({ sub: 'user_1', sid: 'sess_1', exp: 9999999999 });
  const handlers: Record<string, Handler> = {
    'POST /v1/client/sign_ins': () => ({
      body: { id: 'att_1', status: 'needs_first_factor', supported_first_factors: ['password'] },
    }),
    'POST /v1/client/sign_ins/att_1/attempt_first_factor': () => ({
      body: { id: 'att_1', status: 'complete', created_session_id: 'sess_1', ticket: 'tkt_1' },
    }),
    'POST /v1/client/tickets/exchange': () => ({ body: { jwt } }),
    'GET /v1/client': () => ({ body: { user: USER, session: SESSION } }),
  };

  it('signs in, exchanges the ticket, and PERSISTS the token to storage', async () => {
    const storage = fakeStorage(null);
    const { store } = makeStore(handlers, storage);

    const result = await store.signInWithPassword({ identifier: 'ada@example.test', password: 'pw' });

    expect(result.status).toBe('complete');
    // Mutation-check: the whole point is persistence. If signInWithPassword did
    // NOT write the token, storage.value stays null, the store stays signed-out,
    // and both of these assertions fail.
    expect(storage.value).toBe(jwt);
    expect(store.getSnapshot().status).toBe('signed_in');
    expect(store.getSnapshot().user?.id).toBe('user_1');
  });

  it('returns needs_more (and stays signed-out) when a second factor is owed', async () => {
    const storage = fakeStorage(null);
    const { store } = makeStore(
      {
        'POST /v1/client/sign_ins': () => ({
          body: { id: 'att_1', status: 'needs_first_factor', supported_first_factors: ['password'] },
        }),
        'POST /v1/client/sign_ins/att_1/attempt_first_factor': () => ({
          body: { id: 'att_1', status: 'needs_second_factor' },
        }),
      },
      storage,
    );

    const result = await store.signInWithPassword({ identifier: 'ada@example.test', password: 'pw' });

    expect(result.status).toBe('needs_more');
    expect(result.attemptStatus).toBe('needs_second_factor');
    expect(storage.value).toBeNull();
    expect(store.getSnapshot().status).toBe('loading'); // never advanced to signed_in
  });
});

describe('AtlasStore sign-out', () => {
  it('clears the token and resets to signed-out', async () => {
    const storage = fakeStorage(makeJwt({ sub: 'user_1', sid: 'sess_1', exp: 9999999999 }));
    const { store } = makeStore({ 'GET /v1/client': () => ({ body: { user: USER, session: SESSION } }) }, storage);

    await store.bootstrap();
    expect(store.getSnapshot().status).toBe('signed_in');

    await store.signOut();

    expect(storage.value).toBeNull();
    expect(await store.getToken()).toBeNull();
    expect(store.getSnapshot().status).toBe('signed_out');
    expect(store.getSnapshot().user).toBeNull();
  });
});

describe('AtlasStore OAuth', () => {
  it('startOAuth returns the provider authorization URL', async () => {
    const { store, calls } = makeStore(
      {
        'POST /v1/client/sign_ins/oauth': () => ({
          body: { authorization_url: 'https://accounts.google.com/o/oauth2/auth?x=1' },
        }),
      },
      fakeStorage(null),
    );

    const { authorizationUrl } = await store.startOAuth({
      provider: 'google',
      redirectUrl: 'myapp://oauth-callback',
    });

    expect(authorizationUrl).toBe('https://accounts.google.com/o/oauth2/auth?x=1');
    expect(calls[0]?.body).toEqual({ provider: 'google', redirect_url: 'myapp://oauth-callback' });
  });

  it('completeOAuthRedirect exchanges the ticket from a deep-link URL and signs in', async () => {
    const jwt = makeJwt({ sub: 'user_1', sid: 'sess_1', exp: 9999999999 });
    const storage = fakeStorage(null);
    const { store } = makeStore(
      {
        'POST /v1/client/tickets/exchange': () => ({ body: { jwt } }),
        'GET /v1/client': () => ({ body: { user: USER, session: SESSION } }),
      },
      storage,
    );

    const result = await store.completeOAuthRedirect(
      'myapp://oauth-callback?__atlas_attempt=att_9&__atlas_ticket=tkt_9',
    );

    expect(result.status).toBe('complete');
    expect(storage.value).toBe(jwt);
    expect(store.getSnapshot().status).toBe('signed_in');
  });
});

describe('AtlasStore provider token', () => {
  it('reads the user own live provider token via @atlasauth/js', async () => {
    const { store } = makeStore(
      {
        'GET /v1/client/me/external_accounts/google/token': () => ({
          body: { provider: 'google', access_token: 'ya29.abc', expires_at: 123, scopes: ['email'] },
        }),
      },
      fakeStorage(makeJwt({ sub: 'user_1', sid: 'sess_1', exp: 9999999999 })),
    );

    const token = await store.getProviderToken('google');

    expect(token).toEqual({
      provider: 'google',
      accessToken: 'ya29.abc',
      expiresAt: 123,
      scopes: ['email'],
    });
  });

  it('sends the stored token as a bearer header on authenticated calls', async () => {
    const jwt = makeJwt({ sub: 'user_1', sid: 'sess_1', exp: 9999999999 });
    let seenAuth: string | null = null;
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      seenAuth = new Headers(init?.headers).get('authorization');
      return new Response(JSON.stringify({ user: USER, session: SESSION }), { status: 200 });
    }) as typeof fetch;
    const store = createAtlasStore({
      publishableKey: 'pk_test_123',
      frontendApi: FRONTEND,
      storage: fakeStorage(jwt),
      fetchImpl,
    });

    await store.bootstrap();

    expect(seenAuth).toBe(`Bearer ${jwt}`);
  });
});
