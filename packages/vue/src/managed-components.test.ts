import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, shallowRef, type App, type Component } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import { ATLAS_INJECTION_KEY } from './context';
import type { AtlasClient, AuthStatus } from './plugin';
import { EN_US } from './i18n';
import { ApiKeys, Checkout, DeviceAuthorization, Invoices, PricingTable, useUsage } from './index';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const client = (status: AuthStatus = 'signed_in') =>
  ({
    publishableKey: 'pk_test', frontendApi: 'https://fapi.example', appearance: undefined, catalog: EN_US,
    status: shallowRef<AuthStatus>(status), user: shallowRef(null), session: shallowRef(null), claims: shallowRef(null), memberships: shallowRef([]),
    pendingAttempt: null, getToken: async () => null, getProviderToken: async () => null, signOut: async () => ({ revoked: true }),
    setActiveOrganization: async () => undefined, endImpersonation: async () => ({ ended: false, resumed: false, status: 0 }),
    reload: async () => true, onSignOut: () => () => undefined,
  }) as unknown as AtlasClient;

type Route = (url: string, init: RequestInit) => Response | undefined;
function mountWith(component: Component, route: Route, props: Record<string, unknown> = {}, status: AuthStatus = 'signed_in') {
  const calls: { url: string; method: string; body: unknown }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({ url: String(input), method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) : undefined });
    return route(String(input), init) ?? json({});
  }));
  const Host = defineComponent({ setup: () => () => h(component, props) });
  const w = mount(Host, { global: { plugins: [{ install: (app: App) => app.provide(ATLAS_INJECTION_KEY, client(status)) }] } });
  return { w, calls };
}
afterEach(() => vi.unstubAllGlobals());

const KEYS = { data: [{ object: 'api_key', id: 'k1', name: 'ci', prefix: 'ak_abc', claims: {}, scopes: null, last_used_at: null, expires_at: null, revoked_at: null, created_at: 1 }], allowed_scopes: [], allowed_claims: [], scope_implications: {}, max_active_keys: 5, active_count: 1 };

describe('<ApiKeys/>', () => {
  it('lists keys and shows the secret once after create', async () => {
    const { w, calls } = mountWith(ApiKeys, (url, init) => {
      if (url.includes('/me/api_keys') && init.method === 'POST') return json({ ...KEYS.data[0], id: 'k2', secret: 'ak_SECRET' });
      if (url.includes('/me/api_keys')) return json(KEYS);
      return undefined;
    });
    await flushPromises();
    expect(w.text()).toContain('ak_abc');
    await w.findAll('button').find((b) => b.text() === 'Create key')!.trigger('click');
    await w.findAll('button').find((b) => b.text() === 'Create key')!.trigger('click');
    await flushPromises();
    expect(calls.some((c) => c.method === 'POST')).toBe(true);
    expect(w.find('[data-atlas="api-key-secret-value"]').text()).toBe('ak_SECRET');
  });

  it('renders the disabled state on a 403 list', async () => {
    const { w } = mountWith(ApiKeys, () => json({ errors: [{ code: 'FORBIDDEN', message: 'off' }] }, 403));
    await flushPromises();
    expect(w.find('[data-atlas="api-keys-disabled"]').exists()).toBe(true);
  });
});

describe('<DeviceAuthorization/>', () => {
  const wire = { object: 'device_authorization', id: 'd1', user_code: 'ABCD-EFGH', status: 'pending', client: { client_id: 'c', name: 'Living room TV' }, scopes: [{ scope: 'openid', description: 'Know who you are' }], created_at: 1, expires_at: 2 };

  it('looks a code up and approves it', async () => {
    const { w, calls } = mountWith(DeviceAuthorization, () => json(wire));
    await w.find('input').setValue('abcdefgh');
    await w.find('form').trigger('submit');
    await flushPromises();
    expect(w.text()).toContain('Living room TV');
    await w.findAll('button').find((b) => b.text() === 'Allow')!.trigger('click');
    await flushPromises();
    expect(calls.some((c) => c.url.endsWith('/approve'))).toBe(true);
    expect(w.find('[data-atlas="device-authorization-approved"]').exists()).toBe(true);
  });
});

describe('billing components', () => {
  const plan = { object: 'billing_plan', id: 'p1', name: 'Pro', slug: 'pro', interval: 'month', amount: 1000, currency: 'usd', features: ['Fast'], audience: 'user' };
  const route: Route = (url) => {
    if (url.endsWith('/billing/plans')) return json({ data: [plan] });
    if (url.includes('/billing/subscription')) return json({ object: 'billing_subscription', subject_type: 'user', status: 'active', plan });
    if (url.includes('/billing/invoices')) return json({ data: [{ id: 'in_1', number: 'N-1', status: 'paid', amount_due: 0, amount_paid: 1000, currency: 'usd', hosted_invoice_url: 'https://x/i', created_at: 1 }] });
    return json({ payment_method: null });
  };

  it('marks the held plan current and opens the portal', async () => {
    const { w, calls } = mountWith(PricingTable, route);
    await flushPromises();
    expect(w.find('[data-atlas="pricing-plan"]').attributes('data-current')).toBe('true');
    await w.find('[data-atlas="manage-billing"]').trigger('click');
    await flushPromises();
    expect(calls.some((c) => c.url.endsWith('/billing/portal'))).toBe(true);
  });

  it('lists invoices', async () => {
    const { w } = mountWith(Invoices, route);
    await flushPromises();
    expect(w.text()).toContain('N-1');
  });
});

describe('<Checkout/> and useUsage', () => {
  const plan = { object: 'billing_plan', id: 'p1', name: 'Pro', slug: 'pro', interval: 'month', amount: 1000, currency: 'usd', features: [], audience: 'user', badge: 'Popular', description: 'For teams', annual_available: false };
  const route: Route = (url) => {
    if (url.endsWith('/billing/plans')) return json({ data: [plan] });
    if (url.endsWith('/coupons/validate')) return json({ valid: true, reason: null, discount: { percent_off: 10, amount_off: null, currency: null, duration: 'once', duration_months: null } });
    if (url.endsWith('/billing/checkout')) return json({ url: null });
    if (url.includes('/billing/usage')) return json({ total: 42, since: 1 });
    return json({});
  };

  it('shows the plan badge and description, applies a code and sends it to checkout', async () => {
    const { w, calls } = mountWith(Checkout, route, { planId: 'p1' });
    await flushPromises();
    expect(w.text()).toContain('Popular');
    expect(w.text()).toContain('For teams');
    await w.find('input').setValue('SAVE');
    await w.findAll('button').find((b) => b.text() === 'Apply')!.trigger('click');
    await flushPromises();
    expect(w.find('[data-atlas="checkout-coupon-applied"]').text()).toContain('10% off');
    await w.findAll('button').find((b) => b.text() === 'Subscribe')!.trigger('click');
    await flushPromises();
    expect(calls.find((c) => c.url.endsWith('/billing/checkout'))!.body).toMatchObject({ plan_id: 'p1', coupon_code: 'SAVE' });
  });

  it('useUsage reads the metered total', async () => {
    const Probe = defineComponent({ setup() { const { state } = useUsage({ feature: 'calls' }); return () => h('p', { 'data-atlas': 'used' }, String(state.value.total)); } });
    const { w, calls } = mountWith(Probe, route);
    await flushPromises();
    expect(w.find('[data-atlas="used"]').text()).toBe('42');
    expect(calls.some((c) => c.url.includes('/billing/usage?feature=calls'))).toBe(true);
  });
});
