import { enc, type RequestFn } from './request';
import type { ListPage } from './types';

/**
 * A plan a tenant defines for their app's users. `stripe_price_id` is the
 * recurring price a subscriber is charged; `features` are the keys the plan
 * grants, surfaced to the end user as the `fea` session claim.
 */
export interface BillingPlan {
  object: 'billing_plan';
  id: string;
  name: string;
  slug: string;
  stripe_price_id: string;
  interval: string;
  amount: string | null;
  currency: string;
  features: string[];
  /** Numeric limits the plan grants (the `ent.limits` claim); `-1` = unlimited. */
  limits?: Record<string, unknown>;
  audience: string;
  active: boolean;
  /** stripe | polar | dodo | creem | chargebee | autumn | commet */
  provider?: BillingProviderName;
  /** The plan's price reference on its provider. */
  provider_price_id?: string | null;
  /** `base`: the subject's main plan. `addon`: bought alongside it; several may be live. */
  kind?: 'base' | 'addon';
  /** Autumn plans: the feature whose usage tracks the org's member count. */
  seat_feature_id?: string | null;
  created_at: number;
  updated_at: number;
}

export type BillingProviderName = 'stripe' | 'polar' | 'dodo' | 'creem' | 'chargebee' | 'autumn' | 'commet';

/**
 * A read view of who is subscribed. `status` is written ONLY by the verified
 * Stripe webhook, never through this SDK.
 */
export interface BillingSubscription {
  object: 'billing_subscription';
  id: string;
  subject_type: string;
  subject_id: string;
  plan_id: string;
  status: string;
  stripe_subscription_id: string | null;
  stripe_customer_id: string | null;
  current_period_end: number | null;
  provider?: BillingProviderName;
  provider_subscription_id?: string | null;
  provider_customer_id?: string | null;
  quantity?: number;
  cancel_at_period_end?: boolean;
  /** What an entitlement provider (Autumn, Commet) reports this subscription grants. */
  entitlements?: { features: string[]; limits: Record<string, number> } | null;
  created_at: number;
  updated_at: number;
}

/** How numeric limits merge when a subject holds several entitling subscriptions. */
export interface BillingSettings {
  object: 'billing_settings';
  default_limit_merge: 'max' | 'sum';
  limit_merge: Record<string, 'max' | 'sum'>;
}

export interface UpdateBillingSettingsBody {
  default_limit_merge?: 'max' | 'sum';
  /** Limit key → `max` | `sum`; replaces the stored map. */
  limit_merge?: Record<string, 'max' | 'sum'>;
}

/** May a subject use a feature? */
export interface CheckBillingFeatureBody {
  subject_type: 'user' | 'org';
  subject_id: string;
  feature: string;
  /** Units about to be used (default 1). */
  required?: number;
}

export interface BillingFeatureCheck {
  object: 'billing_feature_check';
  feature: string;
  allowed: boolean;
  /** `provider`: asked live of Autumn/Commet; `atlas`: from the resolved entitlement. */
  source: 'provider' | 'atlas';
  provider: string | null;
  remaining: number | null;
  granted: number | null;
  usage: number | null;
  unlimited: boolean;
}

export interface ChangeBillingSubscriptionBody {
  plan_id: string;
  interval?: 'month' | 'year';
  schedule_at_period_end?: boolean;
}

export interface CreateBillingPlanBody {
  name: string;
  slug: string;
  stripe_price_id: string;
  /** One of `month`, `year`. Defaults to `month`. */
  interval?: string;
  amount?: string;
  currency?: string;
  features?: string[];
  /** One of `user`, `org`. Defaults to `user`. */
  audience?: string;
  active?: boolean;
  limits?: Record<string, unknown>;
  provider?: BillingProviderName;
  provider_price_id?: string;
  /** `base` (default) or `addon`. */
  kind?: 'base' | 'addon';
  /** Autumn: one of the plan's features; its usage follows the org's member count. */
  seat_feature_id?: string | null;
}

export interface UpdateBillingPlanBody {
  name?: string;
  slug?: string;
  stripe_price_id?: string;
  interval?: string;
  amount?: string;
  currency?: string;
  features?: string[];
  audience?: string;
  active?: boolean;
  limits?: Record<string, unknown>;
  provider?: BillingProviderName;
  provider_price_id?: string;
  kind?: 'base' | 'addon';
  /** `null` clears it. */
  seat_feature_id?: string | null;
}

/** Filter the subscription read view to one subject. */
export interface ListSubscriptionsParams {
  /** One of `user`, `org`. */
  subject_type?: string;
  subject_id?: string;
}

/** Adopt an existing Stripe subscription (same Stripe account) onto an Atlas subject. */
export interface ImportBillingSubscriptionBody {
  subject_type: 'user' | 'org';
  subject_id: string;
  stripe_subscription_id: string;
  stripe_customer_id?: string;
  /** Resolved from the subscription's price when omitted. */
  plan_id?: string;
}

/** Report metered usage for a subject. Idempotent on `idempotency_key`. */
export interface ReportBillingUsageBody {
  subject_type: 'user' | 'org';
  subject_id: string;
  /** Non-negative. */
  quantity: number;
  idempotency_key: string;
  /** Count against this provider feature (an Autumn feature id / Commet feature code). */
  feature?: string;
  /** Attribute to this subscription when the subject holds several. */
  subscription_id?: string;
}

export interface BillingUsageReport {
  object: 'billing_usage';
  /** False when this `idempotency_key` was already recorded. */
  recorded: boolean;
  /** Whether it was mirrored to a Stripe meter (the plan is metered and configured). */
  metered: boolean;
  total: number;
}

export interface BillingSeatSync {
  object: 'billing_seats';
  subject_type: string;
  subject_id: string;
  quantity: number;
}

export function billingResource(request: RequestFn) {
  return {
    listPlans(): Promise<ListPage<BillingPlan>> {
      return request({ method: 'GET', path: '/v1/billing/plans' });
    },
    createPlan(body: CreateBillingPlanBody, idempotencyKey?: string): Promise<BillingPlan> {
      return request({ method: 'POST', path: '/v1/billing/plans', body, idempotencyKey });
    },
    getPlan(id: string): Promise<BillingPlan> {
      return request({ method: 'GET', path: `/v1/billing/plans/${enc(id)}` });
    },
    updatePlan(id: string, body: UpdateBillingPlanBody): Promise<BillingPlan> {
      return request({ method: 'PATCH', path: `/v1/billing/plans/${enc(id)}`, body });
    },
    deletePlan(id: string): Promise<{ object: 'billing_plan'; id: string; deleted: true }> {
      return request({ method: 'DELETE', path: `/v1/billing/plans/${enc(id)}` });
    },
    listSubscriptions(params?: ListSubscriptionsParams): Promise<ListPage<BillingSubscription>> {
      return request({ method: 'GET', path: '/v1/billing/subscriptions', query: { ...params } });
    },
    /** One subscription by id (a subject may hold several: a base plan + add-ons). */
    getSubscription(id: string): Promise<BillingSubscription> {
      return request({ method: 'GET', path: `/v1/billing/subscriptions/${enc(id)}` });
    },
    /** Move one subscription to another plan or interval (now, or at the period end). */
    changeSubscription(id: string, body: ChangeBillingSubscriptionBody): Promise<BillingSubscription & { scheduled: boolean }> {
      return request({ method: 'POST', path: `/v1/billing/subscriptions/${enc(id)}/change`, body });
    },
    /** Cancel one subscription at the period end (default) or now. */
    cancelSubscription(id: string, body: { immediately?: boolean } = {}): Promise<BillingSubscription> {
      return request({ method: 'POST', path: `/v1/billing/subscriptions/${enc(id)}/cancel`, body });
    },
    /** Undo a cancellation scheduled for the period end. */
    restoreSubscription(id: string): Promise<BillingSubscription> {
      return request({ method: 'POST', path: `/v1/billing/subscriptions/${enc(id)}/restore` });
    },
    /** Mirror a plan's features/limits from its provider (Autumn, Commet). */
    syncPlanEntitlements(id: string): Promise<BillingPlan> {
      return request({ method: 'POST', path: `/v1/billing/plans/${enc(id)}/sync_entitlements` });
    },
    /** How limits merge across a subject's several subscriptions. */
    getSettings(): Promise<BillingSettings> {
      return request({ method: 'GET', path: '/v1/billing/settings' });
    },
    updateSettings(body: UpdateBillingSettingsBody): Promise<BillingSettings> {
      return request({ method: 'PUT', path: '/v1/billing/settings', body });
    },
    /** May a subject use a feature? Live from Autumn/Commet when the subject is on one. */
    checkFeature(body: CheckBillingFeatureBody): Promise<BillingFeatureCheck> {
      return request({ method: 'POST', path: '/v1/billing/check', body });
    },
    /**
     * Adopt an EXISTING Stripe subscription onto a user/org + plan, for
     * migrating billing into Atlas without re-charging. Read-only on Stripe.
     */
    importSubscription(
      body: ImportBillingSubscriptionBody,
      idempotencyKey?: string,
    ): Promise<BillingSubscription> {
      return request({
        method: 'POST',
        path: '/v1/billing/subscriptions/import',
        body,
        idempotencyKey,
      });
    },
    /** Report metered usage (mirrored to a Stripe meter event when the plan is metered). */
    reportUsage(body: ReportBillingUsageBody): Promise<BillingUsageReport> {
      return request({ method: 'POST', path: '/v1/billing/usage', body });
    },
    /**
     * Sync a per-seat subscription's Stripe quantity to the org's current member
     * count (prorated). Never changes the paid status.
     */
    syncSeats(subjectType: 'user' | 'org', subjectId: string): Promise<BillingSeatSync> {
      return request({
        method: 'POST',
        path: `/v1/billing/subjects/${enc(subjectType)}/${enc(subjectId)}/sync_seats`,
      });
    },
  };
}
