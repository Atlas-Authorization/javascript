import { enc, type RequestFn } from './request';
import type { ListPage } from './types';

export interface ActorToken {
  object: 'actor_token';
  id: string;
  user_id: string;
  actor: { sub: string };
  /** The one-time opaque secret, revealed once. */
  token: string;
  expires_in: number;
}

export interface CreateActorTokenBody {
  user_id: string;
  actor: { sub: string };
  /** Clamped server-side to [1, 3600]; defaults to 60. */
  expires_in_seconds?: number;
}

export function actorTokensResource(request: RequestFn) {
  return {
    create(body: CreateActorTokenBody, idempotencyKey?: string): Promise<ActorToken> {
      return request({ method: 'POST', path: '/v1/actor_tokens', body, idempotencyKey });
    },
    revoke(id: string): Promise<{ object: 'actor_token'; id: string; revoked: true }> {
      return request({ method: 'POST', path: `/v1/actor_tokens/${enc(id)}/revoke` });
    },
  };
}

export interface ImpersonationRequest {
  object: 'impersonation_request';
  id: string;
  /** `pending` until a second staff member decides; a pending request past its window reads as `expired`. */
  status: 'pending' | 'approved' | 'denied' | 'expired';
  user_id: string;
  staff_user_id: string;
  reason: string | null;
  reason_code: string | null;
  read_only: boolean;
  max_duration_seconds: number;
  decided_by: string | null;
  decided_at: number | null;
  impersonation_id: string | null;
  expires_at: number;
  created_at: number;
}

export interface StartImpersonationBody {
  user_id: string;
  staff_user_id: string;
  reason?: string;
  reason_code?: string;
  max_duration_seconds?: number;
  read_only?: boolean;
  require_staff_org_id?: string;
  require_staff_mfa?: boolean;
}

/** Staff impersonation: start one (or request approval for one), and the second-person approval flow. */
export function impersonationsResource(request: RequestFn) {
  return {
    /** Returns the session (201), or a pending request (202) when the instance requires a second approver. */
    start(body: StartImpersonationBody, idempotencyKey?: string): Promise<Record<string, unknown>> {
      return request({ method: 'POST', path: '/v1/impersonations', body, idempotencyKey });
    },
    end(id: string): Promise<Record<string, unknown>> {
      return request({ method: 'POST', path: `/v1/impersonations/${enc(id)}/end` });
    },
    requests: {
      list(query: { status?: string } = {}): Promise<ListPage<ImpersonationRequest>> {
        return request({ method: 'GET', path: '/v1/impersonations/requests', query: { ...query } });
      },
      get(id: string): Promise<ImpersonationRequest> {
        return request({ method: 'GET', path: `/v1/impersonations/requests/${enc(id)}` });
      },
      /** A second staff member (not the requester, not the user) approves; approving starts the session. */
      approve(id: string, body: { approver_user_id: string; note?: string }): Promise<ImpersonationRequest & { impersonation?: Record<string, unknown> }> {
        return request({ method: 'POST', path: `/v1/impersonations/requests/${enc(id)}/approve`, body });
      },
      deny(id: string, body: { approver_user_id: string; note?: string }): Promise<ImpersonationRequest> {
        return request({ method: 'POST', path: `/v1/impersonations/requests/${enc(id)}/deny`, body });
      },
    },
  };
}
