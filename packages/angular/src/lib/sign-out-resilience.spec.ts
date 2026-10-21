// @vitest-environment happy-dom
import '@angular/compiler';
import { Injector, PLATFORM_ID, runInInjectionContext } from '@angular/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionTombstones } from '@atlasauth/js';
import { ATLAS_OPTIONS } from './atlas.config';
import { AtlasService } from './atlas.service';

/**
 * A sign-out the server never confirmed must not be undone by the next re-check:
 * the refresh cookie is still valid, and a reload, a failed token refresh, a
 * sibling tab or a tab opened later all re-boot from it. `AtlasService`
 * remembers the session it signed out of (a tombstone in localStorage, through
 * the shared `SignOutGuard`) and refuses to re-adopt it. Mirrors
 * `@atlasauth/react`'s sign-out-resilience suite; the service is constructed in
 * a bare injection context (no TestBed), with a scripted fetch.
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

const teardown: (() => void)[] = [];
beforeEach(() => {
  // Tombstones are shared by every tab (localStorage), so start each test clean.
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(() => {
  while (teardown.length) teardown.pop()!();
  vi.restoreAllMocks();
});

function mount(route: Route) {
  const calls: string[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    const answer = await route(url, init);
    if (answer) return answer;
    return json({});
  }) as unknown as typeof fetch;

  const injector = Injector.create({
    providers: [
      {
        provide: ATLAS_OPTIONS,
        useValue: { publishableKey: 'pk_test_x', frontendApi: FAPI, fetchImpl, appearance: { instanceDesign: false } },
      },
      { provide: PLATFORM_ID, useValue: 'browser' },
    ],
  });
  const atlas = runInInjectionContext(injector, () => new AtlasService());
  let destroyed = false;
  const destroy = () => {
    if (destroyed) return;
    destroyed = true;
    atlas.ngOnDestroy();
    (injector as unknown as { destroy?: () => void }).destroy?.();
  };
  teardown.push(destroy);
  return { atlas, calls, destroy };
}

const revokes = (calls: string[]) => calls.filter((c) => c.includes('/revoke'));
const boots = (calls: string[]) => calls.filter((c) => c === `GET ${FAPI}/v1/client`);
const tombstoned = (sid: string) => new SessionTombstones({ frontendApi: FAPI }).has(sid);

describe('AtlasService.signOut() resilience', () => {
  it('resolves { revoked: true } when the server confirms', async () => {
    const { atlas } = mount((url) => {
      if (url.endsWith('/v1/client')) return signedIn('sess_1');
      if (url.endsWith('/sessions/sess_1/revoke')) return json({ status: 'revoked' });
    });
    await vi.waitFor(() => expect(atlas.status()).toBe('signed_in'));
    const result = await atlas.signOut({ frontchannel: false });
    expect(result).toEqual({ revoked: true });
    expect(atlas.status()).toBe('signed_out');
    expect(atlas.user()).toBeNull();
    expect(await atlas.getToken()).toBeNull();
  });

  it('retries once, then signs out locally and never re-adopts the session on reload or refresh', async () => {
    const { atlas, calls } = mount((url) => {
      if (url.endsWith('/v1/client')) return signedIn('sess_1');
      if (url.endsWith('/sessions/sess_1/revoke')) return json({}, 503);
    });
    await vi.waitFor(() => expect(atlas.status()).toBe('signed_in'));

    const result = await atlas.signOut({ frontchannel: false });
    expect(result).toEqual({ revoked: false });
    expect(revokes(calls)).toHaveLength(2);
    expect(atlas.status()).toBe('signed_out');
    expect(tombstoned('sess_1')).toBe(true);

    // The re-check sees the still-valid cookie session…
    await atlas.reload();
    expect(boots(calls).length).toBeGreaterThan(1);
    // …but stays signed out (the revoke's background re-try is already
    // scheduled; the next test watches one land).
    expect(atlas.status()).toBe('signed_out');
    expect(atlas.user()).toBeNull();
    expect(atlas.session()).toBeNull();
    expect(tombstoned('sess_1')).toBe(true);
    // A token read (the refresh path) hands back nothing either.
    expect(await atlas.getToken()).toBeNull();
    expect(atlas.status()).toBe('signed_out');
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
    const tab1 = mount(route);
    await vi.waitFor(() => expect(tab1.atlas.status()).toBe('signed_in'));
    await tab1.atlas.signOut({ frontchannel: false });
    expect(tab1.atlas.status()).toBe('signed_out');
    tab1.destroy();

    // (1) A brand-new tab (fresh service, fresh sessionStorage) boots from the
    // still-valid cookie session — and refuses it.
    sessionStorage.clear();
    const tab2 = mount(route);
    await vi.waitFor(() => expect(boots(tab2.calls)).toHaveLength(1));
    await vi.waitFor(() => expect(tab2.atlas.status()).toBe('signed_out'));
    expect(tab2.atlas.user()).toBeNull();
    // It retried the revoke in the background (still failing).
    await vi.waitFor(() => expect(revokes(tab2.calls).length).toBeGreaterThan(0));
    expect(tombstoned('sess_1')).toBe(true);

    // (2) The server is reachable again: the next re-check's background revoke
    // lands and the tombstone is cleared.
    revokeWorks = true;
    await tab2.atlas.reload();
    await vi.waitFor(() => expect(cookieSession).toBeNull());
    await vi.waitFor(() => expect(tombstoned('sess_1')).toBe(false));
    expect(tab2.atlas.status()).toBe('signed_out');

    // (3) Signing in again gives a new session id, which is adopted normally.
    cookieSession = 'sess_2';
    await tab2.atlas.reload();
    expect(tab2.atlas.status()).toBe('signed_in');
    expect(tab2.atlas.session()?.id).toBe('sess_2');
  });

  it('a sibling tab that signs out signs this tab out too', async () => {
    const route: Route = (url) => {
      if (url.endsWith('/v1/client')) return signedIn('sess_1');
      if (url.endsWith('/sessions/sess_1/revoke')) return json({}, 503);
    };
    const tabA = mount(route);
    const tabB = mount(route);
    await vi.waitFor(() => expect(tabA.atlas.status()).toBe('signed_in'));
    await vi.waitFor(() => expect(tabB.atlas.status()).toBe('signed_in'));

    await tabB.atlas.signOut({ frontchannel: false });
    expect(tabB.atlas.status()).toBe('signed_out');
    // The tombstone reaching the shared store is a `storage` event in every
    // other tab (never in the writer, so it is dispatched by hand here).
    window.dispatchEvent(new StorageEvent('storage', { key: null }));
    await vi.waitFor(() => expect(tabA.atlas.status()).toBe('signed_out'));
    expect(tabA.atlas.user()).toBeNull();
    expect(await tabA.atlas.getToken()).toBeNull();
  });

  it('{ strict: true } rejects with a SignOutError after the local sign-out', async () => {
    const { atlas } = mount((url) => {
      if (url.endsWith('/v1/client')) return signedIn('sess_1');
      if (url.endsWith('/revoke')) throw new TypeError('offline');
    });
    await vi.waitFor(() => expect(atlas.status()).toBe('signed_in'));
    let error: unknown;
    await atlas.signOut({ strict: true, frontchannel: false }).catch((e: unknown) => {
      error = e;
    });
    expect((error as { name?: string }).name).toBe('SignOutError');
    expect((error as { code?: string }).code).toBe('SIGN_OUT_REVOKE_FAILED');
    expect((error as { sessionId?: string }).sessionId).toBe('sess_1');
    expect(atlas.status()).toBe('signed_out');
  });

  it('adopts a parked session the server promoted', async () => {
    let active = 'sess_1';
    const { atlas } = mount((url) => {
      if (url.endsWith('/v1/client')) return signedIn(active);
      if (url.endsWith('/sessions/sess_1/revoke')) {
        active = 'sess_2';
        return json({ status: 'revoked', active_session_id: 'sess_2' });
      }
    });
    await vi.waitFor(() => expect(atlas.session()?.id).toBe('sess_1'));
    const result = await atlas.signOut({ frontchannel: false });
    expect(result).toEqual({ revoked: true, activeSessionId: 'sess_2' });
    expect(atlas.status()).toBe('signed_in');
    expect(atlas.session()?.id).toBe('sess_2');
  });

  it('revokes the cookie session even when no token is cached', async () => {
    // Boot returns a session but no JWT, so nothing lands in the token cache.
    const { atlas, calls } = mount((url) => {
      if (url.endsWith('/v1/client')) {
        return json({
          session: { id: 'sess_7', status: 'active', last_active_organization_id: null },
          user: { id: 'user_1' },
        });
      }
      if (url.endsWith('/sessions/sess_7/revoke')) return json({ status: 'revoked' });
    });
    await vi.waitFor(() => expect(atlas.status()).toBe('signed_in'));
    await atlas.signOut({ frontchannel: false });
    expect(revokes(calls)).toEqual([`POST ${FAPI}/v1/client/sessions/sess_7/revoke`]);
  });

  it('finds the session to revoke with GET /v1/client when nothing is known locally', async () => {
    let booted = false;
    const { atlas, calls } = mount((url) => {
      if (url.endsWith('/v1/client')) {
        // The first boot fails (signed out locally); the cookie session is
        // still there when signOut() asks.
        if (!booted) {
          booted = true;
          return json({}, 503);
        }
        return signedIn('sess_9');
      }
      if (url.endsWith('/sessions/sess_9/revoke')) return json({ status: 'revoked' });
    });
    await vi.waitFor(() => expect(atlas.status()).toBe('signed_out'));
    const result = await atlas.signOut({ frontchannel: false });
    expect(result).toEqual({ revoked: true });
    expect(revokes(calls)).toEqual([`POST ${FAPI}/v1/client/sessions/sess_9/revoke`]);
  });
});
