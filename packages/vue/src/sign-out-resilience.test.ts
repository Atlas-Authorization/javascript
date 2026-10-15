import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h } from 'vue';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { SessionTombstones } from '@atlasauth/js';
import { createAtlas, type AtlasClient } from './plugin';
import { useAtlas } from './context';

/**
 * A sign-out the server never confirmed must not be undone by the next re-check:
 * the refresh cookie is still valid, and a reload / a failed token refresh / a
 * tab opened later all re-boot from it. The client remembers the session it
 * signed out of (a tombstone in localStorage) and refuses to re-adopt it.
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

let wrapper: VueWrapper | null = null;
beforeEach(() => {
  // Tombstones are shared by every tab (localStorage), so start each test clean.
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
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

  let client: AtlasClient | null = null;
  const Probe = defineComponent({
    setup() {
      client = useAtlas();
      return () => h('div');
    },
  });
  wrapper = mount(Probe, {
    global: {
      plugins: [
        createAtlas({
          publishableKey: 'pk_test_x',
          frontendApi: 'https://fapi.example',
          fetchImpl,
          appearance: { instanceDesign: false },
        }),
      ],
    },
  });
  await flushPromises();
  return { atlas: () => client!, calls };
}

const revokes = (calls: string[]) => calls.filter((c) => c.includes('/revoke'));
const tombstoned = (sid: string) => new SessionTombstones({ frontendApi: 'https://fapi.example' }).has(sid);

describe('signOut() resilience', () => {
  it('resolves { revoked: true } when the server confirms', async () => {
    const { atlas } = await boot((url) => {
      if (url.endsWith('/v1/client')) return signedIn('sess_1');
      if (url.endsWith('/sessions/sess_1/revoke')) return json({ status: 'revoked' });
    });
    await vi.waitFor(() => expect(atlas().status.value).toBe('signed_in'));
    const result = await atlas().signOut({ frontchannel: false });
    expect(result).toEqual({ revoked: true });
    expect(atlas().status.value).toBe('signed_out');
  });

  it('retries once, then signs out locally and never re-adopts the session on reload or refresh', async () => {
    const { atlas, calls } = await boot((url) => {
      if (url.endsWith('/v1/client')) return signedIn('sess_1');
      if (url.endsWith('/sessions/sess_1/revoke')) return json({}, 503);
    });
    await vi.waitFor(() => expect(atlas().status.value).toBe('signed_in'));

    const result = await atlas().signOut({ frontchannel: false });
    expect(result).toEqual({ revoked: false });
    expect(revokes(calls)).toHaveLength(2);
    expect(atlas().status.value).toBe('signed_out');
    expect(tombstoned('sess_1')).toBe(true);

    // A re-check sees the still-valid cookie session… and stays signed out.
    const boots = calls.filter((c) => c === 'GET https://fapi.example/v1/client').length;
    await atlas().reload();
    expect(calls.filter((c) => c === 'GET https://fapi.example/v1/client').length).toBe(boots + 1);
    expect(atlas().status.value).toBe('signed_out');
    expect(atlas().user.value).toBeNull();
    expect(atlas().session.value).toBeNull();
    // A token read (which refreshes) hands back nothing.
    expect(await atlas().getToken()).toBeNull();
    expect(atlas().status.value).toBe('signed_out');
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
    await vi.waitFor(() => expect(tab1.atlas().status.value).toBe('signed_in'));
    await tab1.atlas().signOut({ frontchannel: false });
    expect(tab1.atlas().status.value).toBe('signed_out');
    wrapper?.unmount();
    wrapper = null;

    // (1) A brand-new tab (fresh client, fresh sessionStorage) boots from the
    // still-valid cookie session — and refuses it.
    sessionStorage.clear();
    const tab2 = await boot(route);
    expect(tab2.calls).toContain('GET https://fapi.example/v1/client');
    await vi.waitFor(() => expect(tab2.atlas().status.value).toBe('signed_out'));
    expect(tab2.atlas().user.value).toBeNull();
    // It retried the revoke in the background (still failing).
    await vi.waitFor(() => expect(revokes(tab2.calls).length).toBeGreaterThan(0));
    expect(tombstoned('sess_1')).toBe(true);

    // (2) The server is reachable again: the next re-check's background revoke
    // lands and the tombstone is cleared.
    revokeWorks = true;
    await tab2.atlas().reload();
    await vi.waitFor(() => expect(cookieSession).toBeNull());
    await vi.waitFor(() => expect(tombstoned('sess_1')).toBe(false));
    expect(tab2.atlas().status.value).toBe('signed_out');

    // (3) Signing in again gives a new session id, which is adopted normally.
    cookieSession = 'sess_2';
    await tab2.atlas().reload();
    expect(tab2.atlas().status.value).toBe('signed_in');
    expect(tab2.atlas().session.value?.id).toBe('sess_2');
  });

  it('{ strict: true } rejects with a SignOutError after the local sign-out', async () => {
    const { atlas } = await boot((url) => {
      if (url.endsWith('/v1/client')) return signedIn('sess_1');
      if (url.endsWith('/revoke')) throw new TypeError('offline');
    });
    await vi.waitFor(() => expect(atlas().status.value).toBe('signed_in'));
    let error: unknown;
    await atlas()
      .signOut({ strict: true, frontchannel: false })
      .catch((e: unknown) => {
        error = e;
      });
    expect((error as { name?: string }).name).toBe('SignOutError');
    expect((error as { code?: string }).code).toBe('SIGN_OUT_REVOKE_FAILED');
    expect((error as { sessionId?: string }).sessionId).toBe('sess_1');
    expect(atlas().status.value).toBe('signed_out');
  });

  it('adopts a parked session the server promoted', async () => {
    let active = 'sess_1';
    const { atlas } = await boot((url) => {
      if (url.endsWith('/v1/client')) return signedIn(active);
      if (url.endsWith('/sessions/sess_1/revoke')) {
        active = 'sess_2';
        return json({ status: 'revoked', active_session_id: 'sess_2' });
      }
    });
    await vi.waitFor(() => expect(atlas().session.value?.id).toBe('sess_1'));
    const result = await atlas().signOut({ frontchannel: false });
    expect(result).toEqual({ revoked: true, activeSessionId: 'sess_2' });
    expect(atlas().status.value).toBe('signed_in');
    expect(atlas().session.value?.id).toBe('sess_2');
  });

  it('revokes the cookie session even when no token is cached', async () => {
    // Boot returns a session but no JWT, so nothing lands in the token cache.
    const { atlas, calls } = await boot((url) => {
      if (url.endsWith('/v1/client')) {
        return json({
          session: { id: 'sess_7', status: 'active', last_active_organization_id: null },
          user: { id: 'user_1' },
        });
      }
      if (url.endsWith('/sessions/sess_7/revoke')) return json({ status: 'revoked' });
    });
    await vi.waitFor(() => expect(atlas().status.value).toBe('signed_in'));
    await atlas().signOut({ frontchannel: false });
    expect(revokes(calls)).toEqual(['POST https://fapi.example/v1/client/sessions/sess_7/revoke']);
  });

  it('revokes the cookie session when called before anything was booted (GET /v1/client finds it)', async () => {
    let booted = false;
    const { atlas, calls } = await boot((url) => {
      if (url.endsWith('/v1/client')) {
        // The first boot fails (network), so the client holds no session at all.
        if (!booted) {
          booted = true;
          throw new TypeError('offline');
        }
        return signedIn('sess_8');
      }
      if (url.endsWith('/sessions/sess_8/revoke')) return json({ status: 'revoked' });
    });
    expect(atlas().session.value).toBeNull();
    const result = await atlas().signOut({ frontchannel: false });
    expect(result).toEqual({ revoked: true });
    expect(revokes(calls)).toEqual(['POST https://fapi.example/v1/client/sessions/sess_8/revoke']);
  });

  it('a sibling tab signing out of this session signs this tab out too', async () => {
    const { atlas } = await boot((url) => {
      if (url.endsWith('/v1/client')) return signedIn('sess_1');
    });
    await vi.waitFor(() => expect(atlas().status.value).toBe('signed_in'));
    // Another tab tombstoned sess_1 (it reaches this tab as a `storage` event).
    new SessionTombstones({ frontendApi: 'https://fapi.example' }).add('sess_1');
    window.dispatchEvent(new StorageEvent('storage', { key: null }));
    await vi.waitFor(() => expect(atlas().status.value).toBe('signed_out'));
    expect(await atlas().getToken()).toBeNull();
  });
});
