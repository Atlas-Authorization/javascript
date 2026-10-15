import { describe, expect, it, vi } from 'vitest';
import { SessionTombstones } from '@atlasauth/js';
import {
  ExtensionSignOutGuard,
  createAtlasClient,
  persistingBearerFetch,
  syncSessionToken,
} from './client';
import {
  StorageCache,
  createChromeTombstoneStore,
  createMemoryStorageArea,
  type ChromeStorageArea,
} from './storage';

/**
 * A sign-out the server never confirmed must not be undone — and in an
 * extension the threat is the OTHER surfaces: popup, options page, content
 * scripts and the service worker share one token in `chrome.storage`, each
 * with its own memory. A surface that booted before the sign-out must neither
 * adopt the signed-out session's token nor write back a token its refresh
 * rotated for it. Twin of @atlasauth/react's sign-out-resilience tests; a
 * "surface" (or a restart) is a fresh client over the same storage area.
 */

const FRONTEND = 'https://fapi.example.test';
const TOKEN_KEY = '__atlas_session_token';

function b64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const jwtFor = (sid: string, n = 1) =>
  `eyJhbGciOiJub25lIn0.${b64url({ sid, n, exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

type Call = { method: string; path: string; authorization: string | null };
type Route = (call: Call) => Response | Promise<Response> | undefined | void;

function fakeFetch(route: Route) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = {
      method: (init?.method ?? 'GET').toUpperCase(),
      path: new URL(String(input)).pathname,
      authorization: new Headers(init?.headers).get('authorization'),
    };
    calls.push(call);
    return ((await route(call)) as Response | undefined) ?? json(null, 404);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const revokes = (calls: Call[]) => calls.filter((c) => c.path.endsWith('/revoke'));
const tombstoned = async (area: ChromeStorageArea, sid: string) => {
  const t = new SessionTombstones({ frontendApi: FRONTEND, store: createChromeTombstoneStore(area) });
  await t.ready;
  return t.has(sid);
};

function surface(area: ChromeStorageArea, fetchImpl: typeof fetch) {
  return createAtlasClient({
    publishableKey: 'pk_test',
    frontendApi: FRONTEND,
    store: new StorageCache({ area }),
    fetchImpl,
    signOutRetryDelaysMs: [],
  });
}

describe('signOut() resilience', () => {
  it('resolves { revoked: true }, revoking with the dropped token, and clears chrome.storage', async () => {
    const area = createMemoryStorageArea();
    await area.set({ [TOKEN_KEY]: jwtFor('sess_1') });
    const { fetchImpl, calls } = fakeFetch((c) =>
      c.path === '/v1/client/sessions/sess_1/revoke' ? json({ status: 'revoked' }) : undefined,
    );
    const client = surface(area, fetchImpl);

    await expect(client.signOut()).resolves.toEqual({ revoked: true });
    expect(revokes(calls)).toEqual([
      { method: 'POST', path: '/v1/client/sessions/sess_1/revoke', authorization: `Bearer ${jwtFor('sess_1')}` },
    ]);
    expect(await client.getToken()).toBeNull();
    expect((await area.get(TOKEN_KEY))[TOKEN_KEY]).toBeUndefined();
  });

  it('retries once, then signs out locally; a stale surface cannot write a rotated token back', async () => {
    const area = createMemoryStorageArea();
    await area.set({ [TOKEN_KEY]: jwtFor('sess_1') });
    let releaseRefresh: (() => void) | null = null;
    const { fetchImpl, calls } = fakeFetch((c) => {
      if (c.path.endsWith('/revoke')) return json({}, 503);
      if (c.path === '/v1/client/sessions/sess_1/tokens') {
        return new Promise<Response>((resolve) => {
          releaseRefresh = () => resolve(json({ jwt: jwtFor('sess_1', 2) }));
        });
      }
    });
    // The service worker booted (and read the token) before the popup signed out.
    const worker = surface(area, fetchImpl);
    const popup = surface(area, fetchImpl);
    expect(await worker.getToken()).toBe(jwtFor('sess_1'));
    const inFlight = syncSessionToken(worker, { force: true });
    await vi.waitFor(() => expect(releaseRefresh).not.toBeNull());

    await expect(popup.signOut()).resolves.toEqual({ revoked: false });
    expect(revokes(calls).length).toBeGreaterThanOrEqual(2);
    await vi.waitFor(async () => expect(await tombstoned(area, 'sess_1')).toBe(true));

    // The worker's refresh lands after the sign-out: its write-back is refused.
    releaseRefresh!();
    await inFlight;
    expect((await area.get(TOKEN_KEY))[TOKEN_KEY]).toBeUndefined();
    expect(await worker.getToken()).toBeNull();
    // The background re-try authenticates as the dropped token.
    await vi.waitFor(() => expect(revokes(calls).length).toBeGreaterThan(2));
    expect(revokes(calls).every((c) => c.authorization === `Bearer ${jwtFor('sess_1')}`)).toBe(true);
  });

  it('a surface opened after a failed revoke refuses a token still stored; a later revoke clears the tombstone', async () => {
    const area = createMemoryStorageArea();
    await area.set({ [TOKEN_KEY]: jwtFor('sess_1') });
    let revokeWorks = false;
    const route: Route = (c) => {
      if (c.path === '/v1/client/sessions/sess_1/revoke') return revokeWorks ? json({ status: 'revoked' }) : json({}, 503);
      if (c.path === '/v1/client') return json({ session: null, user: null });
    };
    const first = fakeFetch(route);
    await surface(area, first.fetchImpl).signOut();
    await vi.waitFor(async () => expect(await tombstoned(area, 'sess_1')).toBe(true));

    // A stale write landed anyway (an older SDK on another surface).
    await area.set({ [TOKEN_KEY]: jwtFor('sess_1') });

    // (1) A new surface boots: the stored token is refused and removed, never
    // sent, and the revoke re-tried in the background as it (still failing).
    const second = fakeFetch(route);
    const tab2 = surface(area, second.fetchImpl);
    await tab2.fapi.get('/v1/client');
    expect(second.calls.find((c) => c.path === '/v1/client')!.authorization).toBeNull();
    expect((await area.get(TOKEN_KEY))[TOKEN_KEY]).toBeUndefined();
    await vi.waitFor(() => expect(revokes(second.calls).length).toBeGreaterThan(0));
    expect(revokes(second.calls)[0]!.authorization).toBe(`Bearer ${jwtFor('sess_1')}`);
    expect(await tombstoned(area, 'sess_1')).toBe(true);

    // (2) Reachable again: the next refusal's background revoke lands and the
    // tombstone is cleared.
    revokeWorks = true;
    await area.set({ [TOKEN_KEY]: jwtFor('sess_1') });
    const third = fakeFetch(route);
    const tab3 = surface(area, third.fetchImpl);
    expect(await tab3.getToken()).toBeNull();
    await vi.waitFor(async () => expect(await tombstoned(area, 'sess_1')).toBe(false));

    // (3) A new sign-in is a new session id, adopted normally.
    await tab3.setToken(jwtFor('sess_2'));
    expect(await tab3.getToken()).toBe(jwtFor('sess_2'));
  });

  it('{ strict: true } rejects with a SignOutError after the local sign-out', async () => {
    const area = createMemoryStorageArea();
    await area.set({ [TOKEN_KEY]: jwtFor('sess_1') });
    const { fetchImpl } = fakeFetch((c) => {
      if (c.path.endsWith('/revoke')) throw new TypeError('offline');
    });
    const client = surface(area, fetchImpl);
    const error = await client.signOut({ strict: true }).catch((e: unknown) => e);
    expect(error).toMatchObject({ name: 'SignOutError', code: 'SIGN_OUT_REVOKE_FAILED', sessionId: 'sess_1', status: 0 });
    expect(await client.getToken()).toBeNull();
  });

  it('reports a promoted active_session_id (no bearer credential comes with it)', async () => {
    const area = createMemoryStorageArea();
    await area.set({ [TOKEN_KEY]: jwtFor('sess_1') });
    const { fetchImpl } = fakeFetch((c) =>
      c.path.endsWith('/sessions/sess_1/revoke') ? json({ status: 'revoked', active_session_id: 'sess_2' }) : undefined,
    );
    const client = surface(area, fetchImpl);
    await expect(client.signOut()).resolves.toEqual({ revoked: true, activeSessionId: 'sess_2' });
    expect(await client.getToken()).toBeNull();
  });

  it('finds the session with GET /v1/client when the token names none', async () => {
    const area = createMemoryStorageArea();
    await area.set({ [TOKEN_KEY]: 'opaque-token' });
    const { fetchImpl, calls } = fakeFetch((c) => {
      if (c.path === '/v1/client') return json({ session: { id: 'sess_7' }, user: { id: 'user_1' } });
      if (c.path === '/v1/client/sessions/sess_7/revoke') return json({ status: 'revoked' });
    });
    await expect(surface(area, fetchImpl).signOut()).resolves.toEqual({ revoked: true });
    expect(revokes(calls).map((c) => [c.path, c.authorization])).toEqual([
      ['/v1/client/sessions/sess_7/revoke', 'Bearer opaque-token'],
    ]);
  });

  it('signed out already: resolves { revoked: true } without a request', async () => {
    const { fetchImpl, calls } = fakeFetch(() => undefined);
    await expect(surface(createMemoryStorageArea(), fetchImpl).signOut()).resolves.toEqual({ revoked: true });
    expect(calls).toHaveLength(0);
  });
});

describe('persistingBearerFetch with a sign-out guard (the React provider path)', () => {
  function setup(route: Route) {
    const area = createMemoryStorageArea();
    const store = new StorageCache({ area });
    const net = fakeFetch(route);
    const guard = new ExtensionSignOutGuard({
      publishableKey: 'pk_test',
      frontendApi: FRONTEND,
      fetchImpl: net.fetchImpl,
      tombstoneStore: store.tombstoneStore(),
      retryDelaysMs: [],
    });
    const wrapped = persistingBearerFetch(net.fetchImpl, store, guard);
    return { area, store, wrapped, ...net };
  }

  it("revoking the stored token's session tombstones it, drops the token, and a re-try still authenticates", async () => {
    const { area, store, wrapped, calls } = setup((c) => (c.path.endsWith('/revoke') ? json({}, 503) : undefined));
    await store.setToken(jwtFor('sess_1'));

    const first = await wrapped(`${FRONTEND}/v1/client/sessions/sess_1/revoke`, { method: 'POST' });
    expect(first.status).toBe(503);
    expect(await store.getToken()).toBeNull();
    await vi.waitFor(async () => expect(await tombstoned(area, 'sess_1')).toBe(true));

    // The provider's own retry: the token is gone from storage, the bearer is not.
    await wrapped(`${FRONTEND}/v1/client/sessions/sess_1/revoke`, { method: 'POST' });
    expect(revokes(calls).every((c) => c.authorization === `Bearer ${jwtFor('sess_1')}`)).toBe(true);
  });

  it('never sends nor writes back a token of a signed-out session', async () => {
    const { area, store, wrapped, calls } = setup((c) => {
      // Unreachable for revokes, so the tombstone stays for the whole test.
      if (c.path.endsWith('/revoke')) return json({}, 503);
      if (c.path === '/v1/client') return json({ session: null, user: null, jwt: jwtFor('sess_1', 3) });
    });
    await store.setToken(jwtFor('sess_1'));
    await wrapped(`${FRONTEND}/v1/client/sessions/sess_1/revoke`, { method: 'POST' });
    await vi.waitFor(async () => expect(await tombstoned(area, 'sess_1')).toBe(true));

    // Another surface's stale write lands; the next boot neither sends it nor
    // persists the rotated token a response carries for that session.
    await store.setToken(jwtFor('sess_1', 2));
    await wrapped(`${FRONTEND}/v1/client`);
    expect(calls.find((c) => c.path === '/v1/client')!.authorization).toBeNull();
    expect(await store.getToken()).toBeNull();
  });
});
