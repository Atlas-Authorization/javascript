import { describe, expect, it, vi } from 'vitest';
import { describeDiscount, formatMoney, planPriceView, startPlanCheckout, syncCheckoutReturn, validatePlanCoupon, type PublicBillingPlan } from './pricing';
import type { FapiClient } from './fapi';

const plan = (over: Partial<PublicBillingPlan> = {}): PublicBillingPlan => ({
  object: 'billing_plan', id: 'bp_1', name: 'Pro', slug: 'pro', interval: 'month', amount: '1500', currency: 'usd',
  features: [], audience: 'user', ...over,
});

describe('formatMoney', () => {
  it('formats minor units in the locale', () => {
    expect(formatMoney(1500, 'usd', 'en-US')).toBe('$15.00');
    expect(formatMoney(1500, 'eur', 'de-DE').replace(/\s/g, ' ')).toBe('15,00 €');
  });
  it('falls back for an unknown currency', () => {
    expect(formatMoney(1234, 'zzzz', 'en-US')).toBe('12.34 ZZZZ');
  });
});

describe('planPriceView', () => {
  it('shows the plan price and a trial', () => {
    const v = planPriceView(plan({ trial_days: 14 }), { locale: 'en-US' });
    expect(v).toMatchObject({ price: '$15.00', interval: 'month', trialDays: 14, free: false, amount: 1500 });
    expect(v.originalPrice).toBeUndefined();
  });
  it('uses the annual price when asked and offered, else stays monthly', () => {
    const p = plan({ annual_available: true, annual_amount: '14400' });
    expect(planPriceView(p, { interval: 'year', locale: 'en-US' })).toMatchObject({ price: '$144.00', interval: 'year' });
    expect(planPriceView(plan(), { interval: 'year', locale: 'en-US' })).toMatchObject({ price: '$15.00', interval: 'month' });
  });
  it('strikes through a percent or amount promotion, and hides an expired one', () => {
    const now = 1_000;
    const pct = planPriceView(plan({ promotion: { label: '20% off', percent_off: 20, code: 'LAUNCH' } }), { locale: 'en-US', now });
    expect(pct).toMatchObject({ price: '$12.00', originalPrice: '$15.00', promotionLabel: '20% off', promotionCode: 'LAUNCH', amount: 1200 });
    const off = planPriceView(plan({ promotion: { label: '$5 off', amount_off: 500 } }), { locale: 'en-US', now });
    expect(off).toMatchObject({ price: '$10.00', originalPrice: '$15.00' });
    const expired = planPriceView(plan({ promotion: { label: 'old', percent_off: 50, ends_at: 500 } }), { locale: 'en-US', now });
    expect(expired.originalPrice).toBeUndefined();
    expect(expired.promotionLabel).toBeUndefined();
  });
  it('marks a free plan', () => {
    expect(planPriceView(plan({ amount: null }), { locale: 'en-US' })).toMatchObject({ free: true, price: '$0.00' });
  });
});

describe('discount codes at checkout', () => {
  const fake = (response: { ok: boolean; data?: unknown; errors?: Array<{ message: string }> }) => {
    const calls: Array<{ path: string; body: unknown }> = [];
    const client = { post: async (path: string, body: unknown) => (calls.push({ path, body }), { errors: [], ...response }) } as unknown as FapiClient;
    return { client, calls };
  };

  it('describes a discount in one line', () => {
    expect(describeDiscount({ percent_off: 20, amount_off: null, currency: null, duration: 'once', duration_months: null })).toBe('20% off on the first payment');
    expect(describeDiscount({ percent_off: 20, amount_off: null, currency: null, duration: 'repeating', duration_months: 3 })).toBe('20% off for 3 months');
    expect(describeDiscount({ percent_off: null, amount_off: 500, currency: 'usd', duration: 'forever', duration_months: null }, 'en-US')).toBe('$5.00 off, forever');
  });

  it('validates a code for a plan and reports why it failed', async () => {
    const ok = fake({ ok: true, data: { valid: true, reason: null, discount: { percent_off: 10, amount_off: null, currency: null, duration: 'once', duration_months: null } } });
    expect(await validatePlanCoupon(ok.client, { planId: 'bp_1', code: ' SAVE10 ', orgId: 'org_1' })).toMatchObject({ valid: true });
    expect(ok.calls[0]).toEqual({ path: '/v1/client/billing/coupons/validate', body: { code: 'SAVE10', plan_id: 'bp_1', org_id: 'org_1' } });
    const bad = fake({ ok: true, data: { valid: false, reason: 'expired' } });
    expect(await validatePlanCoupon(bad.client, { planId: 'bp_1', code: 'OLD' })).toEqual({ valid: false, reason: 'expired' });
    const down = fake({ ok: false });
    expect(await validatePlanCoupon(down.client, { planId: 'bp_1', code: 'X' })).toEqual({ valid: false, reason: 'invalid' });
  });

  it('sends the code with the checkout', async () => {
    const f = fake({ ok: true, data: { url: 'https://pay.example/c' } });
    await startPlanCheckout(f.client, { planId: 'bp_1', successUrl: 'https://app.example/done', couponCode: 'SAVE10' });
    expect(f.calls[0]!.body).toMatchObject({ plan_id: 'bp_1', coupon_code: 'SAVE10' });
  });
});

describe('syncCheckoutReturn', () => {
  const clientOf = (res: unknown) => {
    const post = vi.fn(async () => res);
    return { client: { post } as unknown as FapiClient, post };
  };
  it('does nothing when the URL carries no session id', async () => {
    const { client, post } = clientOf({ ok: true, data: {}, errors: [] });
    expect(await syncCheckoutReturn(client, { href: 'https://app.test/billing', clearUrl: false })).toBeNull();
    expect(post).not.toHaveBeenCalled();
  });
  it('posts the session id from the return URL once', async () => {
    const { client, post } = clientOf({ ok: true, data: { status: 'synced' }, errors: [] });
    const href = 'https://app.test/billing?atlas_checkout_session=cs_test_once1';
    expect(await syncCheckoutReturn(client, { href, clearUrl: false })).toEqual({ status: 'synced' });
    expect(post).toHaveBeenCalledWith('/v1/client/billing/checkout/sync', { session_id: 'cs_test_once1' });
    expect(await syncCheckoutReturn(client, { href, clearUrl: false })).toBeNull();
    expect(post).toHaveBeenCalledTimes(1);
  });
  it('reads a Stripe session_id parameter and ignores anything that is not a session id', async () => {
    const { client, post } = clientOf({ ok: true, data: { status: 'pending' }, errors: [] });
    expect(await syncCheckoutReturn(client, { href: 'https://app.test/?session_id=cs_live_p2', clearUrl: false })).toEqual({ status: 'pending' });
    expect(await syncCheckoutReturn(client, { href: 'https://app.test/?session_id=abc', clearUrl: false })).toBeNull();
    expect(post).toHaveBeenCalledTimes(1);
  });
  it('reports a refusal', async () => {
    const { client } = clientOf({ ok: false, data: null, errors: [{ message: 'Unknown checkout session.' }] });
    expect(await syncCheckoutReturn(client, { href: 'https://app.test/?atlas_checkout_session=cs_test_bad', clearUrl: false })).toEqual({
      status: 'error',
      error: 'Unknown checkout session.',
    });
  });
});
