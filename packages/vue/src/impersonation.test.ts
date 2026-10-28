// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import { createAtlas } from './plugin';
import { ImpersonationBanner } from './components';

/**
 * `<ImpersonationBanner>` (Vue), driven through the real client: it shows only
 * on an impersonation session, and "Return to admin" ends it and adopts the
 * impersonator's own session.
 */

const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const jwt = (claims: Record<string, unknown>) =>
  `${b64({ alg: 'none' })}.${b64({ exp: Math.floor(Date.now() / 1000) + 3600, ...claims })}.sig`;
const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

afterEach(() => {
  try {
    localStorage.clear();
  } catch {
    /* no storage */
  }
});

function harness(actorSessionId: string | null, impersonating = true) {
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
  });
  const ended = vi.fn();
  const Host = defineComponent({ setup: () => () => h(ImpersonationBanner, { onEnded: ended }) });
  const wrapper = mount(Host, {
    global: {
      plugins: [
        createAtlas({
          publishableKey: 'pk_test',
          frontendApi: 'https://fapi.example',
          fetchImpl: fetchImpl as unknown as typeof fetch,
        }),
      ],
    },
  });
  return { wrapper, calls, ended };
}

describe('<ImpersonationBanner> (Vue)', () => {
  it('renders nothing on an ordinary session', async () => {
    const { wrapper } = harness(null, false);
    await flushPromises();
    expect(wrapper.find('.atlas-impersonation-banner').exists()).toBe(false);
  });

  it('returns to the admin session', async () => {
    const { wrapper, calls, ended } = harness('sess_admin');
    await flushPromises();
    const banner = wrapper.find('.atlas-impersonation-banner');
    expect(banner.text()).toContain('Tess');
    const button = banner.find('button');
    expect(button.text()).toBe('Return to admin');
    await button.trigger('click');
    await flushPromises();
    expect(calls).toContain('POST https://fapi.example/v1/client/sessions/sess_imp/end_impersonation');
    expect(ended).toHaveBeenCalledWith(expect.objectContaining({ ended: true, resumed: true, activeSessionId: 'sess_admin' }));
    expect(wrapper.find('.atlas-impersonation-banner').exists()).toBe(false);
  });

  it('"End impersonation" signs out when there is nothing to return to', async () => {
    const { wrapper, ended } = harness(null);
    await flushPromises();
    const button = wrapper.find('.atlas-impersonation-banner button');
    expect(button.text()).toBe('End impersonation');
    await button.trigger('click');
    await flushPromises();
    expect(ended).toHaveBeenCalledWith(expect.objectContaining({ ended: true, resumed: false }));
    expect(wrapper.find('.atlas-impersonation-banner').exists()).toBe(false);
  });
});
