import { enc, type RequestFn } from './request';
import type { CursorPage, CursorParams } from './types';

/**
 * §13.4 GDPR/DSAR admin surface — the Data Protection Officer's console over
 * data-subject requests. A user files export/erasure requests from the FAPI;
 * this lets an operator SEE every request and ACTION it out of band: fulfil it
 * now, ahead of its grace window, or reject it with a recorded reason. A
 * fulfilled or rejected request is terminal — a second action is a 409.
 */
export interface DataSubjectRequest {
  object: 'data_subject_request';
  id: string;
  /** Atlas's kind: `export` | `erasure` | `restriction` | `rectification`. */
  type: string;
  /** The shared data-rights word: `access` | `deletion` | `closure` | `restriction` | `rectification`. */
  canonical_type?: string;
  /** Alias of `canonical_type` in the executor protocol spelling. */
  canonicalType?: string;
  /** What opened it: `user` | `api` | `admin` | `orchestrator` | `atlas_id`. */
  source?: string;
  status: string;
  user_id: string;
  detail?: string | null;
  /** The orchestrator's case id, when an orchestrator drives this request. */
  case_id?: string | null;
  /** The case Atlas opened at the instance's data-rights orchestrator. */
  external_case?: {
    product: string;
    id: string | null;
    status: string;
    attempts: number;
    last_error: string | null;
    opened_at: number | null;
    atlas_id_app_id?: string;
  } | null;
  trace_id?: string | null;
  steps?: Array<{ name: string; status: string; reason?: string; at?: number }>;
  retention?: Array<{ category: string; basis: string; until: string }>;
  /** Erasures: when the account is erased (epoch ms). */
  deletion_effective_at?: number | null;
  requested_by_type: string | null;
  requested_by_id: string | null;
  reason: string | null;
  scheduled_for: number | null;
  /** Estimated completion (epoch ms): an erasure's grace deadline; null for an export. */
  eta?: number | null;
  requested_at: number;
  updated_at: number;
  completed_at: number | null;
  /** When a response is owed (epoch ms; null on a closure) and whether it has passed on a request still open. */
  due_at?: number | null;
  overdue?: boolean;
  due_extended_reason?: string | null;
  /** The export package — present on `get` and on a fulfilled export. */
  result?: unknown;
}

export interface ListDataSubjectRequestsParams extends CursorParams {
  type?: string;
  status?: string;
  user_id?: string;
  /** `true`: only open requests whose response deadline has passed. */
  overdue?: boolean;
}

/** Identify the subject by `user_id` OR `subject_email` (`user_id` wins if both are given). */
export interface CreateDataSubjectRequestBody {
  /** Atlas's words or the canonical vocabulary; the answer echoes `canonical_type`. */
  type:
    | 'export'
    | 'erasure'
    | 'erase'
    | 'access'
    | 'deletion'
    | 'closure'
    | 'restriction'
    | 'rectification';
  user_id?: string;
  /** The subject's email (verified, else unverified), resolved to the user. */
  subject_email?: string;
  reason?: string;
}

export function dataSubjectRequestsResource(request: RequestFn) {
  return {
    /**
     * Open an export or erasure request for a user from the backend. Same worker,
     * grace window and webhooks as the self-service flow; idempotent on an
     * in-flight request.
     */
    create(
      body: CreateDataSubjectRequestBody,
      idempotencyKey?: string,
    ): Promise<DataSubjectRequest> {
      return request({ method: 'POST', path: '/v1/data_subject_requests', body, idempotencyKey });
    },
    /**
     * Cancel a scheduled erasure inside its grace window. Once processing or
     * terminal it is a 409; exports are not cancellable.
     */
    cancel(id: string): Promise<DataSubjectRequest> {
      return request({ method: 'POST', path: `/v1/data_subject_requests/${enc(id)}/cancel` });
    },
    list(
      params: ListDataSubjectRequestsParams = {},
    ): Promise<CursorPage<DataSubjectRequest>> {
      return request({ method: 'GET', path: '/v1/data_subject_requests', query: { ...params } });
    },
    get(id: string): Promise<DataSubjectRequest> {
      return request({ method: 'GET', path: `/v1/data_subject_requests/${enc(id)}` });
    },
    /** Move an open request's response deadline later, with the reason recorded on it. */
    extend(id: string, body: { due_at: number | string; reason: string }, idempotencyKey?: string): Promise<DataSubjectRequest> {
      return request({ method: 'POST', path: `/v1/data_subject_requests/${enc(id)}/extend`, body, idempotencyKey });
    },
    /**
     * The signed deletion receipt of a completed erasure (claims carry ids and dates only). Verify the
     * JWS in `receipt` with the keys at `jwks_uri`.
     */
    receipt(id: string): Promise<{
      object: 'deletion_receipt';
      id: string;
      request_id: string;
      subject_id: string;
      issued_at: number;
      receipt: string;
      claims: Record<string, unknown>;
      kid: string;
      jwks_uri: string;
    }> {
      return request({ method: 'GET', path: `/v1/data_subject_requests/${enc(id)}/receipt` });
    },
    /** Fulfil a request now — build the export package, or run the erasure — ahead of schedule. */
    fulfill(id: string, idempotencyKey?: string): Promise<DataSubjectRequest> {
      return request({
        method: 'POST',
        path: `/v1/data_subject_requests/${enc(id)}/fulfill`,
        idempotencyKey,
      });
    },
    /** Reject a request with a recorded reason. Terminal — it cannot be re-actioned. */
    reject(
      id: string,
      body: { reason?: string } = {},
      idempotencyKey?: string,
    ): Promise<DataSubjectRequest> {
      return request({
        method: 'POST',
        path: `/v1/data_subject_requests/${enc(id)}/reject`,
        body,
        idempotencyKey,
      });
    },
  };
}
