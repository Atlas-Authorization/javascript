import { describe, expect, it } from 'vitest';
import { liveAddonsOf, manageUrl, subscriptionsOf } from './billing';
import type { AtlasBillingPlan, AtlasBillingSubscription } from './types';

const plan = (id: string, kind: 'base' | 'addon'): AtlasBillingPlan => ({
  object: 'billing_plan',
  id,
  name: id,
  slug: id,
  interval: 'month',
  amount: 1000,
  currency: 'usd',
  features: [],
  audience: 'user',
  kind,
});
const sub = (id: string, p: AtlasBillingPlan, status: string): AtlasBillingSubscription => ({
  object: 'billing_subscription',
  id,
  subject_type: 'user',
  status,
  plan: p,
});

describe('useBilling with several subscriptions', () => {
  it('routes a change/cancel/restore to one subscription by id, else to the primary one', () => {
    expect(manageUrl('cancel')).toBe('/v1/client/billing/subscription/cancel');
    expect(manageUrl('cancel', 'bsub_1')).toBe('/v1/client/billing/subscriptions/bsub_1/cancel');
    expect(manageUrl('change', 'bsub/../x')).toBe('/v1/client/billing/subscriptions/bsub%2F..%2Fx/change');
  });

  it('reads subscriptions[] and stays compatible with a single-subscription server', () => {
    const base = sub('bsub_1', plan('pro', 'base'), 'active');
    const addon = sub('bsub_2', plan('extra', 'addon'), 'active');
    expect(subscriptionsOf({ ...base, subscriptions: [base, addon] })).toEqual([base, addon]);
    // An older server: the one subscription it reports.
    expect(subscriptionsOf(base)).toEqual([base]);
    // Never subscribed.
    expect(subscriptionsOf({ object: 'billing_subscription', subject_type: 'user', status: null, plan: null })).toEqual([]);
    expect(subscriptionsOf(null)).toEqual([]);
  });

  it('lists the live add-ons only', () => {
    const subs = [
      sub('bsub_1', plan('pro', 'base'), 'active'),
      sub('bsub_2', plan('extra', 'addon'), 'trialing'),
      sub('bsub_3', plan('old', 'addon'), 'canceled'),
    ];
    expect(liveAddonsOf(subs).map((s) => s.id)).toEqual(['bsub_2']);
  });
});

describe('<PricingTable/> price display', () => {
  it('formats with planPriceView: trial, annual price and a struck-through promotion', async () => {
    const { planPriceView } = await import('@atlasauth/js');
    const pro = { ...plan('pro', 'base'), trial_days: 14, annual_available: true, annual_amount: '9600', promotion: { label: 'Launch', percent_off: 25, code: 'LAUNCH' } };
    expect(planPriceView(pro, { locale: 'en-US' })).toMatchObject({ price: '$7.50', originalPrice: '$10.00', trialDays: 14, promotionCode: 'LAUNCH' });
    expect(planPriceView(pro, { interval: 'year', locale: 'en-US' })).toMatchObject({ price: '$72.00', interval: 'year' });
  });
});
