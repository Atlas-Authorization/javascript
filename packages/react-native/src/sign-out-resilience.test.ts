import { afterEach, describe, expect, it } from 'vitest';
import { SignOutError, type TombstoneStore } from '@atlasauth/js';
import { AtlasStore, createAtlasStore } from './store';
import { createInMemoryTombstoneStore, type TokenStorage } from './storage';

/**
 * A sign-out the server never confirmed must not be undone: the session is
 * still alive server-side, and a token the sign-out could not clear (or a
 * later boot that finds one) would re-adopt it. The store remembers the session
 * it signed out of — in the app's `tombstoneStore` — and refuses it, re-trying
 * the revoke in the background with the token it dropped.
 */

const FRONTEND = 'https://fapi.example.test';

const b64 = (o: unknown) =>
  Buffer.from(JSON.stringify(o)).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const jwtFor = (sid: string) => `${b64({ alg: 'none' })}.${b64({ sid, sub: 'user_1', exp: 9999999999 })}.sig`;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const USER = {
  id: 'user_1',
  first_name: 'Ada',
  last_name: null,
  username: null,
  image_url: null,
  public_metadata: {},
  unsafe_metadata: {},
  mfa_enabled: false,
  has_password: true,
};
const signedIn = (sid: string) => json({ user: USER, session: { id: sid, status: 'active', last_active_organization_id: null } });

function fakeStorage(initial: string | null = null): TokenStorage & { value: string | null } {
  const s = {
    value: initial,
    getToken: () => s.value,
    setToken: (t: string) => {
      s.value = t;
    },
    clearToken: () => {
      s.value = null;
    },
  };
  return s;
}

type Call = { method: string; path: string; auth: string | null; pk: string | null };
type Route = (method: string, path: string, auth: string | null) => Response | undefined;

const stores: AtlasStore[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.dispose();
});

function make(
  route: Route,
  storage: TokenStorage,
  tombstoneStore?: TombstoneStore,
  extra: { signOutRetryDelaysMs?: number[] } = {},
) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = new Headers(init?.headers);
    const auth = headers.get('authorization');
    calls.push({ method, path: url.pathname, auth, pk: headers.get('x-publishable-key') });
    return route(method, url.pathname, auth) ?? json(null, 404);
  }) as typeof fetch;
  const store = createAtlasStore({
    publishableKey: 'pk_test_123',
    frontendApi: FRONTEND,
    storage,
    fetchImpl,
    ...(tombstoneStore ? { tombstoneStore } : {}),
    ...extra,
  });
  stores.push(store);
  return { store, calls };
}

const revokes = (calls: Call[]) => calls.filter((c) => c.path.endsWith('/revoke'));

describe('AtlasStore signOut() resilience', () => {
  it('revokes with the stored token, clears it, and resolves { revoked: true }', async () => {
    const token = jwtFor('sess_1');
    const storage = fakeStorage(token);
    const { store, calls } = make((method, path) => {
      if (path === '/v1/client') return signedIn('sess_1');
      if (method === 'POST' && path === '/v1/client/sessions/sess_1/revoke') return json({ status: 'revoked' });
    }, storage);
    await store.bootstrap();
    expect(store.getSnapshot().status).toBe('signed_in');

    const result = await store.signOut();

    expect(result).toEqual({ revoked: true });
    expect(revokes(calls)).toHaveLength(1);
    expect(revokes(calls)[0]).toMatchObject({ auth: `Bearer ${token}`, pk: 'pk_test_123' });
    expect(storage.value).toBeNull();
    expect(store.getSnapshot()).toMatchObject({ status: 'signed_out', user: null, session: null, claims: null });
  });

  it('a failed revoke (503 twice) still signs out, resolves { revoked: false }, and a re-boot does not re-adopt', async () => {
    const token = jwtFor('sess_1');
    const storage = fakeStorage(token);
    const { store, calls } = make(
      (method, path) => {
        if (path === '/v1/client') return signedIn('sess_1');
        if (path.endsWith('/revoke')) return json({}, 503);
      },
      storage,
      undefined,
      { signOutRetryDelaysMs: [5] },
    );
    await store.bootstrap();

    const result = await store.signOut();

    expect(result).toEqual({ revoked: false });
    expect(revokes(calls)).toHaveLength(2);
    expect(storage.value).toBeNull();
    expect(store.getSnapshot().status).toBe('signed_out');
    // The background re-try authenticates with the token sign-out dropped.
    await expect.poll(() => revokes(calls).length).toBe(3);
    expect(revokes(calls)[2]?.auth).toBe(`Bearer ${token}`);

    // The token comes back (a storage write that raced the sign-out, a restore…):
    // the next boot still refuses the session and drops it again.
    storage.value = token;
    await store.bootstrap();
    expect(store.getSnapshot().status).toBe('signed_out');
    expect(store.getSnapshot().user).toBeNull();
    expect(storage.value).toBeNull();
  });

  it('a store created later (app restart) with the persisted tombstones stays signed out; its background revoke clears the tombstone', async () => {
    const token = jwtFor('sess_1');
    const tombstones = createInMemoryTombstoneStore();
    let revokeWorks = false;
    const route: Route = (method, path) => {
      if (path === '/v1/client') return signedIn('sess_1');
      if (path.endsWith('/sessions/sess_1/revoke')) return revokeWorks ? json({ status: 'revoked' }) : json({}, 503);
    };
    const first = make(route, fakeStorage(token), tombstones);
    await first.store.bootstrap();
    await first.store.signOut();
    first.store.dispose();

    // Relaunch: the token survived (a store whose clear failed), the server still accepts it.
    revokeWorks = true;
    const relaunched = make(route, fakeStorage(token), tombstones);
    await relaunched.store.bootstrap();
    expect(relaunched.store.getSnapshot().status).toBe('signed_out');
    await expect.poll(() => revokes(relaunched.calls).length).toBe(1);
    expect(revokes(relaunched.calls)[0]?.auth).toBe(`Bearer ${token}`);

    // The revoke landed, so the tombstone is gone: a third launch is no longer refused.
    await expect
      .poll(async () => {
        const raw = await tombstones.getItem(`atlas:signed-out-sessions:${FRONTEND}`);
        return raw ? (JSON.parse(raw) as unknown[]).length : 0;
      })
      .toBe(0);
    const third = make(route, fakeStorage(token), tombstones);
    await third.store.bootstrap();
    expect(third.store.getSnapshot().status).toBe('signed_in');
  });

  it('a new sign-in (a different session) is adopted after a failed sign-out', async () => {
    const storage = fakeStorage(jwtFor('sess_1'));
    const { store } = make((method, path, auth) => {
      if (path === '/v1/client') return signedIn(auth === `Bearer ${jwtFor('sess_2')}` ? 'sess_2' : 'sess_1');
      if (path.endsWith('/revoke')) return json({}, 503);
    }, storage);
    await store.bootstrap();
    await store.signOut();

    storage.value = jwtFor('sess_2');
    await store.bootstrap();
    expect(store.getSnapshot().status).toBe('signed_in');
    expect(store.getSnapshot().claims?.sid).toBe('sess_2');
  });

  it('{ strict: true } rejects with SignOutError after the local sign-out', async () => {
    const storage = fakeStorage(jwtFor('sess_1'));
    const { store } = make((method, path) => {
      if (path === '/v1/client') return signedIn('sess_1');
      if (path.endsWith('/revoke')) return json({}, 503);
    }, storage);
    await store.bootstrap();

    const error = await store.signOut({ strict: true }).then(
      () => null,
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(SignOutError);
    expect(error).toMatchObject({ code: 'SIGN_OUT_REVOKE_FAILED', sessionId: 'sess_1', status: 503 });
    expect(storage.value).toBeNull();
    expect(store.getSnapshot().status).toBe('signed_out');
  });

  it('{ strict: true } resolves when the revoke is confirmed', async () => {
    const { store } = make((method, path) => {
      if (path === '/v1/client') return signedIn('sess_1');
      if (path.endsWith('/revoke')) return json({ status: 'revoked' });
    }, fakeStorage(jwtFor('sess_1')));
    await store.bootstrap();
    await expect(store.signOut({ strict: true })).resolves.toEqual({ revoked: true });
  });

  it('reports a promoted active_session_id (not adopted: no token for it on a bearer client)', async () => {
    const storage = fakeStorage(jwtFor('sess_1'));
    const { store } = make((method, path) => {
      if (path === '/v1/client') return signedIn('sess_1');
      if (path.endsWith('/sessions/sess_1/revoke')) return json({ status: 'revoked', active_session_id: 'sess_2' });
    }, storage);
    await store.bootstrap();

    const result = await store.signOut();

    expect(result).toEqual({ revoked: true, activeSessionId: 'sess_2' });
    expect(store.getSnapshot().status).toBe('signed_out');
  });

  it('finds the session with GET /v1/client when the token carries no sid', async () => {
    const token = `${b64({ alg: 'none' })}.${b64({ sub: 'user_1', exp: 9999999999 })}.sig`;
    const storage = fakeStorage(token);
    const { store, calls } = make((method, path, auth) => {
      if (path === '/v1/client') return auth ? signedIn('sess_9') : json({ user: null, session: null });
      if (path === '/v1/client/sessions/sess_9/revoke') return json({ status: 'revoked' });
    }, storage);

    const result = await store.signOut();

    expect(result).toEqual({ revoked: true });
    expect(revokes(calls).map((c) => c.path)).toEqual(['/v1/client/sessions/sess_9/revoke']);
    expect(storage.value).toBeNull();
  });

  it('signs out with no token at all without calling revoke', async () => {
    const { store, calls } = make((method, path) => {
      if (path === '/v1/client') return json({ user: null, session: null });
    }, fakeStorage(null));
    await expect(store.signOut()).resolves.toEqual({ revoked: true });
    expect(revokes(calls)).toHaveLength(0);
    expect(store.getSnapshot().status).toBe('signed_out');
  });

  it('a storage adapter whose clear throws still signs out, and the tombstone refuses the token next boot', async () => {
    const token = jwtFor('sess_1');
    const storage: TokenStorage = {
      getToken: () => token,
      setToken: () => undefined,
      clearToken: () => {
        throw new Error('keychain locked');
      },
    };
    const { store } = make((method, path) => {
      if (path === '/v1/client') return signedIn('sess_1');
      if (path.endsWith('/revoke')) return json({}, 503);
    }, storage);
    await store.bootstrap();

    await expect(store.signOut()).resolves.toEqual({ revoked: false });
    expect(store.getSnapshot().status).toBe('signed_out');
    await store.bootstrap();
    expect(store.getSnapshot().status).toBe('signed_out');
  });
});

describe('AtlasStore email delivery', () => {
  it('reads InstanceSettings.emailDelivery from /v1/appearance', async () => {
    const { store } = make((method, path) => {
      if (path === '/v1/appearance') {
        return json({ email_delivery: { available: false, password_reset: false, password_sign_up: false } });
      }
    }, fakeStorage(null));
    await expect(store.getEmailDelivery()).resolves.toEqual({
      available: false,
      passwordReset: false,
      passwordSignUp: false,
    });
  });

  it('reads as available when the server omits it or cannot be reached', async () => {
    const omitted = make((method, path) => (path === '/v1/appearance' ? json({}) : undefined), fakeStorage(null));
    await expect(omitted.store.getEmailDelivery()).resolves.toEqual({
      available: true,
      passwordReset: true,
      passwordSignUp: true,
    });
    const down = make(() => json({}, 503), fakeStorage(null));
    await expect(down.store.getEmailDelivery()).resolves.toEqual({
      available: true,
      passwordReset: true,
      passwordSignUp: true,
    });
  });
});
