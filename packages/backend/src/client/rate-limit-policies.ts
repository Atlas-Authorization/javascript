import { enc, type RequestFn } from './request';
import type { ListPage } from './types';

export type RateLimitSubjectType = 'key' | 'user' | 'org' | 'machine' | 'ip';

/** Billing plan slug to the limit that plan gets. window_seconds and burst default to the policy's. */
export type RateLimitPlanOverrides = Record<string, { limit: number; window_seconds?: number; burst?: number | null }>;

export interface RateLimitPolicy {
  object: 'api_rate_limit_policy';
  id: string;
  name: string;
  subject: RateLimitSubjectType;
  limit: number;
  window_seconds: number;
  burst: number | null;
  plan_overrides: RateLimitPlanOverrides;
  is_default: boolean;
  enabled: boolean;
  version: number;
  created_at: number;
  updated_at: number;
}

export interface CreateRateLimitPolicyBody {
  name: string;
  subject: RateLimitSubjectType;
  limit: number;
  window_seconds: number;
  burst?: number | null;
  plan_overrides?: RateLimitPlanOverrides;
  /** The policy a subject of this kind gets when nothing more specific applies (one per subject kind). */
  is_default?: boolean;
  enabled?: boolean;
}

/** Send only what changes. `subject` cannot change. */
export type UpdateRateLimitPolicyBody = Partial<Omit<CreateRateLimitPolicyBody, 'subject'>>;

export interface RateLimitOverride {
  object: 'api_rate_limit_override';
  id: string;
  subject_type: RateLimitSubjectType;
  subject_id: string;
  policy_id: string | null;
  limit: number | null;
  window_seconds: number | null;
  burst: number | null;
  reason: string | null;
  expires_at: number | null;
  created_at: number;
  updated_at: number;
}

/** Pin a subject to a policy (`policy_id`), or to an inline limit (`limit` with `window_seconds`). */
export type PutRateLimitOverrideBody = {
  policy_id?: string;
  limit?: number;
  window_seconds?: number;
  burst?: number | null;
  reason?: string | null;
  /** A future time: epoch ms or ISO 8601. */
  expires_at?: number | string | null;
};

/** The limit your own API should apply to one subject. Also the `rate_limit` object on API key verification. */
export interface ResolvedRateLimit {
  limit: number;
  window_seconds: number;
  burst: number | null;
  /** Which rule chose it: a per-subject override, the key's own rate_limit, the subject's plan, or the default policy. */
  source: 'override' | 'key' | 'plan' | 'default';
  policy_id: string | null;
  policy_name: string | null;
  plan: string | null;
  /** Changes whenever the effective limit changes. */
  version: string;
}

export type ResolveRateLimitParams =
  | { key_id: string }
  | { user_id: string }
  | { org_id: string }
  | { machine_id: string }
  | { ip: string };

export interface RateLimitResolution {
  object: 'api_rate_limit_resolution';
  subject_type: RateLimitSubjectType;
  subject_id: string;
  rate_limit: ResolvedRateLimit | null;
}

export function rateLimitPoliciesResource(request: RequestFn) {
  const overridePath = (type: RateLimitSubjectType, id: string) => `/v1/rate_limit_overrides/${enc(type)}/${enc(id)}`;
  return {
    list(params: { subject?: RateLimitSubjectType } = {}): Promise<ListPage<RateLimitPolicy>> {
      return request({ method: 'GET', path: '/v1/rate_limit_policies', query: { ...params } });
    },
    create(body: CreateRateLimitPolicyBody, idempotencyKey?: string): Promise<RateLimitPolicy> {
      return request({ method: 'POST', path: '/v1/rate_limit_policies', body, idempotencyKey });
    },
    get(id: string): Promise<RateLimitPolicy> {
      return request({ method: 'GET', path: `/v1/rate_limit_policies/${enc(id)}` });
    },
    update(id: string, body: UpdateRateLimitPolicyBody): Promise<RateLimitPolicy> {
      return request({ method: 'PATCH', path: `/v1/rate_limit_policies/${enc(id)}`, body });
    },
    /** Refused with 409 while per-subject overrides still point at the policy. */
    delete(id: string): Promise<{ object: 'api_rate_limit_policy'; id: string; deleted: true }> {
      return request({ method: 'DELETE', path: `/v1/rate_limit_policies/${enc(id)}` });
    },
    /** The limit that applies to one subject right now, and which rule chose it. */
    resolve(params: ResolveRateLimitParams): Promise<RateLimitResolution> {
      return request({ method: 'GET', path: '/v1/rate_limit_policies/resolve', query: { ...params } });
    },
    overrides: {
      list(params: { subject_type?: RateLimitSubjectType; limit?: number; starting_after?: string } = {}): Promise<ListPage<RateLimitOverride>> {
        return request({ method: 'GET', path: '/v1/rate_limit_overrides', query: { ...params } });
      },
      get(type: RateLimitSubjectType, id: string): Promise<RateLimitOverride> {
        return request({ method: 'GET', path: overridePath(type, id) });
      },
      put(type: RateLimitSubjectType, id: string, body: PutRateLimitOverrideBody): Promise<RateLimitOverride> {
        return request({ method: 'PUT', path: overridePath(type, id), body });
      },
      delete(type: RateLimitSubjectType, id: string): Promise<{ object: 'api_rate_limit_override'; id: string; deleted: true }> {
        return request({ method: 'DELETE', path: overridePath(type, id) });
      },
    },
  };
}
