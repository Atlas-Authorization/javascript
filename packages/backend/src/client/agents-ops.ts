import { enc, type RequestFn } from './request';



export type AgentsClaimBody = {
  user_id: string;
};

export interface AgentsListQuery {
  /** Restrict to agents owned by this user. */
  owner_user_id?: string;
  /** Trust tier to filter by. */
  tier?: 'untrusted' | 'trusted';
  /** Page size. Defaults to 50; values above 200 are capped at 200. */
  limit?: number;
  /** Cursor: the id of the last agent of the previous page. */
  starting_after?: string;
}

export type AgentsListResult = {
  object?: 'list';
  data?: Record<string, unknown>[];
  has_more?: boolean;
};

export type AgentsGetResult = Record<string, unknown>;

export type AgentsSetOwnerBody = {
  user_id: string | null;
};

export type AgentsRevokeAccessBody = {
  disable?: boolean;
};

/** Operations on `/v1/agents` (5). */
export function agentsOpsResource(request: RequestFn) {
  return {
    /** Backend-assisted claim: bind an agent to a user you already know and promote it to trusted. Audited as agent.claimed. */
    claim(id: string, body: AgentsClaimBody, idempotencyKey?: string): Promise<void> {
      return request({ method: 'POST', path: `/v1/agents/${enc(id)}/claim`, body, idempotencyKey });
    },
    /** The agent registry: every registered agent with its tier, owner and status. Filter by owner_user_id or tier; page with limit and starting_after. */
    list(query?: AgentsListQuery): Promise<AgentsListResult> {
      return request({ method: 'GET', path: '/v1/agents', query: { ...query } });
    },
    /** One agent with its currently valid access grants. */
    get(id: string): Promise<AgentsGetResult> {
      return request({ method: 'GET', path: `/v1/agents/${enc(id)}` });
    },
    /** Set the owning user of an agent, or null to remove the owner (which also drops the agent back to untrusted). */
    setOwner(id: string, body: AgentsSetOwnerBody): Promise<void> {
      return request({ method: 'PUT', path: `/v1/agents/${enc(id)}/owner`, body });
    },
    /** Revoke every grant and cancel every pending request of an agent. With disable: true the agent itself is revoked and can no longer get tokens. Emits agent.access_revoked. */
    revokeAccess(id: string, body?: AgentsRevokeAccessBody, idempotencyKey?: string): Promise<void> {
      return request({ method: 'POST', path: `/v1/agents/${enc(id)}/revoke_access`, body, idempotencyKey });
    },
  };
}
