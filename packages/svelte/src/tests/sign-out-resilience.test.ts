import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import { SessionTombstones, SignOutError } from '@atlasauth/js';
import { createAtlasClient, type AtlasClient } from '../lib/context';

/**
 * A sign-out the server never confirmed must not be undone by the next re-check:
 * the refresh cookie is still valid, and a reload, a failed token refresh, a
 * sibling tab or a tab opened later all re-boot from it. The client remembers
 * the session it signed out of and refuses to re-adopt it.
 */
const FAPI = 'https://fapi.example';
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

async function boot(route: Route) {
  const calls: string[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    const answer = await route(url, init);
    if (answer) return answer;
    return json({});
  }) as unknown as typeof fetch;
  const client = createAtlasClient({ publishableKey: 'pk_test_x', frontendApi: FAPI, fetchImpl, manualBoot: true });
  clients.push(client);
  await client.boot();
  return { client, calls };
}

const revokes = (calls: string[]) => calls.filter((c) => c.includes('/revoke'));
const tombstoned = (sid: string) => new SessionTombstones({ frontendApi: FAPI }).has(sid);

describe('signOut() resilience', () => {
  it('resolves { revoked: true } when the server confirms', async () => {
    const { client } = await boot((url) => {
      if (url.endsWith('/v1/client')) return signedIn('sess_1');
      if (url.endsWith('/sessions/sess_1/revoke')) return json({ status: 'revoked' });
    });
    expect(get(client.status)).toBe('signed_in');

    const result = await client.signOut({ frontchannel: false });
    expect(result).toEqual({ revoked: true });
    expect(get(client.status)).toBe('signed_out');
    expect(get(client.user)).toBeNull();
    expect(await client.getToken()).toBeNull();
  });

  it('retries once, then signs out locally and never re-adopts the session on reload', async () => {
    const { client, calls } = await boot((url) => {
      if (url.endsWith('/v1/client')) return signedIn('sess_1');
      if (url.endsWith('/sessions/sess_1/revoke')) return json({}, 503);
    });
    expect(get(client.status)).toBe('signed_in');

    // The failed revoke is re-tried on a schedule (15 s, 1 min, 5 min).
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const result = await client.signOut({ frontchannel: false });
    expect(result).toEqual({ revoked: false });
    expect(revokes(calls)).toHaveLength(2);
    expect(get(client.status)).toBe('signed_out');
    expect(tombstoned('sess_1')).toBe(true);

    // A re-check sees the still-valid cookie session…
    await client.reload();
    expect(calls.filter((c) => c === `GET ${FAPI}/v1/client`).length).toBeGreaterThan(1);
    // …but stays signed out, and retries the revoke in the background.
    expect(get(client.status)).toBe('signed_out');
    expect(get(client.user)).toBeNull();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(revokes(calls).length).toBeGreaterThan(2);
    vi.useRealTimers();

    // A token refresh cannot resurrect it either: there is no token to refresh,
    // and the re-boot it falls back to refuses the session.
    expect(await client.getToken()).toBeNull();
    expect(get(client.status)).toBe('signed_out');
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
    const tab1 = await boot(route);
    expect(get(tab1.client.status)).toBe('signed_in');
    await tab1.client.signOut({ frontchannel: false });
    expect(get(tab1.client.status)).toBe('signed_out');
    tab1.client.destroy();

    // (1) A brand-new tab (fresh client, fresh sessionStorage) boots from the
    // still-valid cookie session — and refuses it.
    sessionStorage.clear();
    const tab2 = await boot(route);
    expect(tab2.calls).toContain(`GET ${FAPI}/v1/client`);
    expect(get(tab2.client.status)).toBe('signed_out');
    expect(get(tab2.client.user)).toBeNull();
    // It retried the revoke in the background (still failing).
    await vi.waitFor(() => expect(revokes(tab2.calls).length).toBeGreaterThan(0));
    expect(tombstoned('sess_1')).toBe(true);

    // (2) The server is reachable again: the next re-check's background revoke
    // lands and the tombstone is cleared.
    revokeWorks = true;
    await tab2.client.reload();
    await vi.waitFor(() => expect(cookieSession).toBeNull());
    await vi.waitFor(() => expect(tombstoned('sess_1')).toBe(false));
    expect(get(tab2.client.status)).toBe('signed_out');

    // (3) Signing in again gives a new session id, which is adopted normally.
    cookieSession = 'sess_2';
    await tab2.client.reload();
    expect(get(tab2.client.status)).toBe('signed_in');
    expect(get(tab2.client.session)?.id).toBe('sess_2');
  });

  it('a sibling tab signing out of this session signs this tab out too', async () => {
    const { client } = await boot((url) => {
      if (url.endsWith('/v1/client')) return signedIn('sess_1');
      if (url.endsWith('/sessions/sess_1/revoke')) return json({}, 503);
    });
    expect(get(client.status)).toBe('signed_in');

    // Another tab recorded the tombstone; this one hears it as a storage event.
    new SessionTombstones({ frontendApi: FAPI }).add('sess_1');
    window.dispatchEvent(new StorageEvent('storage', { key: null }));

    await vi.waitFor(() => expect(get(client.status)).toBe('signed_out'));
    expect(get(client.user)).toBeNull();
    expect(await client.getToken()).toBeNull();
  });

  it('{ strict: true } rejects with a SignOutError after the local sign-out', async () => {
    const { client } = await boot((url) => {
      if (url.endsWith('/v1/client')) return signedIn('sess_1');
      if (url.endsWith('/revoke')) throw new TypeError('offline');
    });
    expect(get(client.status)).toBe('signed_in');

    const error = await client.signOut({ strict: true, frontchannel: false }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SignOutError);
    expect((error as { code?: string }).code).toBe('SIGN_OUT_REVOKE_FAILED');
    expect((error as { sessionId?: string }).sessionId).toBe('sess_1');
    expect(get(client.status)).toBe('signed_out');
  });

  it('adopts a parked session the server promoted', async () => {
    let active = 'sess_1';
    const { client } = await boot((url) => {
      if (url.endsWith('/v1/client')) return signedIn(active);
      if (url.endsWith('/sessions/sess_1/revoke')) {
        active = 'sess_2';
        return json({ status: 'revoked', active_session_id: 'sess_2' });
      }
    });
    expect(get(client.session)?.id).toBe('sess_1');

    const result = await client.signOut({ frontchannel: false });
    expect(result).toEqual({ revoked: true, activeSessionId: 'sess_2' });
    expect(get(client.status)).toBe('signed_in');
    expect(get(client.session)?.id).toBe('sess_2');
  });

  it('revokes the cookie session even when no token is cached', async () => {
    // Boot returns a session but no JWT, so nothing lands in the token cache.
    const { client, calls } = await boot((url) => {
      if (url.endsWith('/v1/client')) {
        return json({
          session: { id: 'sess_7', status: 'active', last_active_organization_id: null },
          user: { id: 'user_1' },
        });
      }
      if (url.endsWith('/sessions/sess_7/revoke')) return json({ status: 'revoked' });
    });
    expect(get(client.status)).toBe('signed_in');

    await client.signOut({ frontchannel: false });
    expect(revokes(calls)).toEqual([`POST ${FAPI}/v1/client/sessions/sess_7/revoke`]);
  });

  it('looks the session up from the cookies when the client has no state yet', async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      if (url.endsWith('/v1/client')) return signedIn('sess_9');
      if (url.endsWith('/sessions/sess_9/revoke')) return json({ status: 'revoked' });
      return json({});
    }) as unknown as typeof fetch;
    // Never booted: no token, no session in the stores.
    const client = createAtlasClient({ publishableKey: 'pk_test_x', frontendApi: FAPI, fetchImpl, manualBoot: true });
    clients.push(client);

    const result = await client.signOut({ frontchannel: false });
    expect(result).toEqual({ revoked: true });
    expect(calls).toEqual([`GET ${FAPI}/v1/client`, `POST ${FAPI}/v1/client/sessions/sess_9/revoke`]);
    expect(get(client.status)).toBe('signed_out');
  });
});
