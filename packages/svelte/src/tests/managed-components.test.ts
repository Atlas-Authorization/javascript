import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, waitFor } from '@testing-library/svelte';
import { writable } from 'svelte/store';
import type { ComponentType } from 'svelte';
import { ATLAS_KEY } from '../lib/context';
import { EN_US } from '../lib/i18n';
import ApiKeys from '../lib/components/ApiKeys.svelte';
import DeviceAuthorization from '../lib/components/DeviceAuthorization.svelte';
import Invoices from '../lib/components/Invoices.svelte';
import PricingTable from '../lib/components/PricingTable.svelte';
import Checkout from '../lib/components/Checkout.svelte';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const client = { publishableKey: 'pk_test', frontendApi: 'https://fapi.example', catalog: EN_US, status: writable('signed_in') };
type Route = (url: string, init: RequestInit) => Response | undefined;

function setup(component: ComponentType, route: Route, props: Record<string, unknown> = {}) {
  const calls: { url: string; method: string }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({ url: String(input), method: init.method ?? 'GET' });
    return route(String(input), init) ?? json({});
  }));
  return { ...render(component, { props, context: new Map([[ATLAS_KEY, client]]) }), calls };
}
afterEach(() => vi.unstubAllGlobals());

const KEYS = { data: [{ object: 'api_key', id: 'k1', name: 'ci', prefix: 'ak_abc', claims: {}, scopes: null, last_used_at: null, expires_at: null, revoked_at: null, created_at: 1 }], allowed_scopes: [], allowed_claims: [], scope_implications: {}, max_active_keys: 5, active_count: 1 };
const plan = { object: 'billing_plan', id: 'p1', name: 'Pro', slug: 'pro', interval: 'month', amount: 1000, currency: 'usd', features: ['Fast'], audience: 'user' };
const billing: Route = (url) => {
  if (url.endsWith('/billing/plans')) return json({ data: [plan] });
  if (url.includes('/billing/subscription')) return json({ object: 'billing_subscription', subject_type: 'user', status: 'active', plan });
  if (url.includes('/billing/invoices')) return json({ data: [{ id: 'in_1', number: 'N-1', status: 'paid', amount_due: 0, amount_paid: 1000, currency: 'usd', hosted_invoice_url: null, created_at: 1 }] });
  return json({ payment_method: null });
};

describe('Svelte API keys, device authorization and billing', () => {
  it('lists keys and shows the secret once after create', async () => {
    const { findByText, getAllByText, container } = setup(ApiKeys, (url, init) => (url.includes('/me/api_keys') ? (init.method === 'POST' ? json({ ...KEYS.data[0], id: 'k2', secret: 'ak_SECRET' }) : json(KEYS)) : undefined));
    await findByText('ak_abc…');
    await fireEvent.click(getAllByText('Create key')[0]!);
    await fireEvent.click(getAllByText('Create key')[0]!);
    await waitFor(() => expect(container.querySelector('[data-atlas="api-key-secret-value"]')?.textContent).toBe('ak_SECRET'));
  });

  it('looks a device code up and approves it', async () => {
    const wire = { object: 'device_authorization', id: 'd1', user_code: 'ABCD-EFGH', status: 'pending', client: { client_id: 'c', name: 'Living room TV' }, scopes: [], created_at: 1, expires_at: 2 };
    const { container, findByText, getByText, calls } = setup(DeviceAuthorization, () => json(wire));
    await fireEvent.input(container.querySelector('input')!, { target: { value: 'abcdefgh' } });
    await fireEvent.submit(container.querySelector('form')!);
    await findByText(/Living room TV/);
    await fireEvent.click(getByText('Allow'));
    await waitFor(() => expect(container.querySelector('[data-atlas="device-authorization-approved"]')).not.toBeNull());
    expect(calls.some((c) => c.url.endsWith('/approve'))).toBe(true);
  });

  it('marks the held plan current', async () => {
    const { container } = setup(PricingTable, billing);
    await waitFor(() => expect(container.querySelector('[data-atlas="pricing-plan"]')?.getAttribute('data-current')).toBe('true'));
  });

  it('lists invoices', async () => {
    const { findByText } = setup(Invoices, billing);
    await findByText('N-1');
  });
});

describe('Svelte Checkout', () => {
  const checkoutPlan = { ...plan, badge: 'Popular', description: 'For teams', annual_available: false };
  const route: Route = (url) => {
    if (url.endsWith('/billing/plans')) return json({ data: [checkoutPlan] });
    if (url.endsWith('/coupons/validate')) return json({ valid: true, reason: null, discount: { percent_off: 10, amount_off: null, currency: null, duration: 'once', duration_months: null } });
    return json({});
  };

  it('shows badge and description, applies a code and sends it to checkout', async () => {
    const { container, findByText, getByText, calls } = setup(Checkout as unknown as ComponentType, route, { planId: "p1" });
    await findByText('Popular');
    expect(container.textContent).toContain('For teams');
    await fireEvent.input(container.querySelector('input')!, { target: { value: 'SAVE' } });
    await fireEvent.click(getByText('Apply'));
    await waitFor(() => expect(container.querySelector('[data-atlas="checkout-coupon-applied"]')?.textContent).toContain('10% off'));
    await fireEvent.click(getByText('Subscribe'));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/billing/checkout'))).toBe(true));
  });
});
