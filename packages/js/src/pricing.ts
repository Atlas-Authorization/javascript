import type { FapiClient } from './fapi';

/**
 * Plans and pricing for the framework-agnostic `<PricingTable>`s (React, Vue,
 * embed): list the instance's public plans, work out what to SHOW for each
 * (locale-formatted price, annual vs monthly, trial, struck-through promotion
 * price) and start a provider Checkout. Pure display logic lives in
 * {@link planPriceView} so every SDK renders the same numbers.
 */

/** A plan's display-only promotion. It never changes the charge; the code is applied at checkout. */
export interface PlanPromotionView {
  label: string;
  percent_off?: number;
  /** Minor units (cents). */
  amount_off?: number;
  /** Epoch ms. */
  ends_at?: number;
  code?: string;
}

export interface PublicBillingPlan {
  object: 'billing_plan';
  id: string;
  name: string;
  slug: string;
  interval: string;
  /** Smallest currency unit, as a string or number (the API sends the stored string). */
  amount: number | string | null;
  currency: string;
  features: string[];
  audience: 'user' | 'org';
  kind?: 'base' | 'addon';
  trial_days?: number | null;
  annual_available?: boolean;
  annual_amount?: number | string | null;
  promotion?: PlanPromotionView | null;
  provider?: string;
}

/** What to render for one plan at one billing interval. */
export interface PlanPriceView {
  /** The price now, formatted for the locale (after any promotion). */
  price: string;
  /** The undiscounted price, formatted - present only when a promotion lowers it. */
  originalPrice?: string;
  interval: 'month' | 'year';
  /** "Free" label is the caller's: true when the plan costs nothing. */
  free: boolean;
  trialDays: number | null;
  promotionLabel?: string;
  promotionCode?: string;
  /** Minor units after the promotion. */
  amount: number;
}

const minor = (v: number | string | null | undefined): number => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : 0;
};

/** A minor-unit amount as a locale-formatted currency string (falls back to `12.34 USD`). */
export function formatMoney(amountMinor: number, currency: string, locale?: string): string {
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency: currency.toUpperCase() }).format(amountMinor / 100);
  } catch {
    return `${(amountMinor / 100).toFixed(2)} ${currency.toUpperCase()}`;
  }
}

/**
 * The price, trial and promotion to show for `plan` at `interval` (default the plan's own).
 * An annual interval uses `annual_amount` when the plan offers one. An expired promotion is ignored.
 */
export function planPriceView(
  plan: PublicBillingPlan,
  opts: { interval?: 'month' | 'year'; locale?: string; now?: number } = {},
): PlanPriceView {
  const own = plan.interval === 'year' ? 'year' : 'month';
  const interval = opts.interval ?? own;
  const annualPrice = plan.annual_available && plan.annual_amount != null ? minor(plan.annual_amount) : null;
  // The plan's own price is in its own interval; the other interval only exists as an annual price.
  const base = interval === own ? minor(plan.amount) : interval === 'year' && annualPrice !== null ? annualPrice : minor(plan.amount);
  const shownInterval = interval === own || (interval === 'year' && annualPrice !== null) ? interval : own;

  const promo = plan.promotion && !(plan.promotion.ends_at !== undefined && plan.promotion.ends_at <= (opts.now ?? Date.now())) ? plan.promotion : null;
  let amount = base;
  if (promo?.percent_off) amount = Math.round(base * (1 - promo.percent_off / 100));
  else if (promo?.amount_off) amount = Math.max(0, base - promo.amount_off);

  const discounted = promo !== null && amount < base;
  return {
    price: formatMoney(amount, plan.currency, opts.locale),
    ...(discounted ? { originalPrice: formatMoney(base, plan.currency, opts.locale) } : {}),
    interval: shownInterval,
    free: amount === 0 && base === 0,
    trialDays: plan.trial_days && plan.trial_days > 0 ? plan.trial_days : null,
    ...(promo ? { promotionLabel: promo.label } : {}),
    ...(promo?.code ? { promotionCode: promo.code } : {}),
    amount,
  };
}

/** The instance's active public plans. `audience` narrows to user (B2C) or org (B2B) plans. */
export async function listPublicPlans(client: FapiClient, opts: { audience?: 'user' | 'org' } = {}): Promise<PublicBillingPlan[]> {
  const res = await client.get<{ data: PublicBillingPlan[] }>('/v1/client/billing/plans');
  const all = res.ok && res.data ? (res.data.data ?? []) : [];
  return opts.audience ? all.filter((p) => p.audience === opts.audience) : all;
}

/**
 * Start a provider Checkout for a plan and return its URL (the caller navigates).
 * Needs a signed-in session; for an organization plan pass `orgId`.
 */
export async function startPlanCheckout(
  client: FapiClient,
  input: { planId: string; interval?: 'month' | 'year'; orgId?: string; successUrl: string; cancelUrl?: string },
): Promise<{ url: string | null; error?: string }> {
  const res = await client.post<{ url?: string }>('/v1/client/billing/checkout', {
    plan_id: input.planId,
    ...(input.orgId ? { org_id: input.orgId } : {}),
    ...(input.interval ? { interval: input.interval } : {}),
    success_url: input.successUrl,
    cancel_url: input.cancelUrl ?? input.successUrl,
  });
  if (res.ok && res.data?.url) return { url: res.data.url };
  return { url: null, error: res.errors[0]?.message ?? 'Could not start checkout.' };
}
