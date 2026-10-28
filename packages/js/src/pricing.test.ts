import { describe, expect, it } from 'vitest';
import { formatMoney, planPriceView, type PublicBillingPlan } from './pricing';

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
