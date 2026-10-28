import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionTombstones } from '@atlasauth/js';
import { createAtlasClient, type AtlasClient } from './client';

/**
 * A sign-out the server never confirmed must not be undone by the next re-check:
 * the refresh cookie is still valid, and a reload / a failed token refresh / a
 * sibling tab / a tab opened later all re-boot from it. The client remembers
 * the session it signed out of (a tombstone in localStorage, shared by every
 * tab) and refuses to re-adopt it. Driven through a mocked `fetch`, like the
 * rest of the client tests.
 */
const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
// A fixed exp, so jwtFor(sid) is the same string however slow the run (a
// per-call Date.now() changed the token when a second ticked mid-test).
const EXP = Math.floor(Date.now() / 1000) + 3600;
const jwtFor = (sid: string) =>
  `${b64({ alg: 'none' })}.${b64({ sid, sub: 'user_1', exp: EXP })}.sig`;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const signedIn = (sid: string) =>
  json({
    session: { id: sid, status: 'active', last_active_organization_id: null },
    user: { id: 'user_1' },
    jwt: jwtFor(sid),
  });

type Route = (url: string, init?: RequestInit) => Response | Promise<Response> | undefined;

const clients: AtlasClient[] = [];
beforeEach(() => {
  // Tombstones are shared by every tab (localStorage), so start each test clean.
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(() => {
  for (const client of clients.splice(0)) client.destroy();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function open(route: Route) {
  const calls: string[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    const answer = await route(url, init);
    if (answer) return answer;
    return json({});
  }) as unknown as typeof fetch;
  const client = createAtlasClient({
    publishableKey: 'pk_test_x',
    frontendApi: 'https://fapi.example',
    fetchImpl,
  });
  clients.push(client);
  return { client, calls };
}

const revokes = (calls: string[]) => calls.filter((c) => c.includes('/revoke'));
const boots = (calls: string[]) => calls.filter((c) => c === 'GET https://fapi.example/v1/client');

describe('signOut() resilience', () => {
  it('resolves { revoked: true } when the server confirms', async () => {
    const { client } = open((url) => {
      if (url.endsWith('/v1/client')) return signedIn('sess_1');
      if (url.endsWith('/sessions/sess_1/revoke')) return json({ status: 'revoked' });
    });
    await client.boot();
    expect(client.snapshot().status).toBe('signed_in');

    await expect(client.signOut({ frontchannel: false })).resolves.toEqual({ revoked: true });
    expect(client.snapshot().status).toBe('signed_out');
    expect(client.snapshot().user).toBeNull();
    await expect(client.getToken()).resolves.toBeNull();
  });

  it('retries once, then signs out locally and never re-adopts the session on reload or refresh', async () => {
    const { client, calls } = open((url) => {
      if (url.endsWith('/v1/client')) return signedIn('sess_1');
      if (url.endsWith('/sessions/sess_1/revoke')) return json({}, 503);
      if (url.endsWith('/sessions/sess_1/tokens')) return json({ jwt: jwtFor('sess_1'), session_id: 'sess_1' });
    });
    await client.boot();
    expect(client.snapshot().status).toBe('signed_in');

    // Fake timers from here, so the scheduled background re-try can be reached.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await expect(client.signOut({ frontchannel: false })).resolves.toEqual({ revoked: false });
    expect(revokes(calls)).toHaveLength(2);
    expect(client.snapshot().status).toBe('signed_out');

    // A re-check sees the still-valid cookie session… and stays signed out.
    await client.reload();
    expect(boots(calls).length).toBeGreaterThan(1);
    expect(client.snapshot().status).toBe('signed_out');
    expect(client.snapshot().user).toBeNull();
    // getToken() (which refreshes when nothing is cached) does not resurrect it.
    await expect(client.getToken()).resolves.toBeNull();
    expect(client.snapshot().status).toBe('signed_out');

    // The revoke is re-tried in the background.
    const before = revokes(calls).length;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(revokes(calls).length).toBeGreaterThan(before);
  });

  it('a tab opened after a failed revoke is signed out; a later revoke clears the tombstone; a new sign-in is adopted', async () => {
    let revokeWorks = false;
    let cookieSession: string | null = 'sess_1';
    const route: Route = (url) => {
      if (url.endsWith('/v1/client')) return cookieSession ? signedIn(cookieSession) : json({ session: null, user: null });
      if (url.endsWith('/sessions/sess_1/revoke')) {
        if (!revokeWorks) return json({}, 503);
        cookieSession = null; // the server ended it and cleared the cookies
        return json({ status: 'revoked' });
      }
    };
    const tab1 = open(route);
    await tab1.client.boot();
    expect(tab1.client.snapshot().status).toBe('signed_in');
    await tab1.client.signOut({ frontchannel: false });
    expect(tab1.client.snapshot().status).toBe('signed_out');
    tab1.client.destroy();

    // (1) A brand-new tab (fresh client, fresh sessionStorage) boots from the
    // still-valid cookie session — and refuses it.
    sessionStorage.clear();
    const tab2 = open(route);
    await tab2.client.boot();
    expect(tab2.calls).toContain('GET https://fapi.example/v1/client');
    expect(tab2.client.snapshot().status).toBe('signed_out');
    expect(tab2.client.snapshot().user).toBeNull();
    // It retried the revoke in the background (still failing).
    await vi.waitFor(() => expect(revokes(tab2.calls).length).toBeGreaterThan(0));
    expect(new SessionTombstones({ frontendApi: 'https://fapi.example' }).has('sess_1')).toBe(true);
    await new Promise((r) => setTimeout(r, 0)); // let that background attempt settle

    // (2) The server is reachable again: the next re-check's background revoke
    // lands and the tombstone is cleared.
    revokeWorks = true;
    await tab2.client.reload();
    await vi.waitFor(() => expect(cookieSession).toBeNull());
    await vi.waitFor(() =>
      expect(new SessionTombstones({ frontendApi: 'https://fapi.example' }).has('sess_1')).toBe(false),
    );
    expect(tab2.client.snapshot().status).toBe('signed_out');

    // (3) Signing in again gives a new session id, which is adopted normally.
    cookieSession = 'sess_2';
    await tab2.client.reload();
    expect(tab2.client.snapshot().status).toBe('signed_in');
    expect(tab2.client.snapshot().session?.id).toBe('sess_2');
  });

  it('{ strict: true } rejects with a SignOutError after the local sign-out', async () => {
    const { client } = open((url) => {
      if (url.endsWith('/v1/client')) return signedIn('sess_1');
      if (url.endsWith('/revoke')) throw new TypeError('offline');
    });
    await client.boot();
    expect(client.snapshot().status).toBe('signed_in');

    const seen: string[] = [];
    client.subscribe((snap) => seen.push(snap.status));
    let error: unknown;
    await client.signOut({ strict: true, frontchannel: false }).catch((e: unknown) => {
      error = e;
    });
    expect((error as { name?: string }).name).toBe('SignOutError');
    expect((error as { code?: string }).code).toBe('SIGN_OUT_REVOKE_FAILED');
    expect((error as { sessionId?: string }).sessionId).toBe('sess_1');
    // The local sign-out had already happened when it rejected.
    expect(seen).toContain('signed_out');
    expect(client.snapshot().status).toBe('signed_out');
  });

  it('adopts a parked session the server promoted', async () => {
    let active = 'sess_1';
    const { client } = open((url) => {
      if (url.endsWith('/v1/client')) return signedIn(active);
      if (url.endsWith('/sessions/sess_1/revoke')) {
        active = 'sess_2';
        return json({ status: 'revoked', active_session_id: 'sess_2' });
      }
    });
    await client.boot();
    expect(client.snapshot().session?.id).toBe('sess_1');

    await expect(client.signOut({ frontchannel: false })).resolves.toEqual({
      revoked: true,
      activeSessionId: 'sess_2',
    });
    expect(client.snapshot().status).toBe('signed_in');
    expect(client.snapshot().session?.id).toBe('sess_2');
  });

  it('revokes the cookie session even when no token is cached', async () => {
    // Boot returns a session but no JWT, so nothing lands in the token cache.
    const { client, calls } = open((url) => {
      if (url.endsWith('/v1/client')) {
        return json({
          session: { id: 'sess_7', status: 'active', last_active_organization_id: null },
          user: { id: 'user_1' },
        });
      }
      if (url.endsWith('/sessions/sess_7/revoke')) return json({ status: 'revoked' });
    });
    await client.boot();
    expect(client.snapshot().status).toBe('signed_in');
    await client.signOut({ frontchannel: false });
    expect(revokes(calls)).toEqual(['POST https://fapi.example/v1/client/sessions/sess_7/revoke']);
  });

  it('called before boot, finds the session from the cookies (GET /v1/client) and revokes it', async () => {
    const { client, calls } = open((url) => {
      if (url.endsWith('/v1/client')) return signedIn('sess_9');
      if (url.endsWith('/sessions/sess_9/revoke')) return json({ status: 'revoked' });
    });
    await expect(client.signOut({ frontchannel: false })).resolves.toEqual({ revoked: true });
    expect(calls).toEqual([
      'GET https://fapi.example/v1/client',
      'POST https://fapi.example/v1/client/sessions/sess_9/revoke',
    ]);
    expect(client.snapshot().status).toBe('signed_out');
  });

  it('a sibling tab signing out of this session signs this tab out too', async () => {
    const { client, calls } = open((url) => {
      if (url.endsWith('/v1/client')) return signedIn('sess_1');
    });
    await client.boot();
    expect(client.snapshot().status).toBe('signed_in');

    // Another tab tombstoned sess_1; its write reaches this tab as a storage event.
    new SessionTombstones({ frontendApi: 'https://fapi.example' }).add('sess_1');
    window.dispatchEvent(new StorageEvent('storage', { key: null }));

    await vi.waitFor(() => expect(client.snapshot().status).toBe('signed_out'));
    expect(boots(calls).length).toBeGreaterThan(1);
    expect(client.snapshot().user).toBeNull();
    await expect(client.getToken()).resolves.toBeNull();
  });
});
