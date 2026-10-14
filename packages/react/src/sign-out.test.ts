// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AtlasProvider, useAtlas } from './AtlasProvider';

type AtlasContextValue = ReturnType<typeof useAtlas>;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * signOut() runs OIDC Front-Channel Logout for the URLs the revoke response
 * lists, before the provider drops its local state — and skips it on request.
 */
const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const JWT = `${b64({ alg: 'none' })}.${b64({ sid: 'sess_1', sub: 'user_1', exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;
const FC_URL = 'https://rp.example/fc?iss=https%3A%2F%2Fid.example&sid=sess_1';

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

let host: HTMLDivElement;
let unmount: (() => void) | null = null;

beforeEach(() => {
  host = document.createElement('div');
  const original = document.body.appendChild.bind(document.body);
  // Hidden logout frames go to a detached container, so they never navigate.
  vi.spyOn(document.body, 'appendChild').mockImplementation(<T extends Node>(node: T) =>
    node instanceof HTMLIFrameElement ? host.appendChild(node) : original(node),
  );
});
afterEach(() => {
  unmount?.();
  unmount = null;
  vi.restoreAllMocks();
});

async function mountSignedIn() {
  const calls: string[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith('/v1/client')) {
      return json({
        session: { id: 'sess_1', status: 'active', last_active_organization_id: null },
        user: { id: 'user_1' },
        jwt: JWT,
      });
    }
    if (url.endsWith('/v1/client/sessions/sess_1/revoke')) {
      return json({ object: 'session', id: 'sess_1', status: 'revoked', frontchannel_logout_urls: [FC_URL] });
    }
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
  await vi.waitFor(() => expect(ctx?.status).toBe('signed_in'));
  unmount = () => act(() => root.unmount());
  return { ctx: () => ctx!, calls };
}

describe('signOut front-channel logout', () => {
  it('loads the listed front-channel URLs in hidden frames, then signs out', async () => {
    const { ctx, calls } = await mountSignedIn();
    let done = false;
    let p!: Promise<void>;
    await act(async () => {
      p = ctx().signOut().then(() => {
        done = true;
      });
      await vi.waitFor(() => expect(host.querySelectorAll('iframe')).toHaveLength(1));
    });
    expect(calls.some((u) => u.endsWith('/v1/client/sessions/sess_1/revoke'))).toBe(true);
    const frame = host.querySelector('iframe')!;
    expect(frame.src).toBe(FC_URL);
    // Local state is dropped only after the frames finish.
    expect(done).toBe(false);
    expect(ctx().status).toBe('signed_in');

    await act(async () => {
      frame.dispatchEvent(new Event('load'));
      await p;
    });
    expect(host.querySelectorAll('iframe')).toHaveLength(0);
    expect(ctx().status).toBe('signed_out');
  });

  it('skips front-channel logout with { frontchannel: false }', async () => {
    const { ctx } = await mountSignedIn();
    await act(async () => {
      await ctx().signOut({ frontchannel: false });
    });
    expect(host.querySelectorAll('iframe')).toHaveLength(0);
    expect(ctx().status).toBe('signed_out');
  });
});
