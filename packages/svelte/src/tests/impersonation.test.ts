import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, waitFor } from '@testing-library/svelte';
import { ATLAS_KEY, createAtlasClient } from '../lib/context';
import ImpersonationBanner from '../lib/components/ImpersonationBanner.svelte';

/**
 * `<ImpersonationBanner>` (Svelte), driven through the real client: it shows
 * only on an impersonation session, and "Return to admin" ends it and adopts
 * the impersonator's own session.
 */
vi.mock('@atlasauth/js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@atlasauth/js')>();
  return { ...actual, readRedirectResult: () => null };
});

const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const jwt = (claims: Record<string, unknown>) =>
  `${b64({ alg: 'none' })}.${b64({ exp: Math.floor(Date.now() / 1000) + 3600, ...claims })}.sig`;
const json = (body: unknown): Response =>
  ({ ok: true, status: 200, json: async () => body, clone() { return this; } }) as unknown as Response;

afterEach(() => localStorage.clear());

async function setup(actorSessionId: string | null, impersonating = true) {
  let state: 'imp' | 'admin' | 'out' = impersonating ? 'imp' : 'admin';
  const calls: string[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    calls.push(`${init.method ?? 'GET'} ${url}`);
    if (url.endsWith('/v1/client')) {
      if (state === 'out') return json({ session: null, user: null });
      if (state === 'imp')
        return json({
          session: { id: 'sess_imp', status: 'active', actor: { sub: 'user_admin' }, actor_session_id: actorSessionId },
          user: { id: 'user_t', first_name: 'Tess', last_name: null },
          jwt: jwt({ sid: 'sess_imp', sub: 'user_t', act: { sub: 'user_admin' } }),
        });
      return json({
        session: { id: 'sess_admin', status: 'active' },
        user: { id: 'user_admin', first_name: 'Ada', last_name: null },
        jwt: jwt({ sid: 'sess_admin', sub: 'user_admin' }),
      });
    }
    if (url.endsWith('/sessions/sess_imp/end_impersonation')) {
      if (actorSessionId) {
        state = 'admin';
        return json({ resumed: true, active_session_id: 'sess_admin', jwt: jwt({ sid: 'sess_admin', sub: 'user_admin' }) });
      }
      state = 'out';
      return json({ resumed: false });
    }
    return json({});
  }) as unknown as typeof fetch;
  const client = createAtlasClient({ publishableKey: 'pk_test', frontendApi: 'https://fapi.example', fetchImpl, manualBoot: true });
  await client.reload();
  const view = render(ImpersonationBanner, { context: new Map([[ATLAS_KEY, client]]) });
  const ended = vi.fn();
  view.component.$on('ended', (e: CustomEvent) => ended(e.detail));
  return { ...view, calls, ended };
}

describe('<ImpersonationBanner> (Svelte)', () => {
  it('renders nothing on an ordinary session', async () => {
    const { container } = await setup(null, false);
    expect(container.querySelector('.atlas-impersonation-banner')).toBeNull();
  });

  it('returns to the admin session', async () => {
    const { container, getByRole, calls, ended } = await setup('sess_admin');
    expect(container.querySelector('.atlas-impersonation-banner')?.textContent).toContain('Tess');
    await fireEvent.click(getByRole('button', { name: 'Return to admin' }));
    await waitFor(() => expect(container.querySelector('.atlas-impersonation-banner')).toBeNull());
    expect(calls).toContain('POST https://fapi.example/v1/client/sessions/sess_imp/end_impersonation');
    expect(ended).toHaveBeenCalledWith(expect.objectContaining({ ended: true, resumed: true, activeSessionId: 'sess_admin' }));
  });

  it('"End impersonation" signs out when there is nothing to return to', async () => {
    const { container, getByRole, ended } = await setup(null);
    await fireEvent.click(getByRole('button', { name: 'End impersonation' }));
    await waitFor(() => expect(container.querySelector('.atlas-impersonation-banner')).toBeNull());
    expect(ended).toHaveBeenCalledWith(expect.objectContaining({ ended: true, resumed: false }));
  });
});
