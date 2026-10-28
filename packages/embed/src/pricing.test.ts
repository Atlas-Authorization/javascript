// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { mountPricingTable } from './pricing';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const tick = () => new Promise((r) => setTimeout(r, 10));

const PLANS = [
  { object: 'billing_plan', id: 'bp_1', name: 'Pro', slug: 'pro', interval: 'month', amount: '1500', currency: 'usd', features: ['SSO'], audience: 'user', trial_days: 14, annual_available: true, annual_amount: '14400', promotion: { label: 'Launch', percent_off: 20, code: 'LAUNCH' } },
  { object: 'billing_plan', id: 'bp_2', name: 'Team', slug: 'team', interval: 'month', amount: '4000', currency: 'usd', features: [], audience: 'org' },
];

describe('mountPricingTable', () => {
  it('renders price, trial, promotion and starts checkout; audience filters plans', async () => {
    const calls: Array<{ url: string; method: string; body?: unknown }> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      calls.push({ url, method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) : undefined });
      if (url.includes('/v1/client/billing/plans')) return json({ object: 'list', data: PLANS });
      return json({ url: 'https://checkout.example/session' });
    }) as unknown as typeof fetch;
    const host = document.createElement('div');
    document.body.append(host);
    mountPricingTable(host, { publishableKey: 'pk_test_x', frontendApi: 'https://fapi.example', audience: 'user', locale: 'en-US', fetchImpl });
    await tick();
    expect(host.querySelectorAll('[data-atlas="pricing-plan"]')).toHaveLength(1);
    expect(host.textContent).toContain('$12.00');
    expect(host.querySelector('[data-atlas="pricing-original"]')?.textContent).toBe('$15.00');
    expect(host.querySelector('[data-atlas="pricing-trial"]')?.textContent).toBe('14-day free trial');
    expect(host.querySelector('[data-atlas="pricing-code"]')?.textContent).toContain('LAUNCH');

    // Yearly switch re-renders from the annual price.
    [...host.querySelectorAll('button')].find((b) => b.textContent === 'Yearly')!.click();
    expect(host.textContent).toContain('$115.20');

    const onError = vi.fn();
    const navigate = vi.fn();
    mountPricingTable(host, { publishableKey: 'pk_test_x', frontendApi: 'https://fapi.example', audience: 'user', locale: 'en-US', fetchImpl, onError, navigate });
    await tick();
    [...host.querySelectorAll('button')].find((b) => b.textContent === 'Subscribe')!.click();
    await vi.waitFor(() => expect(navigate).toHaveBeenCalled());
    const checkout = calls.find((c) => new URL(c.url).pathname === '/v1/client/billing/checkout');
    expect(checkout).toMatchObject({ method: 'POST', body: { plan_id: 'bp_1' } });
    expect(navigate).toHaveBeenCalledWith('https://checkout.example/session');
  });
});
