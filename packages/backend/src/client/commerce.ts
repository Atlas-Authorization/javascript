import { enc, type RequestFn } from './request';

export type CommerceSubjectType = 'user' | 'org';

/** The token an app hands the app store at purchase so the signed store notification is filed under the right subject and plan. */
export interface BillingStoreLink {
  object: 'billing_store_link';
  id: string;
  /** A UUID: StoreKit `appAccountToken` / Play Billing `obfuscatedExternalAccountId`. */
  token: string;
  subject_type: CommerceSubjectType;
  subject_id: string;
  plan_id: string;
  provider: 'appstore' | 'googleplay';
  created_at: number;
}

export interface CreateBillingStoreLinkBody {
  subject_type: CommerceSubjectType;
  subject_id: string;
  /** An active plan sold through `appstore` or `googleplay` for this kind of subject. */
  plan_id: string;
}

/** A Stripe Connect (Express) account a subject is paid out to, on your own Stripe account. */
export interface BillingConnectAccount {
  object: 'billing_connect_account';
  id: string;
  subject_type: CommerceSubjectType;
  subject_id: string;
  provider_account_id: string;
  country: string | null;
  details_submitted: boolean;
  charges_enabled: boolean;
  payouts_enabled: boolean;
  requirements_due: string[];
  refreshed_at: number | null;
  created_at: number;
}

export interface CreateBillingConnectAccountBody {
  subject_type: CommerceSubjectType;
  subject_id: string;
  email?: string;
  /** Two-letter ISO country, upper case. It cannot be changed later. */
  country?: string;
  idempotency_key: string;
}

export interface BillingConnectLinkBody {
  return_url: string;
  refresh_url: string;
  type?: 'onboarding' | 'update';
}

export interface BillingConnectLink {
  object: 'billing_connect_link';
  account_id: string;
  url: string;
  expires_at: number | null;
}

export interface BillingTransfer {
  object: 'billing_transfer';
  id: string;
  account_id: string;
  subject_type: CommerceSubjectType;
  subject_id: string;
  /** Minor units. */
  amount: number;
  currency: string;
  description: string | null;
  status: 'pending' | 'paid' | 'failed' | 'reversed';
  provider_transfer_id: string | null;
  failure: string | null;
  source_ref: string | null;
  created_at: number;
}

export interface CreateBillingTransferBody {
  /** The Atlas connected account id. */
  account_id: string;
  amount: number;
  currency: string;
  description?: string;
  source_ref?: string;
  /** Required. A retry with the same key returns the first transfer and never pays twice. */
  idempotency_key: string;
}

export interface CommercePage<T> {
  object: 'list';
  data: T[];
  has_more: boolean;
  next_cursor: string | null;
}

export interface ReferralRewardRules {
  object: 'referral_reward_rules';
  enabled: boolean;
  trigger: 'signup' | 'first_payment';
  referrer_amount: number;
  referee_amount: number;
  currency: string;
  hold_days: number;
  max_rewards_per_referrer: number | null;
  updated_at: number | null;
}

export type SetReferralRewardRulesBody = Partial<Omit<ReferralRewardRules, 'object' | 'updated_at'>>;

export interface ReferralReward {
  object: 'referral_reward';
  id: string;
  role: 'referrer' | 'referee';
  referrer_user_id: string;
  referee_user_id: string;
  recipient_user_id: string;
  trigger: 'signup' | 'first_payment';
  amount: number;
  currency: string;
  status: 'pending' | 'granted' | 'voided';
  release_at: number;
  credit_id: string | null;
  granted_at: number | null;
  voided_at: number | null;
  void_reason: string | null;
  created_at: number;
}

export interface ListReferralRewardsParams {
  status?: ReferralReward['status'];
  recipient_user_id?: string;
  referrer_user_id?: string;
  limit?: number;
  starting_after?: string;
}

export function commerceBillingResource(request: RequestFn) {
  return {
    /** Mint (or read back) the app-store link token for a subject and an app-store plan. The same pair always gets the same token. */
    createStoreLink(body: CreateBillingStoreLinkBody): Promise<BillingStoreLink> {
      return request({ method: 'POST', path: '/v1/billing/store_links', body });
    },
    /** Re-read one Stripe subscription now and apply what Stripe reports (no webhook needed). */
    syncSubscription(id: string): Promise<Record<string, unknown>> {
      return request({ method: 'POST', path: `/v1/billing/subscriptions/${enc(id)}/sync` });
    },
    /** Record a purchase from its Stripe Checkout Session id (the return URL carries it), no webhook needed. `status` is `synced` or `pending`. */
    syncCheckoutSession(sessionId: string): Promise<{ object: 'billing_checkout_sync'; status: 'synced' | 'pending'; subscription: Record<string, unknown> | null }> {
      return request({ method: 'POST', path: '/v1/billing/checkout/sync', body: { session_id: sessionId } });
    },
    /** Forward a Stripe event from your own endpoint: pass the event or its id; Atlas re-fetches it from Stripe and processes that. */
    forwardStripeEvent(event: string | { id: string }): Promise<{ object: 'billing_stripe_event'; id: string; type: string | null; outcome: 'processed' | 'ignored' }> {
      return request({ method: 'POST', path: '/v1/billing/stripe/events', body: { id: typeof event === 'string' ? event : event.id } });
    },
  };
}

export function billingConnectResource(request: RequestFn) {
  return {
    /** Create the Connect account a subject is paid out to. One per subject; a second call returns it. */
    createAccount(body: CreateBillingConnectAccountBody): Promise<BillingConnectAccount> {
      return request({ method: 'POST', path: '/v1/billing/connect/accounts', body, idempotencyKey: body.idempotency_key });
    },
    listAccounts(params: { limit?: number; starting_after?: string } = {}): Promise<CommercePage<BillingConnectAccount>> {
      return request({ method: 'GET', path: '/v1/billing/connect/accounts', query: { ...params } });
    },
    getAccount(id: string): Promise<BillingConnectAccount> {
      return request({ method: 'GET', path: `/v1/billing/connect/accounts/${enc(id)}` });
    },
    /** Re-read the account's onboarding and payout readiness from Stripe. */
    refreshAccount(id: string): Promise<BillingConnectAccount> {
      return request({ method: 'POST', path: `/v1/billing/connect/accounts/${enc(id)}/refresh` });
    },
    /** A one-time Stripe-hosted onboarding (or update) link for the account holder. */
    createOnboardingLink(id: string, body: BillingConnectLinkBody): Promise<BillingConnectLink> {
      return request({ method: 'POST', path: `/v1/billing/connect/accounts/${enc(id)}/onboarding_link`, body });
    },
    /** Pay a connected account from your Stripe balance. Idempotent on `idempotency_key`. */
    createTransfer(body: CreateBillingTransferBody): Promise<BillingTransfer> {
      return request({ method: 'POST', path: '/v1/billing/connect/transfers', body, idempotencyKey: body.idempotency_key });
    },
    listTransfers(params: { account_id?: string; limit?: number } = {}): Promise<CommercePage<BillingTransfer>> {
      return request({ method: 'GET', path: '/v1/billing/connect/transfers', query: { ...params } });
    },
    getTransfer(id: string): Promise<BillingTransfer> {
      return request({ method: 'GET', path: `/v1/billing/connect/transfers/${enc(id)}` });
    },
  };
}

export function referralRewardsResource(request: RequestFn) {
  return {
    getRules(): Promise<ReferralRewardRules> {
      return request({ method: 'GET', path: '/v1/referral_reward_rules' });
    },
    /** Replace the terms (a field left out returns to its default). */
    setRules(body: SetReferralRewardRulesBody): Promise<ReferralRewardRules> {
      return request({ method: 'PUT', path: '/v1/referral_reward_rules', body });
    },
    list(params: ListReferralRewardsParams = {}): Promise<CommercePage<ReferralReward>> {
      return request({ method: 'GET', path: '/v1/referral_rewards', query: { ...params } });
    },
    get(id: string): Promise<ReferralReward> {
      return request({ method: 'GET', path: `/v1/referral_rewards/${enc(id)}` });
    },
    /** Void a pending reward. A granted reward is already a credit: post a negative credit instead. */
    void(id: string, body: { reason?: string } = {}): Promise<ReferralReward> {
      return request({ method: 'POST', path: `/v1/referral_rewards/${enc(id)}/void`, body });
    },
    /** Discover qualifying referrals and grant what is due now, instead of waiting for the sweep. */
    run(): Promise<{ object: 'referral_reward_run'; created: number; granted: number; voided: number }> {
      return request({ method: 'POST', path: '/v1/referral_rewards/run' });
    },
  };
}
