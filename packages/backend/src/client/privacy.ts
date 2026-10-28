import { enc, type RequestFn } from './request';

/**
 * The data-rights executor protocol (v2) — the routes any DSAR orchestrator
 * calls to find a person and carry out a request against their identity data
 * (needs a key with `privacy:execute`) — and the instance's own data-rights
 * orchestrator, where Atlas opens a case when an account deletion is scheduled
 * (needs `instance:read` / `instance:write`).
 */
export type PrivacyCanonicalType = 'access' | 'deletion' | 'closure' | 'restriction' | 'rectification';
export type PrivacyRequestStatus =
  | 'pending'
  | 'scheduled'
  | 'processing'
  | 'completed'
  | 'completed_with_retention'
  | 'rejected'
  | 'no_match'
  | 'cancelled';

export interface PrivacySubject {
  iss?: string;
  sub?: string;
  ext?: string;
  principal?: string;
}

export interface PrivacyLookupResult {
  object: 'privacy_lookup';
  status: 'found' | 'no_match';
  subjectId: string | null;
  matchedBy: 'atlas.sub' | 'atlas.ext' | 'email' | 'email_unverified' | null;
  detail: string | null;
  principal?: string;
}

export interface PrivacyRequest {
  object: 'privacy_request';
  id: string;
  type: PrivacyCanonicalType;
  canonicalType: PrivacyCanonicalType;
  requestedType: string;
  status: PrivacyRequestStatus;
  subjectId: string;
  caseId: string | null;
  executeAfter: string | null;
  eta: string | null;
  detail: string | null;
  retention: Array<{ category: string; basis: string; until: string }>;
  steps: Array<{ name: string; status: string; reason?: string; at?: number }>;
  trace: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  /** On `getRequest` once done. */
  result?: unknown;
}

export interface CreatePrivacyRequestBody {
  subjectId: string;
  type: PrivacyCanonicalType | 'export' | 'erasure' | 'erase';
  caseId: string;
  /** ISO 8601 or epoch ms: nothing is erased before it. */
  executeAfter?: string | number;
  reason?: string;
}

export interface PrivacyOrchestrator {
  object: 'privacy_orchestrator';
  configured: boolean;
  enabled: boolean;
  provider: string | null;
  name: string | null;
  case_url: string | null;
  cancel_url: string | null;
  auth_header: string;
  auth_scheme: string;
  api_key_set: boolean;
  signing_secret_set: boolean;
  use_partner_link: boolean;
  /** The partner link the orchestrator's owner granted this platform (sent as `X-Partner-Link`). */
  partner_link_id: string | null;
  /** The orchestrator-side site a case is for (Cookie Munch: the cbid). */
  site_id: string | null;
  open_closure_cases: boolean;
  /** Cancel a self-scheduled deletion when the person signs back in during the grace period. */
  cancel_deletion_on_sign_in: boolean;
  completion_webhook: Record<string, unknown> | null;
  last_case_at: number | null;
  last_error: string | null;
  last_error_at: number | null;
  presets: Array<Record<string, unknown>>;
  /** Only on the write that minted it. */
  signing_secret?: string;
  /** Only on the write that created the completion endpoint. */
  completion_webhook_secret?: string;
}

export interface PrivacyOrchestratorInput {
  /** A preset id (`cookiemunch`, `custom`) or your own lower-case id. */
  provider?: string;
  name?: string;
  enabled?: boolean;
  case_url?: string | null;
  /** Must contain `{id}`. */
  cancel_url?: string | null;
  auth_header?: string;
  auth_scheme?: 'bearer' | 'raw';
  api_key?: string | null;
  /** Call through the partner link the orchestrator granted Atlas (partner id = provider). */
  use_partner_link?: boolean;
  /** Implies use_partner_link. */
  partner_link_id?: string | null;
  site_id?: string | null;
  open_closure_cases?: boolean;
  cancel_deletion_on_sign_in?: boolean;
  sign_requests?: boolean;
  completion_webhook_url?: string | null;
}

export function privacyResource(request: RequestFn) {
  return {
    /** What this executor speaks (public). */
    discover(): Promise<Record<string, unknown>> {
      return request({ method: 'GET', path: '/v1/privacy' });
    },
    /** A ready-made orchestrator connection profile, e.g. `cookiemunch` (public). */
    preset(id: string): Promise<Record<string, unknown>> {
      return request({ method: 'GET', path: `/v1/privacy/presets/${enc(id)}` });
    },
    /** Find a person: `atlas.sub` alone when present, then `atlas.ext`, then emails. */
    lookup(body: { emails?: string[]; atlas?: PrivacySubject }): Promise<PrivacyLookupResult> {
      return request({ method: 'POST', path: '/v1/privacy/lookup', body });
    },
    /** Open a request (or get the existing one for the same case). */
    createRequest(body: CreatePrivacyRequestBody, idempotencyKey?: string): Promise<PrivacyRequest> {
      return request({ method: 'POST', path: '/v1/privacy/requests', body, idempotencyKey });
    },
    getRequest(id: string): Promise<PrivacyRequest> {
      return request({ method: 'GET', path: `/v1/privacy/requests/${enc(id)}` });
    },
    /** Cancel before it runs: nothing is erased, the account stays. */
    cancelRequest(id: string, idempotencyKey?: string): Promise<PrivacyRequest> {
      return request({ method: 'POST', path: `/v1/privacy/requests/${enc(id)}/cancel`, idempotencyKey });
    },
    orchestrator: {
      get(): Promise<PrivacyOrchestrator> {
        return request({ method: 'GET', path: '/v1/instance/privacy_orchestrator' });
      },
      /** Connect or update; new secrets come back once. */
      set(body: PrivacyOrchestratorInput): Promise<PrivacyOrchestrator> {
        return request({ method: 'PUT', path: '/v1/instance/privacy_orchestrator', body });
      },
      delete(): Promise<PrivacyOrchestrator & { deleted: boolean }> {
        return request({ method: 'DELETE', path: '/v1/instance/privacy_orchestrator' });
      },
    },
  };
}
