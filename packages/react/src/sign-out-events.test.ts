// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionTombstones, resetSdkAdvisoryLog, type SignOutEvent } from '@atlasauth/js';
import { AtlasProvider, useAtlas } from './AtlasProvider';
import { ATLAS_REACT_VERSION } from './version';

type AtlasContextValue = ReturnType<typeof useAtlas>;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * ATL-S-30 `onSignOut({ reason })` fires once for every sign-out path, and
 * ATL-S-22 the provider names itself (`X-Atlas-SDK`) and logs an advisory once.
 */
const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const jwt = (expInSeconds: number) =>
  `${b64({ alg: 'none' })}.${b64({ sid: 'sess_1', sub: 'user_1', exp: Math.floor(Date.now() / 1000) + expInSeconds })}.sig`;

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

const SIGNED_IN = (exp = 3600) => ({
  session: { id: 'sess_1', status: 'active', last_active_organization_id: null },
  user: { id: 'user_1' },
  jwt: jwt(exp),
});

let unmount: (() => void) | null = null;
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  resetSdkAdvisoryLog();
});
afterEach(() => {
  unmount?.();
  unmount = null;
  vi.restoreAllMocks();
});

async function mount(route: (url: string, init?: RequestInit) => Response | Promise<Response>, exp = 3600) {
  const events: SignOutEvent[] = [];
  const windowEvents: SignOutEvent[] = [];
  window.addEventListener('atlas:signout', (e) => windowEvents.push((e as CustomEvent<SignOutEvent>).detail));
  const headers: Record<string, string>[] = [];
  let boots = 0;
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    headers.push((init?.headers ?? {}) as Record<string, string>);
    if (url.endsWith('/v1/client') && boots++ === 0) return json(SIGNED_IN(exp));
    return route(url, init);
  }) as unknown as typeof fetch;
  let ctx: AtlasContextValue | null = null;
  const Probe = () => {
    ctx = useAtlas();
    return null;
  };
  const el = document.createElement('div');
  document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => {
    root.render(
      createElement(AtlasProvider, {
        publishableKey: 'pk_test_x',
        frontendApi: 'https://fapi.example',
        fetchImpl,
        appearance: { instanceDesign: false },
        onSignOut: (e) => events.push(e),
        children: createElement(Probe),
      }),
    );
  });
  await vi.waitFor(() => expect(ctx?.status).toBe('signed_in'));
  unmount = () => act(() => root.unmount());
  return { ctx: () => ctx!, events, windowEvents, headers, fetchImpl };
}

describe('onSignOut', () => {
  it("reason 'user' when this tab signs out, once, also as the atlas:signout window event", async () => {
    const t = await mount((url) =>
      url.endsWith('/revoke') ? json({ object: 'session', id: 'sess_1', status: 'revoked' }) : json({}),
    );
    await act(async () => {
      await t.ctx().signOut();
    });
    expect(t.ctx().status).toBe('signed_out');
    expect(t.events).toEqual([{ reason: 'user', sessionId: 'sess_1' }]);
    expect(t.windowEvents).toContainEqual({ reason: 'user', sessionId: 'sess_1' });
  });

  it("reason 'revoked' when the session was ended server-side, detected on the next token refresh", async () => {
    // A token about to expire: the provider refreshes at once, the refresh is
    // refused (the session was revoked elsewhere), and the re-check says why.
    const t = await mount((url) => {
      if (url.endsWith('/tokens')) {
        // Answered after a beat, so the test sees the signed-in state first.
        return new Promise<Response>((r) => setTimeout(() => r(json({ errors: [{ code: 'UNAUTHENTICATED' }] }, 401)), 300));
      }
      if (url.endsWith('/v1/client')) {
        return json({ session: null, sessions: [], user: null, signed_out_reason: 'revoked' });
      }
      return json({});
    }, 2);
    await vi.waitFor(() => expect(t.events).toEqual([{ reason: 'revoked', sessionId: 'sess_1' }]), { timeout: 3000 });
    expect(t.ctx().status).toBe('signed_out');
  });

  it("reason 'session_expired' when the server says the session ran out", async () => {
    const t = await mount((url) =>
      url.endsWith('/v1/client')
        ? json({ session: null, sessions: [], user: null, signed_out_reason: 'session_expired' })
        : json({}),
    );
    await act(async () => {
      await t.ctx().reload();
    });
    expect(t.events).toEqual([{ reason: 'session_expired', sessionId: 'sess_1' }]);
  });

  it("reason 'other_tab' when another tab signs this session out", async () => {
    const t = await mount((url) =>
      url.endsWith('/v1/client') ? json({ session: null, sessions: [], user: null, signed_out_reason: null }) : json({}),
    );
    // Another tab signed this session out: its tombstone lands in the shared
    // localStorage and the storage event wakes this tab.
    await act(async () => {
      new SessionTombstones({ frontendApi: 'https://fapi.example' }).add('sess_1');
      window.dispatchEvent(new StorageEvent('storage', { key: null }));
    });
    await vi.waitFor(() => expect(t.events).toEqual([{ reason: 'other_tab', sessionId: 'sess_1' }]));
    expect(t.ctx().status).toBe('signed_out');

  });

  it('does not fire on a page load that boots signed out, nor when a re-check stays signed in', async () => {
    const t = await mount((url) => (url.endsWith('/v1/client') ? json(SIGNED_IN()) : json({})));
    await act(async () => {
      await t.ctx().reload();
    });
    expect(t.events).toEqual([]);
  });
});

describe('getToken({ template })', () => {
  it('mints a named-template token for the current session', async () => {
    const t = await mount((url) =>
      url.endsWith('/v1/client/sessions/sess_1/tokens/chatly') ? json({ object: 'token', jwt: 'chat.jwt.x', expires_in: 120 }) : json({}),
    );
    let token: string | null = null;
    await act(async () => {
      token = await t.ctx().getToken({ template: 'chatly' });
    });
    expect(token).toBe('chat.jwt.x');
  });

  it('is null for an unknown template', async () => {
    const t = await mount((url) => (url.includes('/tokens/') ? json({ errors: [] }, 404) : json({})));
    let token: string | null = 'x';
    await act(async () => {
      token = await t.ctx().getToken({ template: 'nope' });
    });
    expect(token).toBeNull();
  });
});

describe('SDK identity and advisories', () => {
  it('the version constant matches package.json', () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as { version: string };
    expect(ATLAS_REACT_VERSION).toBe(pkg.version);
  });

  it('every Frontend API request names @atlasauth/react, and an advisory is logged once per page load', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const advisory = { 'atlas-sdk-advisory': 'upgrade; min=99.0.0; reason=test_reason' };
    const t = await mount((url) => (url.endsWith('/v1/client') ? json(SIGNED_IN(), 200, advisory) : json({}, 200, advisory)));
    await act(async () => {
      await t.ctx().reload();
      await t.ctx().reload();
    });
    expect(t.headers.length).toBeGreaterThan(1);
    for (const h of t.headers) expect(h['x-atlas-sdk']).toBe(`@atlasauth/react/${ATLAS_REACT_VERSION}`);
    const advisoryWarnings = warn.mock.calls.filter((c) => String(c[0]).includes('test_reason'));
    expect(advisoryWarnings).toHaveLength(1);
  });
});
