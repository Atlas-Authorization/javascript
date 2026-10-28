import { enc, type RequestFn } from './request';
import type { ListPage } from './types';

export type AccessPolicyStage = 'sign_in' | 'authorize' | 'token';
export type AccessPolicyGrantType =
  | 'allow'
  | 'block'
  | 'require_mfa'
  | 'require_acr'
  | 'require_policy_acceptance'
  | 'require_action'
  | 'require_auth_strength'
  | 'require_device_bound_session'
  | 'require_password_change'
  | 'sign_in_frequency'
  | 'persistent_session'
  | 'max_session_age';
export type AccessPolicyMode = 'enforce' | 'report_only';
export type AccessPolicyTarget = 'user' | 'machine' | 'agent';
export type AccessClientType = 'browser' | 'native' | 'legacy' | 'device_code' | 'ciba' | 'machine' | 'agent';

export interface AccessPolicyGrant {
  type: AccessPolicyGrantType;
  /** require_acr: the acr; require_policy_acceptance: the policy key; require_action: the action name; require_auth_strength: mfa | passwordless | phishing_resistant. */
  value?: string;
  /** sign_in_frequency / max_session_age: the limit in seconds (60 to 31536000). */
  seconds?: number;
  /** persistent_session: false forbids a remembered session. */
  allow?: boolean;
}

/** Every present condition must match; an absent one matches anything. */
export interface AccessPolicyConditions {
  applications?: string[];
  userIds?: string[];
  groups?: string[];
  orgs?: string[];
  roles?: string[];
  networkZones?: { include?: string[]; exclude?: string[] };
  countries?: string[];
  riskLevels?: Array<'low' | 'medium' | 'high'>;
  deviceTrust?: Array<'trusted' | 'untrusted' | 'unknown'>;
  authMethods?: string[];
  timeWindow?: { days?: number[]; start: string; end: string; timezone?: string };
  devicePlatforms?: string[];
  osVersion?: { min?: string; max?: string };
  clientTypes?: AccessClientType[];
  userAttributes?: Array<{ key: string; op: 'eq' | 'neq' | 'in' | 'not_in' | 'contains' | 'exists'; value?: unknown }>;
  userRiskLevels?: Array<'low' | 'medium' | 'high'>;
  signInRiskLevels?: Array<'low' | 'medium' | 'high'>;
  /** Machine identity or agent ids (targets machine / agent). */
  principalIds?: string[];
}

/** A conditional-access policy, evaluated at sign-in, /authorize and token issuance. */
export interface AccessPolicy {
  object: 'access_policy';
  id: string;
  name: string;
  description: string | null;
  enabled: boolean;
  priority: number;
  stages: AccessPolicyStage[];
  conditions: AccessPolicyConditions;
  grants: AccessPolicyGrant[];
  /** `report_only` never denies; it records `access_policy.would_block`. */
  mode: AccessPolicyMode;
  targets: AccessPolicyTarget[];
  created_at: number;
  updated_at: number;
}

export interface CreateAccessPolicyBody {
  name: string;
  description?: string | null;
  enabled?: boolean;
  priority?: number;
  stages?: AccessPolicyStage[];
  conditions?: AccessPolicyConditions;
  grants: AccessPolicyGrant[];
  mode?: AccessPolicyMode;
  targets?: AccessPolicyTarget[];
}

export type UpdateAccessPolicyBody = Partial<CreateAccessPolicyBody>;

export interface SimulateAccessBody {
  policy_id?: string;
  stage?: AccessPolicyStage;
  ip?: string;
  application_id?: string;
  user_id?: string;
  groups?: string[];
  orgs?: string[];
  roles?: string[];
  country?: string;
  risk_level?: 'low' | 'medium' | 'high';
  device_trust?: 'trusted' | 'untrusted' | 'unknown';
  auth_methods?: string[];
  mfa_verified?: boolean;
  acr?: string[];
  /** Epoch ms; default now. */
  now?: number;
  target_type?: AccessPolicyTarget;
  principal_id?: string;
  device_platform?: string;
  os_version?: string;
  client_type?: AccessClientType;
  user_attributes?: Record<string, unknown>;
  user_risk_level?: 'low' | 'medium' | 'high';
  last_auth_age_seconds?: number;
  session_age_seconds?: number;
  device_bound_session?: boolean;
}

export interface AccessPolicyImpact {
  object: 'access_policy_impact';
  days: number;
  evaluated: number;
  would_allow: number;
  would_step_up: number;
  would_block: number;
  distinct_users: number;
  affected_users: number;
  samples: Array<{ user_id: string | null; stage: string; outcome: string; unmet: string[]; at: number }>;
}

export interface AccessPolicyInsights {
  object: 'access_policy_insights';
  days: number;
  evaluated: number;
  would_block: number;
  would_step_up: number;
  by_policy: Record<string, number>;
  by_day: Record<string, number>;
}

export interface AccessPolicySimulation {
  object: 'access_policy_simulation';
  decision: 'allow' | 'block' | 'step_up';
  matched: string[];
  blocked_by: string | null;
  requirements: {
    mfa: boolean;
    acr: string[];
    policy_acceptance: string[];
    actions: string[];
    auth_strength: 'mfa' | 'passwordless' | 'phishing_resistant' | null;
    sign_in_frequency_seconds: number | null;
    max_session_age_seconds: number | null;
    persistent_session: boolean;
    device_bound_session: boolean;
  };
  unmet: string[];
  report_only: { decision: 'allow' | 'block' | 'step_up'; matched: string[]; blocked_by: string | null } | null;
}

/** CRUD over conditional-access policies, plus a what-if `simulate`. */
export function accessPoliciesResource(request: RequestFn) {
  return {
    list(): Promise<ListPage<AccessPolicy>> {
      return request({ method: 'GET', path: '/v1/access_policies' });
    },
    get(id: string): Promise<AccessPolicy> {
      return request({ method: 'GET', path: `/v1/access_policies/${enc(id)}` });
    },
    create(body: CreateAccessPolicyBody, idempotencyKey?: string): Promise<AccessPolicy> {
      return request({ method: 'POST', path: '/v1/access_policies', body, idempotencyKey });
    },
    update(id: string, body: UpdateAccessPolicyBody): Promise<AccessPolicy> {
      return request({ method: 'PATCH', path: `/v1/access_policies/${enc(id)}`, body });
    },
    delete(id: string): Promise<{ object: 'access_policy'; id: string; deleted: true }> {
      return request({ method: 'DELETE', path: `/v1/access_policies/${enc(id)}` });
    },
    /** Replay a draft policy against recent sampled sign-ins: how many would be allowed, stepped up or blocked. */
    impact(body: { draft: CreateAccessPolicyBody | Record<string, unknown>; days?: number }): Promise<AccessPolicyImpact> {
      return request({ method: 'POST', path: '/v1/access_policies/impact', body });
    },
    /** How often report-only policies would have intervened. */
    insights(query: { days?: number } = {}): Promise<AccessPolicyInsights> {
      return request({ method: 'GET', path: `/v1/access_policies/insights${query.days ? `?days=${query.days}` : ''}` });
    },
    /** What would the policies decide for this request? */
    simulate(body: SimulateAccessBody): Promise<AccessPolicySimulation> {
      return request({ method: 'POST', path: '/v1/access_policies/simulate', body });
    },
  };
}
