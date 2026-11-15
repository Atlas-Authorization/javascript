import { enc, type RequestFn } from './request';
import type { ListPage } from './types';

export type InstanceSigningAlg = 'RS256' | 'ES256' | 'ES384' | 'PS256' | 'EdDSA';

// ── Scheduled signing-key rotation ────────────────────────────────────────

export interface SigningKeySchedule {
  object: 'signing_key_schedule';
  enabled: boolean;
  interval_days: number | null;
  alg: InstanceSigningAlg | null;
  grace_period_seconds: number | null;
  prepublish_hours: number | null;
  /** What the previous key is kept for in practice (never shorter than the longest token the instance signs lives, plus the key set cache). */
  effective_grace_seconds: number;
  next_rotation_at: number | null;
  last_rotated_at: number | null;
  last_error: string | null;
  last_error_at: number | null;
}

export interface SetSigningKeyScheduleBody {
  interval_days: number;
  enabled?: boolean;
  alg?: InstanceSigningAlg | null;
  grace_period_seconds?: number | null;
  prepublish_hours?: number;
}

export function signingKeyScheduleResource(request: RequestFn) {
  return {
    get(): Promise<SigningKeySchedule> {
      return request({ method: 'GET', path: '/v1/instance/signing_key_schedule' });
    },
    /** Needs a recent MFA sign-in. The previous key stays published until every token it signed has expired. */
    set(body: SetSigningKeyScheduleBody): Promise<SigningKeySchedule> {
      return request({ method: 'PUT', path: '/v1/instance/signing_key_schedule', body });
    },
    remove(): Promise<{ object: 'signing_key_schedule'; enabled: false; deleted: true }> {
      return request({ method: 'DELETE', path: '/v1/instance/signing_key_schedule' });
    },
  };
}

// ── Audit chain ───────────────────────────────────────────────────────────

export interface AuditChainStatus {
  object: 'audit_chain';
  enabled: boolean;
  enabled_at: number | null;
  checkpoint_interval_seconds: number | null;
  head_seq: number | null;
  head_hash: string | null;
  genesis_hash: string;
  last_checkpoint_seq: number | null;
  last_checkpoint_at: number | null;
  unchained_rows: number;
  algorithm: Record<string, string>;
  jwks_uri: string;
}

export interface AuditChainLinkRecord {
  object: 'audit_chain_link';
  seq: number;
  audit_id: string;
  row_hash: string;
  link_hash: string;
  row: {
    id: string;
    actor_type: string;
    actor_id: string | null;
    action: string;
    target_type: string | null;
    target_id: string | null;
    ip: string | null;
    user_agent: string | null;
    metadata: unknown;
    created_at: number;
  } | null;
}

export interface AuditChainCheckpointRecord {
  object: 'audit_chain_checkpoint';
  id: string;
  seq: number;
  link_hash: string;
  kid: string;
  alg: string;
  jws: string;
  signed_at: number;
}

export interface AuditChainVerification {
  object: 'audit_chain_verification';
  ok: boolean;
  checked: number;
  pruned: number;
  first_break: { seq: number; reason: 'row_modified' | 'link_mismatch' | 'gap' } | null;
  next_seq: number;
  done: boolean;
  checkpoints: { checked: number; valid: number; unverifiable: number; mismatched: number };
}

export function auditChainResource(request: RequestFn) {
  return {
    get(): Promise<AuditChainStatus> {
      return request({ method: 'GET', path: '/v1/audit/chain' });
    },
    /** Turn the chain on (needs a recent MFA sign-in). A chain that is on cannot be turned off. */
    enable(body: { checkpoint_interval_seconds?: number } = {}): Promise<AuditChainStatus> {
      return request({ method: 'PUT', path: '/v1/audit/chain', body: { enabled: true, ...body } });
    },
    links(params: { after_seq?: number; limit?: number } = {}): Promise<ListPage<AuditChainLinkRecord> & { next_after_seq: number }> {
      return request({ method: 'GET', path: '/v1/audit/chain/links', query: { ...params } });
    },
    checkpoints(params: { after_seq?: number; limit?: number } = {}): Promise<ListPage<AuditChainCheckpointRecord> & { jwks_uri: string }> {
      return request({ method: 'GET', path: '/v1/audit/chain/checkpoints', query: { ...params } });
    },
    /** Sign a checkpoint of the head now. */
    signCheckpoint(): Promise<AuditChainCheckpointRecord> {
      return request({ method: 'POST', path: '/v1/audit/chain/checkpoints' });
    },
    /** Server-side recomputation. For an independent check use `verifyAuditChain` on exported links. */
    verify(body: { from_seq?: number; to_seq?: number; max_links?: number } = {}): Promise<AuditChainVerification> {
      return request({ method: 'POST', path: '/v1/audit/chain/verify', body });
    },
  };
}

// ── Session bindings ──────────────────────────────────────────────────────

export interface SessionBinding {
  object: 'session_binding';
  session_id: string;
  bound: boolean;
  jkt: string | null;
  alg: string | null;
  attested: boolean;
  attestation_provider: string | null;
  bound_at: number | null;
  last_proof_at: number | null;
}

export function sessionBindingsResource(request: RequestFn) {
  return {
    get(sessionId: string): Promise<SessionBinding> {
      return request({ method: 'GET', path: `/v1/sessions/${enc(sessionId)}/binding` });
    },
    /** Let the session bind a new key (a user who lost their device key). */
    remove(sessionId: string): Promise<{ object: 'session_binding'; session_id: string; bound: false; deleted: true }> {
      return request({ method: 'DELETE', path: `/v1/sessions/${enc(sessionId)}/binding` });
    },
  };
}

// ── Agent delegations ─────────────────────────────────────────────────────

export interface AgentDelegation {
  object: 'agent_delegation';
  id: string;
  child_machine_id: string;
  parent_delegation_id: string | null;
  root_delegation_id: string;
  parent_machine_id: string | null;
  delegator_user_id: string | null;
  organization_id: string | null;
  depth: number;
  scopes: string[];
  resource: string | null;
  status: 'active' | 'revoked';
  expires_at: number | null;
  revoked_at: number | null;
  revoked_by: string | null;
  revoked_reason: string | null;
  posture: Record<string, unknown>;
  last_decision: 'allow' | 'deny' | 'revoked' | null;
  last_evaluated_at: number | null;
  created_at: number;
}

export interface CreateAgentDelegationBody {
  child_machine_id: string;
  scopes: string[];
  /** A root delegation: the user the agent acts for. */
  delegator_user_id?: string;
  /** A child delegation: the delegation it narrows. */
  parent_delegation_id?: string;
  resource?: string | null;
  expires_in_seconds?: number;
  expires_at?: string | number;
  organization_id?: string;
}

export interface AgentDelegationRevocation {
  object: 'agent_delegation_revocation';
  revoked: AgentDelegation[];
  disabled_machine_ids: string[];
  count: number;
}

export type AgentAccessReason = 'delegator_unavailable' | 'delegation_expired' | 'delegation_revoked' | 'mfa_stale' | 'risk_too_high' | 'untrusted_device' | 'no_active_session';

export interface AgentAccessEvaluation {
  object: 'agent_access_evaluation';
  delegation_id: string;
  decision: 'allow' | 'deny' | 'revoked';
  reasons: AgentAccessReason[];
  posture: Record<string, unknown> | null;
  /** How long an `allow` may be cached before asking again. */
  valid_for_seconds: number;
  evaluated_at: number;
}

export interface AgentDelegationGraph {
  object: 'agent_delegation_graph';
  root_id: string;
  ancestors: AgentDelegation[];
  nodes: AgentDelegation[];
  edges: Array<{ from: string; to: string; parent_machine_id: string | null; child_machine_id: string }>;
}

export function agentDelegationsResource(request: RequestFn) {
  return {
    /** Needs a recent MFA sign-in. A child delegation can only narrow its parent. */
    create(body: CreateAgentDelegationBody, idempotencyKey?: string): Promise<AgentDelegation> {
      return request({ method: 'POST', path: '/v1/agent_delegations', body, idempotencyKey });
    },
    list(params: { machine_id?: string; delegator_user_id?: string; root_id?: string; status?: 'active' | 'revoked'; limit?: number; starting_after?: string } = {}): Promise<ListPage<AgentDelegation>> {
      return request({ method: 'GET', path: '/v1/agent_delegations', query: { ...params } });
    },
    get(id: string): Promise<AgentDelegation & { evaluations: Array<{ decision: string; reasons: string[]; evaluated_at: number }> }> {
      return request({ method: 'GET', path: `/v1/agent_delegations/${enc(id)}` });
    },
    graph(id: string): Promise<AgentDelegationGraph> {
      return request({ method: 'GET', path: `/v1/agent_delegations/${enc(id)}/graph` });
    },
    /** Revoke a delegation and everything below it. */
    revoke(id: string, body: { reason?: string; disable_agents?: boolean } = {}): Promise<AgentDelegationRevocation> {
      return request({ method: 'POST', path: `/v1/agent_delegations/${enc(id)}/revoke`, body });
    },
    /** Revoke every delegation a user made. */
    revokeForUser(userId: string, body: { reason?: string; disable_agents?: boolean } = {}): Promise<AgentDelegationRevocation> {
      return request({ method: 'POST', path: '/v1/agent_delegations/revoke_for_user', body: { user_id: userId, ...body } });
    },
    /** Continuous access evaluation: may this agent still act? Cache an `allow` for `valid_for_seconds`. */
    evaluate(id: string, body: { enforce?: boolean } = {}): Promise<AgentAccessEvaluation> {
      return request({ method: 'POST', path: `/v1/agent_delegations/${enc(id)}/evaluate`, body });
    },
  };
}
