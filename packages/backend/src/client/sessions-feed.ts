import { enc, type RequestFn } from './request';
import type { ListPage } from './types';
import type { Session } from './sessions';

/** The filters a session list, export or bulk revoke takes. Every one narrows. */
export interface SessionFilterParams {
  user_id?: string;
  /** Sessions of users who are members of this organization. */
  organization_id?: string;
  /** An IP address or a CIDR block (`203.0.113.0/24`). */
  ip?: string;
  /** Two-letter country code the session started from. */
  country?: string;
  /** Text the user agent contains (case-insensitive). */
  device?: string;
  risk_level?: 'low' | 'medium' | 'high';
  /** Advisory risk score of at least this (0 to 100). */
  min_risk_score?: number;
  /** Epoch ms. */
  created_after?: number;
  /** Epoch ms. */
  created_before?: number;
  /** true: live sessions only; false: ended or expired ones. */
  active?: boolean;
}

/** One entry of the revocation feed. `sub` is the user. */
export interface SessionRevocation {
  sid: string;
  sub: string;
  revoked_at: number;
  reason: string | null;
}

export interface SessionRevocationsPage {
  object: 'list';
  data: SessionRevocation[];
  has_more: boolean;
  /** Pass as `after` for the next page. */
  next_after: string | null;
  server_time: number;
  window_start: number;
}

/** The signed list a verifier polls. Verify `token` with `verifyStatusList` and look sessions up with the result. */
export interface SessionStatusListResponse {
  object: 'session_status_list';
  token: string;
  issued_at: number;
  expires_at: number;
  window_seconds: number;
  count: number;
  truncated: boolean;
}

export interface SessionEvent {
  id: string;
  type: 'created' | 'step_up' | 'organization_changed' | 'risk_elevated' | 'revoked' | 'expired';
  /** Epoch ms. */
  at: number;
  ip: string | null;
  actor_type: string | null;
  actor_id: string | null;
  detail: Record<string, unknown>;
}

export interface SessionEventsPage {
  object: 'list';
  session_id: string;
  data: SessionEvent[];
  has_more: boolean;
  next_after: string | null;
}

export interface SessionRevokeJob {
  object: 'session_revoke_job';
  id: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  filter: Record<string, unknown>;
  reason: string;
  matched: number;
  revoked: number;
  failed: number;
  error: string | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}

export interface SessionRevokePreview {
  object: 'session_revoke_preview';
  dry_run: true;
  matched: number;
  filter: Record<string, unknown>;
}

export interface FilteredSessionsPage extends ListPage<Session> {
  next_cursor?: string | null;
}

/** Revocation feed, signed status list, event timeline, filtered list, revoke-by-filter and export. */
export function sessionsFeedResource(request: RequestFn) {
  return {
    /** `GET /v1/sessions` with filters: sessions across the instance, newest first, paged with `cursor`. */
    listFiltered(params: SessionFilterParams & { status?: 'active' | 'ended'; limit?: number; cursor?: string }): Promise<FilteredSessionsPage> {
      return request({ method: 'GET', path: '/v1/sessions', query: { ...params } });
    },
    /** `GET /v1/sessions/revocations`: sessions revoked after a point (epoch ms, or the previous page's `next_after`). */
    listRevocations(params: { after?: number | string; limit?: number } = {}): Promise<SessionRevocationsPage> {
      return request({ method: 'GET', path: '/v1/sessions/revocations', query: { ...params } });
    },
    /** `GET /v1/sessions/revocations/status-list`: the signed list of recent revocations. */
    getRevocationStatusList(params: { window_seconds?: number } = {}): Promise<SessionStatusListResponse> {
      return request({ method: 'GET', path: '/v1/sessions/revocations/status-list', query: { ...params } });
    },
    /** `GET /v1/sessions/{id}/events`: the session's timeline, oldest first. */
    listEvents(id: string, params: { limit?: number; after?: string } = {}): Promise<SessionEventsPage> {
      return request({ method: 'GET', path: `/v1/sessions/${enc(id)}/events`, query: { ...params } });
    },
    /** `POST /v1/sessions/revoke_by_filter` with `dry_run: true`: how many active sessions the filter matches. Nothing changes. */
    previewRevokeByFilter(filter: SessionFilterParams): Promise<SessionRevokePreview> {
      return request({ method: 'POST', path: '/v1/sessions/revoke_by_filter', body: { ...filter, dry_run: true } });
    },
    /** `POST /v1/sessions/revoke_by_filter`: revoke every active session matching the filter, as an async job. Needs at least one filter field. */
    revokeByFilter(filter: SessionFilterParams, options: { reason?: string; idempotencyKey?: string } = {}): Promise<SessionRevokeJob> {
      return request({
        method: 'POST',
        path: '/v1/sessions/revoke_by_filter',
        body: { ...filter, ...(options.reason ? { reason: options.reason } : {}) },
        ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
      });
    },
    /** `GET /v1/sessions/revoke_jobs/{id}`. */
    getRevokeJob(id: string): Promise<SessionRevokeJob> {
      return request({ method: 'GET', path: `/v1/sessions/revoke_jobs/${enc(id)}` });
    },
    /** `GET /v1/sessions/revoke_jobs`. */
    listRevokeJobs(params: { limit?: number } = {}): Promise<ListPage<SessionRevokeJob>> {
      return request({ method: 'GET', path: '/v1/sessions/revoke_jobs', query: { ...params } });
    },
    /** `GET /v1/sessions/export`: CSV or NDJSON text of the matching sessions. */
    exportSessions(params: SessionFilterParams & { format?: 'csv' | 'ndjson'; limit?: number } = {}): Promise<string> {
      return request({ method: 'GET', path: '/v1/sessions/export', query: { ...params }, raw: true });
    },
  };
}
