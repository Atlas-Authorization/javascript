import { enc, type RequestFn } from './request';

/** `machine` for a machine resource grant, `agent` for an approved agent access request. */
export type GrantType = 'machine' | 'agent';

export interface UsageDecision {
  object: 'usage_decision';
  allowed: boolean;
  counter: string;
  amount: number;
  used: number;
  /** Read from the grant at the time of the call. */
  limit: number;
  remaining: number;
  window: 'none' | 'minute' | 'hour' | 'day' | 'month';
  window_start: number | null;
  /** When the window ends (epoch ms); null for a counter with no window. */
  resets_at: number | null;
  reason: 'limit_reached' | 'grant_expired' | 'grant_inactive' | null;
  lease?: { id: string; amount: number; expires_at: number };
  /** True when this is the stored answer to an earlier call with the same idempotency key. */
  replayed?: boolean;
}

export interface ConsumeBody {
  counter: string;
  /** Default 1. Omit for a counter with `amount_field`. */
  amount?: number;
  /** Required. A repeat returns the stored original decision. */
  idempotency_key: string;
  /** At most 2 KB. Carries the amount for an `amount_field` counter. */
  context?: Record<string, unknown>;
  /** Reserve the amount for a short time instead of consuming it. Not for `amount_field` counters. */
  lease?: boolean;
  /** 1 to 300. */
  ttl_seconds?: number;
}

export interface RefundBody {
  counter: string;
  amount?: number;
  idempotency_key: string;
  /** The idempotency key of the consume to reverse. */
  consume_idempotency_key: string;
}

export interface UsageRefund {
  object: 'usage_refund';
  refunded: boolean;
  counter: string;
  amount: number;
  used: number;
  reason: 'unknown_consume' | 'not_refundable' | 'exceeds_consumed' | null;
  replayed?: boolean;
}

export interface GrantUsage {
  object: 'grant_usage';
  grant_type: GrantType;
  grant_id: string;
  machine_id: string;
  live: boolean;
  counters: Array<{
    counter: string;
    limit: number;
    window: string;
    amount_field: string | null;
    window_start: number | null;
    resets_at: number | null;
    used: number;
    remaining: number;
  }>;
  leases: Array<{ id: string; counter: string; amount: number; expires_at: number }>;
}

export interface UsageLease {
  object: 'usage_lease';
  id: string;
  counter: string;
  amount: number;
  consumed: number;
  returned: number;
  status: 'active' | 'released' | 'expired';
  expires_at: number;
}

/**
 * Atomic usage counters on grants: POST /v1/grants/:grantType/:id/consume, POST /v1/grants/:grantType/:id/refund,
 * GET /v1/grants/:grantType/:id/usage, POST /v1/grants/:grantType/:id/leases/:leaseId/release.
 */
export function grantUsageResource(request: RequestFn) {
  const base = (type: GrantType, id: string) => `/v1/grants/${enc(type)}/${enc(id)}`;
  return {
    /** Take an amount from a counter. A denial is a decision with `allowed: false`, not an error. */
    consume(type: GrantType, id: string, body: ConsumeBody): Promise<UsageDecision> {
      return request({ method: 'POST', path: `${base(type, id)}/consume`, body });
    },
    /** Give back all or part of one earlier consume. */
    refund(type: GrantType, id: string, body: RefundBody): Promise<UsageRefund> {
      return request({ method: 'POST', path: `${base(type, id)}/refund`, body });
    },
    /** The current window of every counter the grant defines, and the leases still holding an amount. */
    usage(type: GrantType, id: string): Promise<GrantUsage> {
      return request({ method: 'GET', path: `${base(type, id)}/usage` });
    },
    /** Hand a lease back; the unconsumed part returns to the counter. */
    releaseLease(type: GrantType, id: string, leaseId: string, body: { consumed?: number } = {}): Promise<UsageLease> {
      return request({ method: 'POST', path: `${base(type, id)}/leases/${enc(leaseId)}/release`, body });
    },
  };
}
