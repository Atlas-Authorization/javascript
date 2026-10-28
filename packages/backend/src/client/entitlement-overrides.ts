import { enc, type RequestFn } from './request';
import type { ListPage } from './types';

export type EntitlementOverrideSubjectType = 'user' | 'org';

/**
 * A sales-led entitlement override: a plan / features / limits pinned onto a
 * user or organization without Stripe (e.g. an Enterprise contract). A
 * non-expired override wins over the Stripe-derived entitlement and reaches the
 * session claims on the next session.
 */
export interface EntitlementOverride {
  object: 'entitlement_override';
  id: string;
  subject_type: EntitlementOverrideSubjectType;
  subject_id: string;
  /** Pinned plan slug, or null when only features/limits are overridden. */
  plan: string | null;
  features: string[] | null;
  limits: Record<string, unknown> | null;
  /** Epoch ms when the override lapses, or null for open-ended. */
  expires_at: number | null;
  /** For an account of the owner's own products: reads back as `planSource: "internal"` and never counts as revenue. */
  internal?: boolean;
  created_by: string | null;
  created_at: number;
}

/** At least one of `plan`, `features` or `limits` is required. */
export interface CreateEntitlementOverrideBody {
  subject_type: EntitlementOverrideSubjectType;
  subject_id: string;
  plan?: string | null;
  /** Replaces (does not add to) the resolved feature set. */
  features?: string[] | null;
  /** Numeric limits, e.g. `{ max_devices: 50 }`. */
  limits?: Record<string, unknown> | null;
  /** Epoch ms; omit or null for open-ended. */
  expires_at?: number | null;
  /** The grant is for an account of the owner's own products (reported as `internal`). */
  internal?: boolean;
}

export interface ListEntitlementOverridesParams {
  subject_type?: EntitlementOverrideSubjectType;
  subject_id?: string;
}

export function entitlementOverridesResource(request: RequestFn) {
  return {
    create(
      body: CreateEntitlementOverrideBody,
      idempotencyKey?: string,
    ): Promise<EntitlementOverride> {
      return request({ method: 'POST', path: '/v1/entitlement_overrides', body, idempotencyKey });
    },
    /** Includes expired overrides (kept for audit; they no longer apply). */
    list(
      params: ListEntitlementOverridesParams = {},
    ): Promise<ListPage<EntitlementOverride>> {
      return request({ method: 'GET', path: '/v1/entitlement_overrides', query: { ...params } });
    },
    /** Revoke: the subject reverts to its Stripe-derived entitlement on the next session. */
    delete(id: string): Promise<{ object: 'entitlement_override'; id: string; deleted: true }> {
      return request({ method: 'DELETE', path: `/v1/entitlement_overrides/${enc(id)}` });
    },
  };
}

/** The standard entitlements document: one shape any product can serve (JSON Schema `https://atlasauth.net/schemas/entitlements-v1.json`). */
export interface Entitlements {
  object: 'entitlements';
  $schema?: string;
  subject: { type: EntitlementOverrideSubjectType; id: string };
  plan: string | null;
  /** `plan` (a subscription), `override` (a sales-led grant), `internal` (an owner account, never revenue) or `none`. */
  planSource: 'plan' | 'override' | 'internal' | 'none';
  entitlements: Array<{
    key: string;
    enabled: boolean;
    limit?: number;
    used?: number;
    source: 'plan' | 'override' | 'internal';
  }>;
}

export function entitlementsResource(request: RequestFn) {
  return {
    /** `GET /v1/entitlements`: gate a feature the same way against any product that serves this shape. */
    get(params: { subject_type: EntitlementOverrideSubjectType; subject_id: string }): Promise<Entitlements> {
      return request({ method: 'GET', path: '/v1/entitlements', query: { ...params } });
    },
  };
}
