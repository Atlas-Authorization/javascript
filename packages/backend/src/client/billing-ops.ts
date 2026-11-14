import { enc, type RequestFn } from './request';

type C_NotConfigured = {
  /** The object type the path returns when configured. */
  object: string;
  configured: false;
  /** Messaging providers only: email or sms. */
  channel?: string;
  /** What to call to configure it. */
  message?: string;
};

export interface BillingListProvidersQuery {
  /** Page size, 1-500. Without limit (and without starting_after) the whole list is returned. */
  limit?: number;
  /** Cursor: return only items after this one. Pass the previous page's `next_cursor` (the last item's id). An unknown cursor is a 400. */
  starting_after?: string;
}

export type BillingListProvidersResult = {
  object?: 'list';
  data?: ({
    object: 'billing_provider';
    configured?: true;
    provider: 'stripe' | 'polar' | 'dodo' | 'creem';
    environment: 'live' | 'test';
    status: string;
    /** Public settings only (e.g. publishable_key). */
    config?: {
      [key: string]: string;
    };
    /** Which secrets are stored (e.g. {"secret_key": true}); values are never returned. */
    secrets_set: {
      [key: string]: boolean;
    };
    /** Register this URL in the provider's dashboard. */
    webhook_url: string;
    capabilities?: Record<string, unknown> | null;
    last_verified_at?: number | null;
    last_webhook_at?: number | null;
    updated_at?: number;
  })[];
  /** Whether another page follows the cursor. */
  has_more?: boolean;
  /** The cursor to pass as `starting_after` for the next page on a keyset-paginated list; null on the last page (and absent on lists that are not cursor-paginated). */
  next_cursor?: string | null;
};

export type BillingGetProviderResult = {
  object: 'billing_provider';
  configured?: true;
  provider: 'stripe' | 'polar' | 'dodo' | 'creem';
  environment: 'live' | 'test';
  status: string;
  /** Public settings only (e.g. publishable_key). */
  config?: {
    [key: string]: string;
  };
  /** Which secrets are stored (e.g. {"secret_key": true}); values are never returned. */
  secrets_set: {
    [key: string]: boolean;
  };
  /** Register this URL in the provider's dashboard. */
  webhook_url: string;
  capabilities?: Record<string, unknown> | null;
  last_verified_at?: number | null;
  last_webhook_at?: number | null;
  updated_at?: number;
} | C_NotConfigured;

export type BillingSetProviderBody = {
  environment?: 'live' | 'test';
  /** Provider credentials and public settings. */
  config?: {
    [key: string]: string;
  };
};

export type BillingSetProviderResult = {
  object: 'billing_provider';
  configured?: true;
  provider: 'stripe' | 'polar' | 'dodo' | 'creem';
  environment: 'live' | 'test';
  status: string;
  /** Public settings only (e.g. publishable_key). */
  config?: {
    [key: string]: string;
  };
  /** Which secrets are stored (e.g. {"secret_key": true}); values are never returned. */
  secrets_set: {
    [key: string]: boolean;
  };
  /** Register this URL in the provider's dashboard. */
  webhook_url: string;
  capabilities?: Record<string, unknown> | null;
  last_verified_at?: number | null;
  last_webhook_at?: number | null;
  updated_at?: number;
};

export interface BillingDeleteProviderQuery {
  /** Remove even though live subscriptions or plans use this provider. */
  force?: 'true' | 'false';
}

export type BillingDeleteProviderResult = {
  object: 'billing_provider';
  provider: string;
  deleted: true;
};

export type BillingTestProviderResult = {
  object: 'billing_provider_test';
  provider: string;
  ok: boolean;
  error?: string | null;
  /** The provider account the credentials belong to, when it says. */
  account?: string | null;
};

export interface BillingListCouponsQuery {
  /** Page size, 1-500. Without limit (and without starting_after) the whole list is returned. */
  limit?: number;
  /** Cursor: return only items after this one. Pass the previous page's `next_cursor` (the last item's id). An unknown cursor is a 400. */
  starting_after?: string;
}

export type BillingListCouponsResult = {
  object: 'list';
  data: ({
    object: 'billing_coupon';
    id: string;
    code: string;
    name?: string | null;
    percent_off?: number | null;
    /** Minor units. */
    amount_off?: number | null;
    currency?: string | null;
    duration?: 'once' | 'repeating' | 'forever';
    duration_months?: number | null;
    max_redemptions?: number | null;
    redeemed_count?: number;
    /** Epoch milliseconds. */
    expires_at?: number | null;
    plan_ids?: string[] | null;
    first_time_only?: boolean;
    active?: boolean;
    providers?: string[];
    created_at?: number;
    updated_at?: number;
  })[];
  has_more: boolean;
};

export type BillingCreateCouponBody = {
  code?: string;
  name?: string;
  percent_off?: number;
  amount_off?: number;
  currency?: string;
  duration?: 'once' | 'repeating' | 'forever';
  duration_months?: number;
  max_redemptions?: number;
  expires_at?: number;
  plan_ids?: string[];
  first_time_only?: boolean;
  provider?: string;
};

export type BillingCreateCouponResult = {
  object: 'billing_coupon';
  id: string;
  code: string;
  name?: string | null;
  percent_off?: number | null;
  /** Minor units. */
  amount_off?: number | null;
  currency?: string | null;
  duration?: 'once' | 'repeating' | 'forever';
  duration_months?: number | null;
  max_redemptions?: number | null;
  redeemed_count?: number;
  /** Epoch milliseconds. */
  expires_at?: number | null;
  plan_ids?: string[] | null;
  first_time_only?: boolean;
  active?: boolean;
  providers?: string[];
  created_at?: number;
  updated_at?: number;
};

export type BillingGetCouponResult = {
  object: 'billing_coupon';
  id: string;
  code: string;
  name?: string | null;
  percent_off?: number | null;
  /** Minor units. */
  amount_off?: number | null;
  currency?: string | null;
  duration?: 'once' | 'repeating' | 'forever';
  duration_months?: number | null;
  max_redemptions?: number | null;
  redeemed_count?: number;
  /** Epoch milliseconds. */
  expires_at?: number | null;
  plan_ids?: string[] | null;
  first_time_only?: boolean;
  active?: boolean;
  providers?: string[];
  created_at?: number;
  updated_at?: number;
};

export type BillingUpdateCouponBody = {
  active?: boolean;
  name?: string;
  max_redemptions?: number | null;
  /** Epoch milliseconds in the future; null removes the expiry. */
  expires_at?: number | null;
  /** Plan ids the code works on; null means every plan. */
  plan_ids?: string[] | null;
  first_time_only?: boolean;
};

export type BillingUpdateCouponResult = {
  object: 'billing_coupon';
  id: string;
  code: string;
  name?: string | null;
  percent_off?: number | null;
  /** Minor units. */
  amount_off?: number | null;
  currency?: string | null;
  duration?: 'once' | 'repeating' | 'forever';
  duration_months?: number | null;
  max_redemptions?: number | null;
  redeemed_count?: number;
  /** Epoch milliseconds. */
  expires_at?: number | null;
  plan_ids?: string[] | null;
  first_time_only?: boolean;
  active?: boolean;
  providers?: string[];
  created_at?: number;
  updated_at?: number;
};

export type BillingDeleteCouponResult = {
  object: 'billing_coupon';
  id: string;
  deleted: boolean;
};

export type BillingValidateCouponBody = {
  code?: string;
  plan_id?: string;
  subject_type?: 'user' | 'org';
  subject_id?: string;
};

export type BillingValidateCouponResult = Record<string, unknown>;

export interface BillingListCreditsQuery {
  /** Whose ledger: a user or an organization. */
  subject_type?: 'user' | 'org';
  /** The user or organization id. */
  subject_id?: string;
  /** Page size, 1-500. Without limit (and without starting_after) the whole list is returned. */
  limit?: number;
  /** Cursor: return only items after this one. Pass the previous page's `next_cursor` (the last item's id). An unknown cursor is a 400. */
  starting_after?: string;
}

export type BillingListCreditsResult = {
  object: 'billing_credit_ledger';
  subject_type?: string;
  subject_id?: string;
  balance: {
    [key: string]: number;
  };
  data: ({
    object: 'billing_credit';
    id: string;
    subject_type?: string;
    subject_id?: string;
    /** Signed minor units. */
    amount: number;
    currency: string;
    reason?: string | null;
    kind?: string;
    source_ref?: string | null;
    /** The credit has reached the customer balance on the provider. */
    applied?: boolean;
    provider?: string | null;
    created_at?: number;
  })[];
};

export type BillingCreateCreditBody = {
  subject_type?: 'user' | 'org';
  subject_id?: string;
  amount?: number;
  currency?: string;
  reason?: string;
  idempotency_key?: string;
};

export type BillingCreateCreditResult = {
  object: 'billing_credit';
  id: string;
  subject_type?: string;
  subject_id?: string;
  /** Signed minor units. */
  amount: number;
  currency: string;
  reason?: string | null;
  kind?: string;
  source_ref?: string | null;
  /** The credit has reached the customer balance on the provider. */
  applied?: boolean;
  provider?: string | null;
  created_at?: number;
};

/** Operations on `/v1/billing` (13). */
export function billingOpsResource(request: RequestFn) {
  return {
    /** The billing providers this instance has credentials for (stripe, polar, dodo, creem, chargebee, autumn, commet). End-user billing runs on the instance's OWN provider account; secrets are reported as *_set markers only, never returned. Each entry carries the webhook URL to register with the provider. */
    listProviders(query?: BillingListProvidersQuery): Promise<BillingListProvidersResult> {
      return request({ method: 'GET', path: '/v1/billing/providers', query: { ...query } });
    },
    /** One billing provider's settings: environment, which credentials are set, public fields (e.g. Stripe publishable key), status and the webhook URL to register. When the provider has no credentials: 200 `{ object: "billing_provider", provider, configured: false }` (not a 404). */
    getProvider(provider: string): Promise<BillingGetProviderResult> {
      return request({ method: 'GET', path: `/v1/billing/providers/${enc(provider)}` });
    },
    /** Set the instance's own credentials for a billing provider (merged onto what is stored; secrets are write-only and encrypted at rest). Stripe: secret_key (sk_/rk_), webhook_secret (whsec_), publishable_key. Polar: access_token, webhook_secret. Dodo Payments and Creem: api_key, webhook_secret. Chargebee: api_key, site (the site name), webhook_username + webhook_password (the Basic credentials set on the Chargebee webhook). Autumn: secret_key (am_sk_), webhook_secret (whsec_). Commet: api_key, webhook_secret, optional seat_feature_code. Stripe's environment follows the key's mode. */
    setProvider(provider: string, body: BillingSetProviderBody): Promise<BillingSetProviderResult> {
      return request({ method: 'PUT', path: `/v1/billing/providers/${enc(provider)}`, body });
    },
    /** Remove a provider's credentials. Refused while live subscriptions or plans depend on it, unless `force=true`. */
    deleteProvider(provider: string, query?: BillingDeleteProviderQuery): Promise<BillingDeleteProviderResult> {
      return request({ method: 'DELETE', path: `/v1/billing/providers/${enc(provider)}`, query: { ...query } });
    },
    /** Make one read-only call to the provider with the stored credentials and report whether they work. */
    testProvider(provider: string): Promise<BillingTestProviderResult> {
      return request({ method: 'POST', path: `/v1/billing/providers/${enc(provider)}/test` });
    },
    /** List the discount codes you offer. */
    listCoupons(query?: BillingListCouponsQuery): Promise<BillingListCouponsResult> {
      return request({ method: 'GET', path: '/v1/billing/coupons', query: { ...query } });
    },
    /** Create a discount code. Set exactly one of `percent_off` or `amount_off` (+ `currency`). It is created on your own Stripe account as a coupon and promotion code, so Stripe enforces and applies it; a provider without discount support refuses with 422. */
    createCoupon(body?: BillingCreateCouponBody, idempotencyKey?: string): Promise<BillingCreateCouponResult> {
      return request({ method: 'POST', path: '/v1/billing/coupons', body, idempotencyKey });
    },
    /** Read one discount code. */
    getCoupon(id: string): Promise<BillingGetCouponResult> {
      return request({ method: 'GET', path: `/v1/billing/coupons/${enc(id)}` });
    },
    /** Deactivate or reactivate a code, rename it, or change its redemption cap. The discount itself cannot change; create a new code for that. */
    updateCoupon(id: string, body?: BillingUpdateCouponBody): Promise<BillingUpdateCouponResult> {
      return request({ method: 'PATCH', path: `/v1/billing/coupons/${enc(id)}`, body });
    },
    /** Delete a code and stop it being used. Subscriptions that already have the discount keep it. */
    deleteCoupon(id: string): Promise<BillingDeleteCouponResult> {
      return request({ method: 'DELETE', path: `/v1/billing/coupons/${enc(id)}` });
    },
    /** Would this code work for this subject and plan? `reason`: unknown, inactive, expired, exhausted, plan_not_eligible, first_time_only or already_used. */
    validateCoupon(body?: BillingValidateCouponBody, idempotencyKey?: string): Promise<BillingValidateCouponResult> {
      return request({ method: 'POST', path: '/v1/billing/coupons/validate', body, idempotencyKey });
    },
    /** A subject's account-credit ledger and its balance per currency. */
    listCredits(query?: BillingListCreditsQuery): Promise<BillingListCreditsResult> {
      return request({ method: 'GET', path: '/v1/billing/credits', query: { ...query } });
    },
    /** Post account credit (or a negative adjustment) to a subject. Idempotent on `idempotency_key`. Once the subject has a customer on the provider the credit lands on their balance and is applied to their next invoices; before that it waits for their first completed checkout. */
    createCredit(body?: BillingCreateCreditBody, idempotencyKey?: string): Promise<BillingCreateCreditResult> {
      return request({ method: 'POST', path: '/v1/billing/credits', body, idempotencyKey });
    },
  };
}
