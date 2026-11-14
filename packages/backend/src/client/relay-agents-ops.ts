import { enc, type RequestFn } from './request';



export interface RelayAgentsListQuery {
  /** Page size, 1-500. Without limit (and without starting_after) the whole list is returned. */
  limit?: number;
  /** Cursor: return only items after this one. Pass the previous page's `next_cursor` (the last item's id). An unknown cursor is a 400. */
  starting_after?: string;
}

export type RelayAgentsListResult = {
  object?: 'list';
  data?: ({
    object?: 'relay_agent';
    id?: string;
    name?: string;
    organization_id?: string | null;
    status?: 'active' | 'revoked';
    allowed_destinations?: string[];
    cert_fingerprints?: string[];
    secret_prefix?: string;
    online?: boolean;
    last_seen_at?: number | null;
    last_ip?: string | null;
    agent_version?: string | null;
    created_at?: number;
    /** On create and rotate only: the agent token, shown once. */
    token?: string;
  })[];
  has_more?: boolean;
};

export type RelayAgentsCreateBody = {
  name: string;
  organization_id?: string | null;
  status?: 'active' | 'revoked';
  /** host:port destinations the agent may reach. */
  allowed_destinations?: string[];
  /** Client-certificate pins. */
  cert_fingerprints?: string[];
};

export type RelayAgentsCreateResult = {
  object?: 'relay_agent';
  id?: string;
  name?: string;
  organization_id?: string | null;
  status?: 'active' | 'revoked';
  allowed_destinations?: string[];
  cert_fingerprints?: string[];
  secret_prefix?: string;
  online?: boolean;
  last_seen_at?: number | null;
  last_ip?: string | null;
  agent_version?: string | null;
  created_at?: number;
  /** On create and rotate only: the agent token, shown once. */
  token?: string;
};

export type RelayAgentsGetResult = {
  object?: 'relay_agent';
  id?: string;
  name?: string;
  organization_id?: string | null;
  status?: 'active' | 'revoked';
  allowed_destinations?: string[];
  cert_fingerprints?: string[];
  secret_prefix?: string;
  online?: boolean;
  last_seen_at?: number | null;
  last_ip?: string | null;
  agent_version?: string | null;
  created_at?: number;
  /** On create and rotate only: the agent token, shown once. */
  token?: string;
};

export type RelayAgentsUpdateBody = {
  name?: string;
  organization_id?: string | null;
  status?: 'active' | 'revoked';
  /** host:port destinations the agent may reach. */
  allowed_destinations?: string[];
  /** Client-certificate pins. */
  cert_fingerprints?: string[];
};

export type RelayAgentsUpdateResult = {
  object?: 'relay_agent';
  id?: string;
  name?: string;
  organization_id?: string | null;
  status?: 'active' | 'revoked';
  allowed_destinations?: string[];
  cert_fingerprints?: string[];
  secret_prefix?: string;
  online?: boolean;
  last_seen_at?: number | null;
  last_ip?: string | null;
  agent_version?: string | null;
  created_at?: number;
  /** On create and rotate only: the agent token, shown once. */
  token?: string;
};

export type RelayAgentsRotateSecretResult = {
  object?: 'relay_agent';
  id?: string;
  name?: string;
  organization_id?: string | null;
  status?: 'active' | 'revoked';
  allowed_destinations?: string[];
  cert_fingerprints?: string[];
  secret_prefix?: string;
  online?: boolean;
  last_seen_at?: number | null;
  last_ip?: string | null;
  agent_version?: string | null;
  created_at?: number;
  /** On create and rotate only: the agent token, shown once. */
  token?: string;
};

/** Operations on `/v1/relay_agents` (6). */
export function relayAgentsOpsResource(request: RequestFn) {
  return {
    /** List the on-prem relay agents with their allowed destinations and whether each is online. Secrets are never returned. */
    list(query?: RelayAgentsListQuery): Promise<RelayAgentsListResult> {
      return request({ method: 'GET', path: '/v1/relay_agents', query: { ...query } });
    },
    /** Register an outbound-only relay agent. The response carries the agent token once; it cannot be read back. An agent can reach only the destinations in allowed_destinations (host, host:port, *.domain). */
    create(body?: RelayAgentsCreateBody, idempotencyKey?: string): Promise<RelayAgentsCreateResult> {
      return request({ method: 'POST', path: '/v1/relay_agents', body, idempotencyKey });
    },
    /** Read one relay agent, including when it last polled. */
    get(id: string): Promise<RelayAgentsGetResult> {
      return request({ method: 'GET', path: `/v1/relay_agents/${enc(id)}` });
    },
    /** Rename an agent, change its allowed destinations or pinned client-certificate thumbprints, or revoke it (status: revoked). */
    update(id: string, body?: RelayAgentsUpdateBody): Promise<RelayAgentsUpdateResult> {
      return request({ method: 'PATCH', path: `/v1/relay_agents/${enc(id)}`, body });
    },
    /** Delete a relay agent and its queued jobs. */
    delete(id: string): Promise<void> {
      return request({ method: 'DELETE', path: `/v1/relay_agents/${enc(id)}` });
    },
    /** Issue a new agent token (returned once). The old token stops working immediately. */
    rotateSecret(id: string): Promise<RelayAgentsRotateSecretResult> {
      return request({ method: 'POST', path: `/v1/relay_agents/${enc(id)}/rotate_secret` });
    },
  };
}
