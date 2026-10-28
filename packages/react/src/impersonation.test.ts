// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AtlasProvider } from './AtlasProvider';
import { ImpersonationBanner } from './impersonation';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * `<ImpersonationBanner/>` appears only on an impersonation session and offers
 * "Return to admin" when the impersonator's own session is kept on this
 * browser; ending it re-boots into that session.
 */

const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const jwt = (claims: Record<string, unknown>) =>
  `${b64({ alg: 'none' })}.${b64({ exp: Math.floor(Date.now() / 1000) + 3600, ...claims })}.sig`;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

let unmount: (() => void) | null = null;
afterEach(() => {
  unmount?.();
  unmount = null;
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
  try {
    localStorage.clear();
  } catch {
    /* no storage */
  }
});

async function mount(opts: { impersonating: boolean; actorSessionId: string | null }) {
  const calls: { url: string; method: string }[] = [];
  let state: 'impersonating' | 'admin' | 'signed_out' = opts.impersonating ? 'impersonating' : 'admin';
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const method = init.method ?? 'GET';
    calls.push({ url, method });
    if (url.endsWith('/v1/client')) {
      if (state === 'signed_out') return json({ session: null, user: null });
      if (state === 'impersonating') {
        return json({
          session: { id: 'sess_imp', status: 'active', actor: { sub: 'user_admin' }, actor_session_id: opts.actorSessionId },
          user: { id: 'user_target', first_name: 'Tess', last_name: 'Target' },
          jwt: jwt({ sid: 'sess_imp', sub: 'user_target', act: { sub: 'user_admin' } }),
        });
      }
      return json({
        session: { id: 'sess_admin', status: 'active' },
        user: { id: 'user_admin', first_name: 'Ada', last_name: null },
        jwt: jwt({ sid: 'sess_admin', sub: 'user_admin' }),
      });
    }
    if (method === 'POST' && url.endsWith('/v1/client/sessions/sess_imp/end_impersonation')) {
      if (opts.actorSessionId) {
        state = 'admin';
        return json({ object: 'session', id: 'sess_imp', status: 'revoked', resumed: true, active_session_id: 'sess_admin', jwt: jwt({ sid: 'sess_admin', sub: 'user_admin' }) });
      }
      state = 'signed_out';
      return json({ object: 'session', id: 'sess_imp', status: 'revoked', resumed: false });
    }
    return json({ ok: true });
  }) as unknown as typeof fetch;
  vi.stubGlobal('fetch', fetchImpl);

  const onEnded = vi.fn();
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
        children: createElement(ImpersonationBanner, { onEnded }),
      }),
    );
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
  unmount = () => act(() => root.unmount());
  return { el, calls, onEnded };
}

async function click(target: HTMLElement) {
  await act(async () => {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

describe('<ImpersonationBanner/>', () => {
  it('renders nothing on an ordinary session', async () => {
    const { el } = await mount({ impersonating: false, actorSessionId: null });
    expect(el.querySelector('.atlas-impersonation-banner')).toBeNull();
  });

  it('names the user and returns to the admin session', async () => {
    const { el, calls, onEnded } = await mount({ impersonating: true, actorSessionId: 'sess_admin' });
    const banner = el.querySelector('.atlas-impersonation-banner');
    expect(banner?.textContent).toContain('Tess Target');
    const button = banner!.querySelector('button')!;
    expect(button.textContent).toBe('Return to admin');

    await click(button);
    expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/sessions/sess_imp/end_impersonation'))).toBe(true);
    expect(onEnded).toHaveBeenCalledWith(expect.objectContaining({ ended: true, resumed: true, activeSessionId: 'sess_admin' }));
    // Re-booted as the admin: the banner is gone.
    expect(el.querySelector('.atlas-impersonation-banner')).toBeNull();
  });

  it('offers "End impersonation" when there is no admin session to return to', async () => {
    const { el, onEnded } = await mount({ impersonating: true, actorSessionId: null });
    const button = el.querySelector('.atlas-impersonation-banner button') as HTMLButtonElement;
    expect(button.textContent).toBe('End impersonation');
    await click(button);
    expect(onEnded).toHaveBeenCalledWith(expect.objectContaining({ ended: true, resumed: false }));
    expect(el.querySelector('.atlas-impersonation-banner')).toBeNull();
  });
});
