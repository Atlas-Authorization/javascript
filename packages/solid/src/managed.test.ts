import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@solidjs/testing-library';
import { createStore } from 'solid-js/store';
import { h } from './h';
import { AtlasContext } from './context';
import { ApiKeys, Checkout, DeviceAuthorization, Invoices, PricingTable, createUsage } from './index';
import type { AtlasClient, AtlasState } from './provider';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const [state] = createStore<AtlasState>({ status: 'signed_in', user: null, session: null, claims: null, memberships: [] } as unknown as AtlasState);
const client = { publishableKey: 'pk_test', frontendApi: 'https://fapi.example', state } as unknown as AtlasClient;

type Route = (url: string, init: RequestInit) => Response | undefined;
function setup(component: (p: never) => unknown, route: Route) {
  const calls: { url: string; method: string }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({ url: String(input), method: init.method ?? 'GET' });
    return route(String(input), init) ?? json({});
  }));
  return { view: render(() => h(AtlasContext.Provider, { value: client }, h(component, {}))), calls };
}
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const KEYS = { data: [{ object: 'api_key', id: 'k1', name: 'ci', prefix: 'ak_abc', claims: {}, scopes: null, last_used_at: null, expires_at: null, revoked_at: null, created_at: 1 }], allowed_scopes: [], allowed_claims: [], scope_implications: {}, max_active_keys: 5, active_count: 1 };
const plan = { object: 'billing_plan', id: 'p1', name: 'Pro', slug: 'pro', interval: 'month', amount: 1000, currency: 'usd', features: ['Fast'], audience: 'user' };
const billing: Route = (url) => {
  if (url.endsWith('/billing/plans')) return json({ data: [plan] });
  if (url.includes('/billing/subscription')) return json({ object: 'billing_subscription', subject_type: 'user', status: 'active', plan });
  if (url.includes('/billing/invoices')) return json({ data: [{ id: 'in_1', number: 'N-1', status: 'paid', amount_due: 0, amount_paid: 1000, currency: 'usd', hosted_invoice_url: null, created_at: 1 }] });
  return json({ payment_method: null });
};

describe('Solid API keys, device authorization and billing', () => {
  it('lists API keys and shows the secret once', async () => {
    const { view } = setup(ApiKeys as never, (url, init) => (url.includes('/me/api_keys') ? (init.method === 'POST' ? json({ ...KEYS.data[0], id: 'k2', secret: 'ak_SECRET' }) : json(KEYS)) : undefined));
    await waitFor(() => expect(view.container.textContent).toContain('ak_abc'));
    const create = () => [...view.container.querySelectorAll('button')].find((b) => b.textContent === 'Create key')!;
    fireEvent.click(create());
    fireEvent.click(create());
    await waitFor(() => expect(view.container.querySelector('[data-atlas="api-key-secret-value"]')?.textContent).toBe('ak_SECRET'));
  });

  it('approves a device code', async () => {
    const wire = { object: 'device_authorization', id: 'd1', user_code: 'ABCD-EFGH', status: 'pending', client: { client_id: 'c', name: 'Living room TV' }, scopes: [], created_at: 1, expires_at: 2 };
    const { view, calls } = setup(DeviceAuthorization as never, () => json(wire));
    const input = view.container.querySelector('input')!;
    fireEvent.input(input, { target: { value: 'abcdefgh' } });
    fireEvent.submit(view.container.querySelector('form')!);
    await waitFor(() => expect(view.container.textContent).toContain('Living room TV'));
    fireEvent.click([...view.container.querySelectorAll('button')].find((b) => b.textContent === 'Allow')!);
    await waitFor(() => expect(view.container.querySelector('[data-atlas="device-authorization-approved"]')).not.toBeNull());
    expect(calls.some((c) => c.url.endsWith('/approve'))).toBe(true);
  });

  it('marks the held plan current and lists invoices', async () => {
    const { view } = setup(PricingTable as never, billing);
    await waitFor(() => expect(view.container.querySelector('[data-atlas="pricing-plan"]')?.getAttribute('data-current')).toBe('true'));
    cleanup();
    const inv = setup(Invoices as never, billing);
    await waitFor(() => expect(inv.view.container.textContent).toContain('N-1'));
  });
});

describe('Solid Checkout and createUsage', () => {
  const checkoutPlan = { ...plan, badge: 'Popular', description: 'For teams', annual_available: false };
  const checkoutRoute: Route = (url) => {
    if (url.endsWith('/billing/plans')) return json({ data: [checkoutPlan] });
    if (url.endsWith('/coupons/validate')) return json({ valid: true, reason: null, discount: { percent_off: 10, amount_off: null, currency: null, duration: 'once', duration_months: null } });
    if (url.includes('/billing/usage')) return json({ total: 42, since: 1 });
    return json({});
  };

  it('shows badge and description, applies a code and sends it to checkout', async () => {
    const { view, calls } = setup((() => Checkout({ planId: 'p1' })) as never, checkoutRoute);
    await waitFor(() => expect(view.container.textContent).toContain('Popular'));
    expect(view.container.textContent).toContain('For teams');
    fireEvent.input(view.container.querySelector('input')!, { target: { value: 'SAVE' } });
    fireEvent.click([...view.container.querySelectorAll('button')].find((b) => b.textContent === 'Apply')!);
    await waitFor(() => expect(view.container.querySelector('[data-atlas="checkout-coupon-applied"]')?.textContent).toContain('10% off'));
    fireEvent.click([...view.container.querySelectorAll('button')].find((b) => b.textContent === 'Subscribe')!);
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/billing/checkout'))).toBe(true));
  });

  it('createUsage reads the metered total', async () => {
    const Probe = () => { const { state } = createUsage({ feature: 'calls' }); return (() => h('p', { 'data-atlas': 'used' }, String(state().total))) as never; };
    const { view } = setup(Probe as never, checkoutRoute);
    await waitFor(() => expect(view.container.querySelector('[data-atlas="used"]')?.textContent).toBe('42'));
  });
});
