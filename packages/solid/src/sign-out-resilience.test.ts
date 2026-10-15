import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionTombstones } from '@atlasauth/js';
import { createAtlasClient } from './provider';

/**
 * A sign-out the server never confirmed must not be undone by the next re-check:
 * the refresh cookie is still valid, and a reload / a failed token refresh / a
 * tab opened later all re-boot from it. The client remembers the session it
 * signed out of (through `SignOutGuard`) and refuses to re-adopt it — the Solid
 * peer of `@atlasauth/react`'s sign-out-resilience suite, driven through the real
 * client with a mocked `fetch` as the only seam.
 */
const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const jwtFor = (sid: string) =>
  `${b64({ alg: 'none' })}.${b64({ sid, sub: 'user_1', exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const signedIn = (sid: string) =>
  json({
    session: { id: sid, status: 'active', last_active_organization_id: null },
    user: { id: 'user_1' },
    jwt: jwtFor(sid),
  });

type Route = (url: string, init?: RequestInit) => Response | Promise<Response> | undefined;

const disposers: (() => void)[] = [];
beforeEach(() => {
  // Tombstones are shared by every tab (localStorage), so start each test clean.
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(() => {
  for (const d of disposers.splice(0)) d();
  vi.restoreAllMocks();
});

async function mount(route: Route) {
  const calls: string[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    const answer = await route(url, init);
    if (answer) return answer;
    return json({});
  }) as unknown as typeof fetch;
  const { client, boot, dispose } = createAtlasClient({
    publishableKey: 'pk_test_x',
    frontendApi: 'https://fapi.example',
    fetchImpl,
  });
  disposers.push(dispose);
  await boot();
  return { client, calls, dispose };
}

const revokes = (calls: string[]) => calls.filter((c) => c.includes('/revoke'));
const boots = (calls: string[]) => calls.filter((c) => c === 'GET https://fapi.example/v1/client');
const tombstoned = (sid: string) => new SessionTombstones({ frontendApi: 'https://fapi.example' }).has(sid);

describe('signOut() resilience', () => {
  it('resolves { revoked: true } when the server confirms', async () => {
    const { client } = await mount((url) => {
      if (url.endsWith('/v1/client')) return signedIn('sess_1');
      if (url.endsWith('/sessions/sess_1/revoke')) return json({ status: 'revoked' });
    });
    expect(client.state.status).toBe('signed_in');
    const result = await client.signOut({ frontchannel: false });
    expect(result).toEqual({ revoked: true });
    expect(client.state.status).toBe('signed_out');
  });

  it('retries once, then signs out locally and never re-adopts the session on reload or refresh', async () => {
    const { client, calls } = await mount((url) => {
      if (url.endsWith('/v1/client')) return signedIn('sess_1');
      if (url.endsWith('/sessions/sess_1/revoke')) return json({}, 503);
      if (url.endsWith('/sessions/sess_1/tokens')) return json({ jwt: jwtFor('sess_1'), session_id: 'sess_1' });
    });
    expect(client.state.status).toBe('signed_in');

    const result = await client.signOut({ frontchannel: false });
    expect(result).toEqual({ revoked: false });
    expect(revokes(calls)).toHaveLength(2);
    expect(client.state.status).toBe('signed_out');
    expect(tombstoned('sess_1')).toBe(true);

    // A re-check sees the still-valid cookie session… and stays signed out.
    await client.reload();
    expect(boots(calls).length).toBeGreaterThan(1);
    expect(client.state.status).toBe('signed_out');
    expect(client.state.user).toBeNull();
    // No token comes back either: getToken() finds nothing to refresh.
    expect(await client.getToken()).toBeNull();
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
    const tab1 = await mount(route);
    expect(tab1.client.state.status).toBe('signed_in');
    await tab1.client.signOut({ frontchannel: false });
    expect(tab1.client.state.status).toBe('signed_out');
    tab1.dispose();

    // (1) A brand-new tab (fresh client, fresh sessionStorage) boots from the
    // still-valid cookie session — and refuses it.
    sessionStorage.clear();
    const tab2 = await mount(route);
    expect(tab2.calls).toContain('GET https://fapi.example/v1/client');
    expect(tab2.client.state.status).toBe('signed_out');
    expect(tab2.client.state.user).toBeNull();
    // It retried the revoke in the background (still failing).
    await vi.waitFor(() => expect(revokes(tab2.calls).length).toBeGreaterThan(0));
    expect(tombstoned('sess_1')).toBe(true);

    // (2) The server is reachable again: the next re-check's background revoke
    // lands and the tombstone is cleared.
    await new Promise((r) => setTimeout(r, 0));
    revokeWorks = true;
    await tab2.client.reload();
    await vi.waitFor(() => expect(cookieSession).toBeNull());
    await vi.waitFor(() => expect(tombstoned('sess_1')).toBe(false));
    expect(tab2.client.state.status).toBe('signed_out');

    // (3) Signing in again gives a new session id, which is adopted normally.
    cookieSession = 'sess_2';
    await tab2.client.reload();
    expect(tab2.client.state.status).toBe('signed_in');
    expect(tab2.client.state.session?.id).toBe('sess_2');
  });

  it('{ strict: true } rejects with a SignOutError after the local sign-out', async () => {
    const { client } = await mount((url) => {
      if (url.endsWith('/v1/client')) return signedIn('sess_1');
      if (url.endsWith('/revoke')) throw new TypeError('offline');
    });
    expect(client.state.status).toBe('signed_in');
    let error: unknown;
    await client.signOut({ strict: true, frontchannel: false }).catch((e: unknown) => {
      error = e;
    });
    expect((error as { name?: string }).name).toBe('SignOutError');
    expect((error as { code?: string }).code).toBe('SIGN_OUT_REVOKE_FAILED');
    expect((error as { sessionId?: string }).sessionId).toBe('sess_1');
    expect(client.state.status).toBe('signed_out');
  });

  it('adopts a parked session the server promoted', async () => {
    let active = 'sess_1';
    const { client } = await mount((url) => {
      if (url.endsWith('/v1/client')) return signedIn(active);
      if (url.endsWith('/sessions/sess_1/revoke')) {
        active = 'sess_2';
        return json({ status: 'revoked', active_session_id: 'sess_2' });
      }
    });
    expect(client.state.session?.id).toBe('sess_1');
    const result = await client.signOut({ frontchannel: false });
    expect(result).toEqual({ revoked: true, activeSessionId: 'sess_2' });
    expect(client.state.status).toBe('signed_in');
    expect(client.state.session?.id).toBe('sess_2');
  });

  it('revokes the cookie session even when no token is cached', async () => {
    // Boot returns a session but no JWT, so nothing lands in the token cache.
    const { client, calls } = await mount((url) => {
      if (url.endsWith('/v1/client')) {
        return json({
          session: { id: 'sess_7', status: 'active', last_active_organization_id: null },
          user: { id: 'user_1' },
        });
      }
      if (url.endsWith('/sessions/sess_7/revoke')) return json({ status: 'revoked' });
    });
    expect(client.state.status).toBe('signed_in');
    await client.signOut({ frontchannel: false });
    expect(revokes(calls)).toEqual(['POST https://fapi.example/v1/client/sessions/sess_7/revoke']);
  });

  it('a sibling tab signing out of this session signs this tab out too', async () => {
    const { client, calls } = await mount((url) => {
      if (url.endsWith('/v1/client')) return signedIn('sess_1');
      if (url.endsWith('/sessions/sess_1/revoke')) return json({}, 503);
    });
    expect(client.state.status).toBe('signed_in');

    // The other tab's tombstone reaches the shared store; this tab hears the
    // `storage` event, drops its token and re-checks — refusing the session.
    new SessionTombstones({ frontendApi: 'https://fapi.example' }).add('sess_1');
    window.dispatchEvent(new StorageEvent('storage', { key: null }));
    await vi.waitFor(() => expect(boots(calls).length).toBe(2));
    await vi.waitFor(() => expect(client.state.status).toBe('signed_out'));
    expect(client.state.user).toBeNull();
  });
});
