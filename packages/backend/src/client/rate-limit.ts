import { type RequestFn } from './request';

/** The min/max a single knob is clamped to on write. */
export interface RateLimitBound {
  min: number;
  max: number;
}

/**
 * §9.1 per-instance rate-limit policy — tunable budgets over the built-in
 * request limiter. Both knobs default to the built-in fixed values, so an unset
 * policy changes nothing.
 */
export interface RateLimitPolicy {
  object: 'rate_limit_policy';
  /** Sign-in / sign-up CREATE budget, per IP. Sign-in and sign-up share it. */
  fapi_create_per_min: number;
  /** Backend-API budget, per secret key. */
  bapi_per_min: number;
  /** The floor/ceiling each knob is bounded to when written. */
  bounds: {
    fapi_create_per_min: RateLimitBound;
    bapi_per_min: RateLimitBound;
  };
}

export interface UpdateRateLimitPolicyBody {
  fapi_create_per_min?: number;
  bapi_per_min?: number;
}

/**
 * Read and tune the instance's rate-limit policy — the two budgets layered over
 * the built-in limiter's fixed buckets.
 */
export function rateLimitPolicyResource(request: RequestFn) {
  return {
    /** Read the current policy and the bounds each knob is clamped to. */
    get(): Promise<RateLimitPolicy> {
      return request({ method: 'GET', path: '/v1/rate_limit_policy' });
    },
    /** Adjust either budget; omitted knobs are left unchanged. */
    update(body: UpdateRateLimitPolicyBody): Promise<RateLimitPolicy> {
      return request({ method: 'PATCH', path: '/v1/rate_limit_policy', body });
    },
  };
}
