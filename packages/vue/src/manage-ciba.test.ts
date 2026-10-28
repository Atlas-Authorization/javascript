import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, shallowRef, type App } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import { ATLAS_INJECTION_KEY } from './context';
import type { AtlasClient, AuthStatus } from './plugin';
import { EN_US } from './i18n';
import { ManageCiba } from './index';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const REQUEST = { id: 'bcr_1', client_name: 'Acme Kiosk', scope: ['openid'], binding_message: 'Code 1234', created_at: 1, expires_at: 2 };

const client = {
  publishableKey: 'pk_test', frontendApi: 'https://fapi.example', appearance: undefined, catalog: EN_US,
  status: shallowRef<AuthStatus>('signed_in'), user: shallowRef(null), session: shallowRef(null), claims: shallowRef(null), memberships: shallowRef([]),
  pendingAttempt: null, getToken: async () => null, getProviderToken: async () => null, signOut: async () => ({ revoked: true }),
  setActiveOrganization: async () => undefined, endImpersonation: async () => ({ ended: false, resumed: false, status: 0 }),
  reload: async () => true, onSignOut: () => () => undefined,
} as unknown as AtlasClient;

type Route = (url: string, init: RequestInit) => Response | undefined;
function mountCiba(route: Route) {
  const calls: { url: string; method: string; body: unknown }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({ url: String(input), method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) : undefined });
    return route(String(input), init) ?? json({});
  }));
  const Host = defineComponent({ setup: () => () => h(ManageCiba) });
  const w = mount(Host, { global: { plugins: [{ install: (app: App) => app.provide(ATLAS_INJECTION_KEY, client) }] } });
  return { w, calls };
}
afterEach(() => vi.unstubAllGlobals());

describe('<ManageCiba/>', () => {
  it('renders nothing when there is no request, no PIN and no app that can ask', async () => {
    const { w } = mountCiba((url) => (url.endsWith('/ciba_pin') ? json({ set: false, available: false }) : json({ data: [] })));
    await flushPromises();
    expect(w.find('[data-atlas="manage-ciba"]').exists()).toBe(false);
  });

  it('lists a request and sends the decision', async () => {
    let open = true;
    const { w, calls } = mountCiba((url, init) => {
      if (url.endsWith('/ciba_pin')) return json({ set: false, available: false });
      if (url.endsWith('/backchannel_requests')) return json({ data: open ? [REQUEST] : [] });
      if (url.endsWith('/bcr_1') && init.method === 'POST') { open = false; return json({ status: 'denied' }); }
      return undefined;
    });
    await flushPromises();
    expect(w.text()).toContain('Acme Kiosk');
    await w.findAll('button').find((b) => b.text() === 'Deny')!.trigger('click');
    await flushPromises();
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ decision: 'deny' });
    expect(w.text()).not.toContain('Acme Kiosk');
  });

  it('sets the PIN with the current password and clears the fields', async () => {
    const { w, calls } = mountCiba((url, init) => {
      if (url.endsWith('/backchannel_requests')) return json({ data: [] });
      if (url.endsWith('/ciba_pin')) return init.method === 'PUT' ? json({ set: true }) : json({ set: false, available: true });
      return undefined;
    });
    await flushPromises();
    const [pw, pin] = w.findAll('input');
    await pw!.setValue('correct horse battery');
    await pin!.setValue('482913');
    await w.find('form').trigger('submit');
    await flushPromises();
    expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ pin: '482913', current_password: 'correct horse battery' });
    expect((w.findAll('input')[1]!.element as HTMLInputElement).value).toBe('');
  });

  it('shows the server refusal when the PIN is rejected', async () => {
    const { w } = mountCiba((url, init) => {
      if (url.endsWith('/backchannel_requests')) return json({ data: [] });
      return init.method === 'PUT' ? json({ errors: [{ code: 'VALIDATION', message: 'The PIN must be 6 to 12 digits.' }] }, 400) : json({ set: false, available: true });
    });
    await flushPromises();
    await w.find('form').trigger('submit');
    await flushPromises();
    expect(w.text()).toContain('The PIN must be 6 to 12 digits.');
  });
});
