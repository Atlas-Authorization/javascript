// @vitest-environment happy-dom
import { Component, act, createElement, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AtlasProvider, useAtlas } from './AtlasProvider';

type AtlasContextValue = ReturnType<typeof useAtlas>;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * A sign-out the server never confirmed must not be undone by the next re-check:
 * the refresh cookie is still valid, and focus / a sibling-tab broadcast / a
 * failed token refresh all re-boot from it. The provider remembers the session
 * it signed out of and refuses to re-adopt it.
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

let unmount: (() => void) | null = null;
beforeEach(() => sessionStorage.clear());
afterEach(() => {
  unmount?.();
  unmount = null;
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
        children: createElement(Probe),
      }),
    );
  });
  unmount = () => act(() => root.unmount());
  return { ctx: () => ctx!, calls };
}

const revokes = (calls: string[]) => calls.filter((c) => c.includes('/revoke'));

describe('signOut() resilience', () => {
  it('resolves { revoked: true } when the server confirms', async () => {
    const { ctx } = await mount((url) => {
      if (url.endsWith('/v1/client')) return signedIn('sess_1');
      if (url.endsWith('/sessions/sess_1/revoke')) return json({ status: 'revoked' });
    });
    await vi.waitFor(() => expect(ctx().status).toBe('signed_in'));
    let result: unknown;
    await act(async () => {
      result = await ctx().signOut({ frontchannel: false });
    });
    expect(result).toEqual({ revoked: true });
    expect(ctx().status).toBe('signed_out');
  });

  it('retries once, then signs out locally and never re-adopts the session on focus', async () => {
    let cookieStillValid = true;
    const { ctx, calls } = await mount((url) => {
      if (url.endsWith('/v1/client')) return cookieStillValid ? signedIn('sess_1') : json({ session: null, user: null });
      if (url.endsWith('/sessions/sess_1/revoke')) return json({}, 503);
    });
    await vi.waitFor(() => expect(ctx().status).toBe('signed_in'));

    let result: unknown;
    await act(async () => {
      result = await ctx().signOut({ frontchannel: false });
    });
    expect(result).toEqual({ revoked: false });
    expect(revokes(calls)).toHaveLength(2);
    expect(ctx().status).toBe('signed_out');

    // The tab regains focus: the re-check sees the still-valid cookie session…
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    await vi.waitFor(() => expect(calls.filter((c) => c === 'GET https://fapi.example/v1/client').length).toBeGreaterThan(1));
    // …but stays signed out, and retries the revoke in the background.
    expect(ctx().status).toBe('signed_out');
    expect(ctx().user).toBeNull();
    await vi.waitFor(() => expect(revokes(calls).length).toBeGreaterThan(2));
    cookieStillValid = false;
  });

  it('{ strict: true } rejects with a SignOutError after the local sign-out', async () => {
    const { ctx } = await mount((url) => {
      if (url.endsWith('/v1/client')) return signedIn('sess_1');
      if (url.endsWith('/revoke')) throw new TypeError('offline');
    });
    await vi.waitFor(() => expect(ctx().status).toBe('signed_in'));
    let error: unknown;
    await act(async () => {
      await ctx()
        .signOut({ strict: true, frontchannel: false })
        .catch((e: unknown) => {
          error = e;
        });
    });
    expect((error as { code?: string }).code).toBe('SIGN_OUT_REVOKE_FAILED');
    expect((error as { sessionId?: string }).sessionId).toBe('sess_1');
    expect(ctx().status).toBe('signed_out');
  });

  it('adopts a parked session the server promoted', async () => {
    let active = 'sess_1';
    const { ctx } = await mount((url) => {
      if (url.endsWith('/v1/client')) return signedIn(active);
      if (url.endsWith('/sessions/sess_1/revoke')) {
        active = 'sess_2';
        return json({ status: 'revoked', active_session_id: 'sess_2' });
      }
    });
    await vi.waitFor(() => expect(ctx().session?.id).toBe('sess_1'));
    let result: unknown;
    await act(async () => {
      result = await ctx().signOut({ frontchannel: false });
    });
    expect(result).toEqual({ revoked: true, activeSessionId: 'sess_2' });
    expect(ctx().status).toBe('signed_in');
    expect(ctx().session?.id).toBe('sess_2');
  });

  it('revokes the cookie session even when no token is cached', async () => {
    // Boot returns a session but no JWT, so nothing lands in the token cache.
    const { ctx, calls } = await mount((url) => {
      if (url.endsWith('/v1/client')) {
        return json({
          session: { id: 'sess_7', status: 'active', last_active_organization_id: null },
          user: { id: 'user_1' },
        });
      }
      if (url.endsWith('/sessions/sess_7/revoke')) return json({ status: 'revoked' });
    });
    await vi.waitFor(() => expect(ctx().status).toBe('signed_in'));
    await act(async () => {
      await ctx().signOut({ frontchannel: false });
    });
    expect(revokes(calls)).toEqual(['POST https://fapi.example/v1/client/sessions/sess_7/revoke']);
  });
});

describe('<AtlasProvider frontendApi>', () => {
  it('still accepts the deprecated "" as same-origin (relative requests)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return json({ session: null, user: null });
    }) as unknown as typeof fetch;
    let ctx: AtlasContextValue | null = null;
    const Probe = () => {
      ctx = useAtlas();
      return null;
    };
    const root = createRoot(document.createElement('div'));
    await act(async () => {
      root.render(
        createElement(AtlasProvider, {
          publishableKey: 'pk_test_x',
          frontendApi: '',
          fetchImpl,
          appearance: { instanceDesign: false },
          children: createElement(Probe),
        }),
      );
    });
    unmount = () => act(() => root.unmount());
    await vi.waitFor(() => expect(ctx?.status).toBe('signed_out'));
    expect(ctx!.frontendApi).toBe('');
    expect(urls).toContain('/v1/client');
  });

  it('throws an AtlasConfigError at render when frontendApi is missing', () => {
    const el = document.createElement('div');
    const root = createRoot(el);
    const errors: unknown[] = [];
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    class Boundary extends Component<{ children?: ReactNode }, { failed: boolean }> {
      override state = { failed: false };
      static getDerivedStateFromError() {
        return { failed: true };
      }
      override componentDidCatch(error: unknown) {
        errors.push(error);
      }
      override render() {
        return this.state.failed ? null : this.props.children;
      }
    }
    act(() => {
      root.render(
        createElement(
          Boundary,
          null,
          createElement(AtlasProvider, {
            publishableKey: 'pk_test_x',
            frontendApi: undefined as unknown as string,
            children: null,
          }),
        ),
      );
    });
    act(() => root.unmount());
    expect(errors).toHaveLength(1);
    expect((errors[0] as { name?: string }).name).toBe('AtlasConfigError');
    expect((errors[0] as { code?: string }).code).toBe('FRONTEND_API_REQUIRED');
  });
});
