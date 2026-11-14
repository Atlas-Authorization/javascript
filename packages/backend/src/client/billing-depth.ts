import { enc, type RequestFn } from './request';

/** An invoice recorded for a plan you sell. Amounts are minor units. */
export interface BillingInvoice {
  object: 'billing_invoice';
  id: string;
  subject_type: 'user' | 'org';
  subject_id: string;
  provider: string;
  number: string | null;
  status: 'draft' | 'open' | 'paid' | 'uncollectible' | 'void';
  amount_due: number;
  amount_paid: number;
  /** Refunded so far through the API; never more than `amount_paid`. */
  amount_refunded: number;
  currency: string;
  hosted_invoice_url: string | null;
  invoice_pdf: string | null;
  period_start: number | null;
  period_end: number | null;
  created_at: number;
}

export interface BillingInvoiceWithRefunds extends BillingInvoice {
  refunds: BillingRefund[];
}

export interface ListBillingInvoicesParams {
  subject_type?: 'user' | 'org';
  /** Needs `subject_type`. */
  subject_id?: string;
  status?: BillingInvoice['status'];
  /** 1 to 500, default 100. */
  limit?: number;
  /** The previous page's `next_cursor`. */
  starting_after?: string;
}

export interface BillingInvoicePage {
  object: 'list';
  data: BillingInvoice[];
  has_more: boolean;
  next_cursor: string | null;
}

export interface BillingRefund {
  object: 'billing_refund';
  id: string;
  invoice_id: string;
  subject_type: 'user' | 'org';
  subject_id: string;
  provider: string;
  provider_refund_id: string | null;
  amount: number;
  currency: string;
  reason: 'duplicate' | 'fraudulent' | 'requested_by_customer' | null;
  /** The provider's status: pending, succeeded, failed, canceled or requires_action. */
  status: string;
  created_at: number;
}

export interface RefundBillingInvoiceBody {
  /** Minor units; omit to refund what is left. */
  amount?: number;
  reason?: 'duplicate' | 'fraudulent' | 'requested_by_customer';
  /** Required. A retry with the same key returns the first refund. */
  idempotency_key: string;
}

export interface ExtendBillingTrialBody {
  /** Days added to the current trial end. Send exactly one of `days` and `trial_end`. */
  days?: number;
  /** The new trial end: epoch milliseconds or an ISO date. */
  trial_end?: number | string;
  reason?: string;
  /** Required. A retry with the same key returns the first extension. */
  idempotency_key: string;
}

export interface BillingTrialExtension {
  object: 'billing_trial_extension';
  id: string;
  subscription_id: string;
  subject_type: 'user' | 'org';
  subject_id: string;
  previous_trial_end: number | null;
  trial_end: number;
  status: string;
  extended_days_total: number;
  reason: string | null;
  created_at: number;
}

export interface BillingUsageEventInput {
  subject_type: 'user' | 'org';
  subject_id: string;
  /** Non-negative. */
  quantity: number;
  idempotency_key: string;
  feature?: string;
  subscription_id?: string;
}

export interface BillingUsageBatchResult {
  object: 'billing_usage_batch';
  recorded: number;
  duplicates: number;
  failed: number;
  results: Array<{
    index: number;
    idempotency_key?: string | null;
    status: 'recorded' | 'duplicate' | 'failed';
    recorded?: boolean;
    metered?: boolean;
    total?: number;
    error?: { code: string; message: string; param?: string };
  }>;
}

export interface GetBillingUsageParams {
  subject_type: 'user' | 'org';
  subject_id: string;
  feature?: string;
  /** Epoch milliseconds or an ISO date. */
  since?: string | number;
  until?: string | number;
  /** `current`: from the start of the subject's current billing period. Not with `since`. */
  period?: 'current';
  /** true also returns the individual events. */
  events?: boolean;
  limit?: number;
  starting_after?: string;
}

export interface BillingUsageSummary {
  object: 'billing_usage_summary';
  subject_type: 'user' | 'org';
  subject_id: string;
  since: number | null;
  until: number | null;
  total: number;
  by_feature: Array<{ feature: string | null; total: number; events: number }>;
  events?: {
    object: 'list';
    data: Array<{
      object: 'billing_usage_event';
      id: string;
      feature: string | null;
      /** Negative for a refund of a consume. */
      quantity: number;
      source: 'report' | 'batch' | 'consume' | 'refund';
      idempotency_key: string;
      subscription_id: string | null;
      ref_key: string | null;
      reported_at: number;
    }>;
    has_more: boolean;
    next_cursor: string | null;
  };
}

export function billingDepthResource(request: RequestFn) {
  return {
    /** Invoices recorded from your payment provider's webhooks, newest first. */
    listInvoices(params: ListBillingInvoicesParams = {}): Promise<BillingInvoicePage> {
      return request({ method: 'GET', path: '/v1/billing/invoices', query: { ...params } });
    },
    getInvoice(id: string): Promise<BillingInvoiceWithRefunds> {
      return request({ method: 'GET', path: `/v1/billing/invoices/${enc(id)}` });
    },
    /** Refund all or part of a paid invoice on the provider that issued it. Returns money only; the subscription is untouched. */
    refundInvoice(id: string, body: RefundBillingInvoiceBody): Promise<BillingRefund> {
      return request({ method: 'POST', path: `/v1/billing/invoices/${enc(id)}/refund`, body, idempotencyKey: body.idempotency_key });
    },
    /** Move a trialing subscription's trial end later (at most 365 days in total). */
    extendTrial(subscriptionId: string, body: ExtendBillingTrialBody): Promise<BillingTrialExtension> {
      return request({ method: 'POST', path: `/v1/billing/subscriptions/${enc(subscriptionId)}/extend_trial`, body, idempotencyKey: body.idempotency_key });
    },
    /** Up to 100 usage events in one call; each is its own idempotent report and the batch is not all-or-nothing. */
    reportUsageBatch(events: BillingUsageEventInput[], idempotencyKey?: string): Promise<BillingUsageBatchResult> {
      return request({ method: 'POST', path: '/v1/billing/usage/batch', body: { events }, idempotencyKey });
    },
    /** Totals per feature (and with `events: true` the events) Atlas recorded for a subject. */
    getUsage(params: GetBillingUsageParams): Promise<BillingUsageSummary> {
      const { events, ...rest } = params;
      return request({ method: 'GET', path: '/v1/billing/usage', query: { ...rest, ...(events ? { events: 'true' } : {}) } });
    },
  };
}

export interface ConsumeEntitlementBody {
  subject_type: 'user' | 'org';
  subject_id: string;
  feature: string;
  /** Whole units, default 1. */
  amount?: number;
  /** Required. A retry with the same key replays the answer and never spends twice. */
  idempotency_key: string;
}

export interface EntitlementConsumption {
  object: 'entitlement_consumption';
  allowed: boolean;
  reason: 'not_entitled' | 'limit_reached' | null;
  feature: string;
  amount: number;
  /** `provider`: the subject's billing provider owns the balance; `atlas`: Atlas counts against the plan limit. */
  source: 'atlas' | 'provider';
  provider: string | null;
  used: number | null;
  limit: number | null;
  remaining: number | null;
  unlimited: boolean;
  replayed: boolean;
  window_start: number | null;
}

export interface RefundEntitlementConsumeBody {
  subject_type: 'user' | 'org';
  subject_id: string;
  feature: string;
  consume_idempotency_key: string;
  /** Omit to give back what is still outstanding. */
  amount?: number;
  idempotency_key: string;
}

export interface EntitlementConsumeRefund {
  object: 'entitlement_consume_refund';
  refunded: number;
  feature: string;
  used: number;
  replayed: boolean;
}

export function entitlementConsumeResource(request: RequestFn) {
  return {
    /** Spend units of a plan feature, atomically and once per key. The answer is the decision, allowed or not. */
    consume(body: ConsumeEntitlementBody): Promise<EntitlementConsumption> {
      return request({ method: 'POST', path: '/v1/entitlements/consume', body });
    },
    /** Give back all or part of an earlier Atlas-counted consume. */
    refundConsume(body: RefundEntitlementConsumeBody): Promise<EntitlementConsumeRefund> {
      return request({ method: 'POST', path: '/v1/entitlements/consume/refund', body });
    },
  };
}
