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
  audience: string;
  active: boolean;
  created_at: number;
  updated_at: number;
}

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
  created_at: number;
  updated_at: number;
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
}

/** Filter the subscription read view to one subject. */
export interface ListSubscriptionsParams {
  /** One of `user`, `org`. */
  subject_type?: string;
  subject_id?: string;
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
  };
}
