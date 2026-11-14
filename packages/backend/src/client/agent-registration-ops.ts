import { type RequestFn } from './request';



export type AgentRegistrationGetResult = {
  object?: 'agent_registration';
  enabled?: boolean;
  allow_anonymous?: boolean;
  allow_service_auth?: boolean;
  allow_refresh?: boolean;
  untrusted_scopes?: string[];
  trusted_scopes?: string[];
  claim_ttl_seconds?: number;
  auto_approve_rules?: ({
    kind?: 'tool' | 'connection';
    resource?: string;
  })[];
};

export type AgentRegistrationSetBody = {
  enabled?: boolean;
  allow_anonymous?: boolean;
  allow_service_auth?: boolean;
  allow_refresh?: boolean;
  untrusted_scopes?: string[];
  trusted_scopes?: string[];
  claim_ttl_seconds?: number;
  /** Access requests from a trusted agent matching a rule are approved automatically. */
  auto_approve_rules?: ({
    kind: 'tool' | 'connection';
    /** Exact name, or a prefix ending in *. */
    resource: string;
  })[];
};

/** Operations on `/v1/agent_registration` (2). */
export function agentRegistrationOpsResource(request: RequestFn) {
  return {
    /** Read the agent registration settings (enabled, allowed identity kinds, untrusted and trusted scopes, claim code lifetime). */
    get(): Promise<AgentRegistrationGetResult> {
      return request({ method: 'GET', path: '/v1/agent_registration' });
    },
    /** Update the agent registration settings. Partial: only the fields sent change. */
    set(body: AgentRegistrationSetBody): Promise<void> {
      return request({ method: 'PUT', path: '/v1/agent_registration', body });
    },
  };
}
