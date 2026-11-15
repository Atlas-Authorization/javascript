import type { ParityRequest } from './parity';

const q = (id: string, method: ParityRequest['method'], path: string, rest: Partial<ParityRequest> = {}): ParityRequest => ({ id, method, path, ...rest });

/**
 * Provider credentials, the provider webhook, store links, Connect payouts, the credit ledger and referral rewards: the refusals and
 * reads every instance answers alike. Nothing here needs a payment provider account or leaves a payout or a reward behind.
 */
export const emu4BillingParityRequests: ParityRequest[] = [
  q('b4 user', 'POST', '/v1/users', { body: { email_address: 'b4-{{rand}}@example.com' }, capture: { b4u: 'id' }, group: 'billing' }),
  // ── provider credentials ──
  q('b4 providers', 'GET', '/v1/billing/providers', { group: 'billing' }),
  q('b4 provider unknown', 'GET', '/v1/billing/providers/nope', { group: 'billing' }),
  q('b4 provider put refused', 'PUT', '/v1/billing/providers/stripe', { body: { config: { bogus: 'x' } }, group: 'billing' }),
  q('b4 provider test unconfigured', 'POST', '/v1/billing/providers/googleplay/test', { group: 'billing' }),
  q('b4 provider delete unconfigured', 'DELETE', '/v1/billing/providers/googleplay', { group: 'billing' }),
  // ── the per-instance provider webhook ──
  q('b4 webhook not configured', 'POST', '/v1/webhooks/billing/ins_unknown/paddle', { anonymous: true, body: {}, group: 'billing' }),
  // ── store links ──
  q('b4 store link unknown plan', 'POST', '/v1/billing/store_links', { body: { subject_type: 'user', subject_id: '{{b4u}}', plan_id: 'plan_unknown' }, group: 'billing' }),
  q('b4 store link invalid', 'POST', '/v1/billing/store_links', { body: { subject_type: 'team', subject_id: 'x', plan_id: 'x' }, group: 'billing' }),
  // ── Connect ──
  q('b4 connect account invalid', 'POST', '/v1/billing/connect/accounts', { body: { subject_type: 'team', subject_id: 'x', idempotency_key: 'k' }, group: 'billing' }),
  q('b4 connect accounts', 'GET', '/v1/billing/connect/accounts', { group: 'billing' }),
  q('b4 connect account unknown', 'GET', '/v1/billing/connect/accounts/bca_unknown', { group: 'billing' }),
  q('b4 connect refresh unknown', 'POST', '/v1/billing/connect/accounts/bca_unknown/refresh', { group: 'billing' }),
  q('b4 connect link unknown', 'POST', '/v1/billing/connect/accounts/bca_unknown/onboarding_link', { body: {}, group: 'billing' }),
  q('b4 connect transfer invalid', 'POST', '/v1/billing/connect/transfers', { body: {}, group: 'billing' }),
  q('b4 connect transfers', 'GET', '/v1/billing/connect/transfers', { group: 'billing' }),
  q('b4 connect transfer unknown', 'GET', '/v1/billing/connect/transfers/btr_unknown', { group: 'billing' }),
  // ── the credit ledger ──
  q('b4 credits', 'GET', '/v1/billing/credits?subject_type=user&subject_id={{b4u}}', { group: 'billing' }),
  q('b4 credits no subject', 'GET', '/v1/billing/credits', { group: 'billing' }),
  q('b4 credit invalid', 'POST', '/v1/billing/credits', { body: { subject_type: 'user', subject_id: '{{b4u}}', amount: 0, currency: 'usd' }, group: 'billing' }),
  // ── referral rewards ──
  q('b4 reward rules', 'GET', '/v1/referral_reward_rules', { tolerate: ['updated_at'], group: 'billing' }),
  q('b4 reward rules refused', 'PUT', '/v1/referral_reward_rules', { body: { trigger: 'nope' }, group: 'billing' }),
  q('b4 rewards', 'GET', '/v1/referral_rewards', { group: 'billing' }),
  q('b4 rewards bad status', 'GET', '/v1/referral_rewards?status=nope', { group: 'billing' }),
  q('b4 reward unknown', 'GET', '/v1/referral_rewards/rrw_unknown', { group: 'billing' }),
  q('b4 reward void unknown', 'POST', '/v1/referral_rewards/rrw_unknown/void', { body: {}, group: 'billing' }),
  q('b4 rewards run', 'POST', '/v1/referral_rewards/run', { body: {}, tolerate: ['created', 'granted', 'voided'], group: 'billing' }),
];
