import type { FapiClient } from './fapi';
import { formatMoney } from './pricing';

/** What the signed-in user has earned from referrals (`GET /v1/client/me/referral/rewards`). Amounts are minor units. */
export interface ReferralRewardsSummary {
  /** Whether the app has referral rewards turned on. */
  enabled: boolean;
  referralCode: string | null;
  referralLink: string | null;
  /** The reward terms, null while rewards are off. */
  terms: { trigger: 'signup' | 'first_payment'; referrerAmount: number; refereeAmount: number; currency: string; holdDays: number } | null;
  /** status -> currency -> minor units. */
  totals: Record<string, Record<string, number>>;
  rewards: ReferralRewardRow[];
}

export interface ReferralRewardRow {
  id: string;
  role: 'referrer' | 'referee';
  trigger: string;
  amount: number;
  currency: string;
  status: 'pending' | 'granted' | 'voided';
  /** Epoch ms the hold ends. */
  releaseAt: number;
  grantedAt: number | null;
  createdAt: number;
}

interface WireSummary {
  enabled: boolean;
  referral_code: string | null;
  referral_link: string | null;
  terms: { trigger: 'signup' | 'first_payment'; referrer_amount: number; referee_amount: number; currency: string; hold_days: number } | null;
  totals: Record<string, Record<string, number>>;
  data: Array<{ id: string; role: 'referrer' | 'referee'; trigger: string; amount: number; currency: string; status: 'pending' | 'granted' | 'voided'; release_at: number; granted_at: number | null; created_at: number }>;
}

/** The signed-in user's referral earnings. Null when the call fails (signed out, offline). Needs a signed-in session. */
export async function getReferralRewards(client: FapiClient, opts: { limit?: number } = {}): Promise<ReferralRewardsSummary | null> {
  const res = await client.get<WireSummary>(`/v1/client/me/referral/rewards${opts.limit ? `?limit=${opts.limit}` : ''}`);
  if (!res.ok || !res.data) return null;
  const d = res.data;
  return {
    enabled: d.enabled,
    referralCode: d.referral_code,
    referralLink: d.referral_link,
    terms: d.terms ? { trigger: d.terms.trigger, referrerAmount: d.terms.referrer_amount, refereeAmount: d.terms.referee_amount, currency: d.terms.currency, holdDays: d.terms.hold_days } : null,
    totals: d.totals,
    rewards: d.data.map((r) => ({ id: r.id, role: r.role, trigger: r.trigger, amount: r.amount, currency: r.currency, status: r.status, releaseAt: r.release_at, grantedAt: r.granted_at, createdAt: r.created_at })),
  };
}

/** "Give 5.00 USD, get 5.00 USD": one line describing the terms, or null while rewards are off. */
export function describeReferralTerms(terms: ReferralRewardsSummary['terms'], locale?: string): string | null {
  if (!terms) return null;
  const give = terms.refereeAmount > 0 ? `Give ${formatMoney(terms.refereeAmount, terms.currency, locale)}` : null;
  const get = terms.referrerAmount > 0 ? `get ${formatMoney(terms.referrerAmount, terms.currency, locale)}` : null;
  if (give && get) return `${give}, ${get}`;
  return give ?? (get ? get.charAt(0).toUpperCase() + get.slice(1) : null);
}
