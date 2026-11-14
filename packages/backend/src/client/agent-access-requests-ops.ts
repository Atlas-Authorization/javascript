import { enc, type RequestFn } from './request';



export type AgentAccessRequestsApproveBody = {
  expires_in_seconds?: number;
  decided_by?: string;
};

export type AgentAccessRequestsDenyBody = {
  decided_by?: string;
};

export interface AgentAccessRequestsListQuery {
  /** Request status to filter by. */
  status?: 'pending' | 'approved' | 'denied' | 'revoked';
  /** Restrict to one agent. */
  agent_id?: string;
  /** Page size. Defaults to 50; values above 200 are capped at 200. */
  limit?: number;
  /** Cursor: return only items after this one. Pass the previous page's `next_cursor` (the last item's id). An unknown cursor is a 400. */
  starting_after?: string;
}

export type AgentAccessRequestsListResult = {
  object?: 'list';
  data?: Record<string, unknown>[];
  has_more?: boolean;
};

/** Operations on `/v1/agent_access_requests` (3). */
export function agentAccessRequestsOpsResource(request: RequestFn) {
  return {
    /** Approve a pending request, optionally for a limited time (expires_in_seconds). 409 when it is no longer pending. Emits agent.access_decided. */
    approve(id: string, body?: AgentAccessRequestsApproveBody, idempotencyKey?: string): Promise<void> {
      return request({ method: 'POST', path: `/v1/agent_access_requests/${enc(id)}/approve`, body, idempotencyKey });
    },
    /** Deny a pending request. 409 when it is no longer pending. Emits agent.access_decided. */
    deny(id: string, body?: AgentAccessRequestsDenyBody, idempotencyKey?: string): Promise<void> {
      return request({ method: 'POST', path: `/v1/agent_access_requests/${enc(id)}/deny`, body, idempotencyKey });
    },
    /** List agent access requests, newest first. Filter by status (pending, approved, denied, revoked) or agent_id. */
    list(query?: AgentAccessRequestsListQuery): Promise<AgentAccessRequestsListResult> {
      return request({ method: 'GET', path: '/v1/agent_access_requests', query: { ...query } });
    },
  };
}
