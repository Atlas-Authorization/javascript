import { enc, type RequestFn } from './request';

export type IgaKind = 'role' | 'org_membership' | 'group' | 'resource_role' | 'app_assignment' | 'custom';
export type IgaRisk = 'low' | 'medium' | 'high' | 'critical';
export type IgaApproverSelector = { type: 'manager' | 'owner' } | { type: 'group' | 'users'; ids: string[] };
export interface IgaApprovalStep {
  type: 'manager' | 'owner' | 'group' | 'users';
  /** A group slug (`group`) or user ids (`users`). */
  ids?: string[];
  /** `any` approver decides the step; `all` must approve. Default `any`. */
  mode?: 'any' | 'all';
  /** After this long without a decision the step escalates. */
  timeout_seconds?: number;
  escalate_to?: IgaApproverSelector;
}

export interface IgaEntitlement {
  object: 'iga_entitlement';
  id: string;
  key: string;
  name: string;
  description: string | null;
  kind: IgaKind;
  target: Record<string, unknown>;
  owner_user_id: string | null;
  risk_level: IgaRisk;
  approval_rules: { steps: IgaApprovalStep[] };
  max_duration_seconds: number | null;
  requestable: boolean;
  require_justification: boolean;
  created_at: number;
  updated_at: number;
}
export interface IgaEntitlementInput {
  key: string;
  name: string;
  kind: IgaKind;
  /** role `{role_key}`, org_membership `{organization_id, role}`, group `{group}`, resource_role `{resource_id, role}`, app_assignment `{app_id}`, custom (free-form). */
  target: Record<string, unknown>;
  description?: string | null;
  owner_user_id?: string | null;
  risk_level?: IgaRisk;
  approval_rules?: { steps: IgaApprovalStep[] };
  max_duration_seconds?: number | null;
  requestable?: boolean;
  require_justification?: boolean;
}

export type IgaRequestStatus = 'pending' | 'approved' | 'denied' | 'cancelled' | 'fulfilled' | 'failed';
export interface IgaRequest {
  object: 'iga_request';
  id: string;
  entitlement_id: string;
  requester_user_id: string | null;
  beneficiary_user_id: string;
  source: 'self' | 'admin';
  justification: string | null;
  duration_seconds: number | null;
  status: IgaRequestStatus;
  current_step: number | null;
  steps: Array<{ index: number; type: string; mode: 'any' | 'all'; approvers: string[]; status: 'pending' | 'approved' | 'denied'; escalated: boolean; timeout_seconds: number | null; sod_rule_id: string | null }>;
  sod: Array<{ rule_id: string; rule_name: string; mode: 'block' | 'require_approval'; conflicting_entitlement_id: string }>;
  approvals: Array<{ step: number; approver_user_id: string; acting_for_user_id: string | null; decision: 'approve' | 'deny'; comment: string | null; decided_at: number }>;
  failure: string | null;
  decided_at: number | null;
  created_at: number;
}
export interface IgaGrant {
  object: 'iga_grant';
  id: string;
  user_id: string;
  entitlement_id: string;
  request_id: string | null;
  source: 'request' | 'admin' | 'birthright' | 'existing';
  status: 'active' | 'revoked' | 'expired';
  granted_at: number;
  expires_at: number | null;
  revoked_at: number | null;
  revoked_reason: string | null;
  revoked_by: string | null;
  /** The access existed before governance took it over; an expiry leaves it in place. */
  adopted: boolean;
}
export interface IgaDelegation { object: 'iga_delegation'; id: string; delegator_user_id: string; delegate_user_id: string; starts_at: number; ends_at: number; created_at: number }
export interface IgaSodRule {
  object: 'iga_sod_rule';
  id: string;
  name: string;
  description: string | null;
  entitlement_a: string;
  entitlement_b: string;
  mode: 'block' | 'require_approval';
  approver: IgaApprovalStep | null;
  enabled: boolean;
  created_at: number;
  updated_at: number;
}
export interface IgaSodViolation { object: 'iga_sod_violation'; id: string; rule_id: string; rule_name: string | null; mode: string | null; user_id: string; status: 'open' | 'accepted' | 'resolved'; source: 'request' | 'assignment' | 'scan'; request_id: string | null; note: string | null; detected_at: number; resolved_at: number | null }
export interface IgaBirthrightMatch { group?: string; organization_id?: string; org_role?: string; app_role?: string; email_domain?: string }
export interface IgaBirthrightRule { object: 'iga_birthright_rule'; id: string; name: string; match: IgaBirthrightMatch; entitlement_ids: string[]; revoke_on_unmatch: boolean; enabled: boolean; created_at: number }
export interface IgaSettings { object: 'iga_settings'; jml_enabled: boolean; leaver_action: 'revoke' | 'revoke_and_close'; leaver_close_grace_seconds: number | null }
export interface IgaCampaign {
  object: 'iga_campaign';
  id: string;
  name: string;
  description: string | null;
  scope_type: 'all' | 'entitlement' | 'app' | 'role' | 'group' | 'org';
  scope_ids: string[];
  reviewer_type: 'manager' | 'owner' | 'named';
  reviewer_ids: string[];
  status: 'draft' | 'active' | 'closed';
  due_at: number | null;
  reminder_days: number[];
  auto_revoke: boolean;
  launched_at: number | null;
  closed_at: number | null;
  created_at: number;
}
export interface IgaCampaignInput {
  name: string;
  description?: string;
  scope_type?: IgaCampaign['scope_type'];
  scope_ids?: string[];
  reviewer_type?: IgaCampaign['reviewer_type'];
  reviewer_ids?: string[];
  due_at?: number;
  reminder_days?: number[];
  /** Remove access reviewers marked for revocation when the campaign closes. Default true. */
  auto_revoke?: boolean;
}
export interface IgaCampaignItem { object: 'iga_campaign_item'; id: string; campaign_id: string; grant_id: string; user_id: string; entitlement_id: string; reviewer_user_id: string | null; decision: 'pending' | 'certified' | 'revoked'; decided_by: string | null; decided_at: number | null; comment: string | null; revoked_applied: boolean }
export interface IgaCampaignProgress { object: 'iga_campaign_progress'; campaign_id: string; status: IgaCampaign['status']; total: number; pending: number; certified: number; revoked: number; percent_complete: number; overdue: boolean; reviewers: Array<{ reviewer_user_id: string | null; total: number; decided: number }> }
export interface IgaEvidence {
  object: 'iga_campaign_evidence';
  campaign: IgaCampaign;
  progress: IgaCampaignProgress;
  generated_at: string;
  items: Array<{ item_id: string; user_id: string; user_erased: boolean; user_email_masked?: string | null; entitlement_key: string | null; entitlement_name: string | null; risk_level: string | null; reviewer_user_id: string | null; decision: string; decided_by: string | null; decided_at: string | null; revoked_applied: boolean }>;
}
export interface IgaOffboarding { object: 'iga_offboarding'; user_id: string; revoked_grants: number; cancelled_requests: number; account_closure: { effective_at: number; request_id: string } | null }
type List<T> = { object: 'list'; data: T[]; has_more: boolean };
type Deleted<O extends string> = { object: O; id: string; deleted: true };

/**
 * Identity governance: the entitlement catalog, access requests with multi-step
 * approvals, time-bound grants, certification campaigns, separation of duties
 * and joiner/mover/leaver automation. Needs the `iga:read` / `iga:write` scopes.
 */
export function igaResource(request: RequestFn) {
  const P = '/v1/iga';
  return {
    entitlements: {
      list: (params: { kind?: IgaKind } = {}): Promise<List<IgaEntitlement>> => request({ method: 'GET', path: `${P}/entitlements`, query: params }),
      get: (idOrKey: string): Promise<IgaEntitlement> => request({ method: 'GET', path: `${P}/entitlements/${enc(idOrKey)}` }),
      create: (body: IgaEntitlementInput): Promise<IgaEntitlement> => request({ method: 'POST', path: `${P}/entitlements`, body }),
      update: (idOrKey: string, body: Partial<Omit<IgaEntitlementInput, 'key' | 'kind'>>): Promise<IgaEntitlement> => request({ method: 'PATCH', path: `${P}/entitlements/${enc(idOrKey)}`, body }),
      delete: (idOrKey: string): Promise<Deleted<'iga_entitlement'>> => request({ method: 'DELETE', path: `${P}/entitlements/${enc(idOrKey)}` }),
    },
    requests: {
      list: (params: { status?: IgaRequestStatus; user_id?: string; requester_user_id?: string; entitlement?: string; limit?: number } = {}): Promise<List<IgaRequest>> => request({ method: 'GET', path: `${P}/requests`, query: params }),
      get: (id: string): Promise<IgaRequest> => request({ method: 'GET', path: `${P}/requests/${enc(id)}` }),
      /** File a request for a user; it follows the entitlement's approval steps. */
      create: (body: { entitlement: string; user_id: string; requester_user_id?: string; justification?: string; duration_seconds?: number }): Promise<IgaRequest> => request({ method: 'POST', path: `${P}/requests`, body }),
      /** Decide the open step as `approver_user_id`, or as an administrator override when omitted. */
      decide: (id: string, body: { decision: 'approve' | 'deny'; comment?: string; approver_user_id?: string }): Promise<IgaRequest> => request({ method: 'POST', path: `${P}/requests/${enc(id)}/decide`, body }),
      cancel: (id: string): Promise<IgaRequest> => request({ method: 'POST', path: `${P}/requests/${enc(id)}/cancel` }),
      /** Requests waiting on one person (their own steps and delegated ones). */
      inbox: (approverUserId: string): Promise<List<IgaRequest>> => request({ method: 'GET', path: `${P}/approvals`, query: { approver_user_id: approverUserId } }),
    },
    grants: {
      list: (params: { user_id?: string; entitlement?: string; status?: 'active' | 'revoked' | 'expired'; limit?: number } = {}): Promise<List<IgaGrant>> => request({ method: 'GET', path: `${P}/grants`, query: params }),
      create: (body: { entitlement: string; user_id: string; expires_at?: number; override_reason?: string }): Promise<IgaGrant> => request({ method: 'POST', path: `${P}/grants`, body }),
      revoke: (id: string, body: { reason?: string } = {}): Promise<IgaGrant> => request({ method: 'POST', path: `${P}/grants/${enc(id)}/revoke`, body }),
    },
    delegations: {
      list: (params: { delegator_user_id?: string } = {}): Promise<List<IgaDelegation>> => request({ method: 'GET', path: `${P}/delegations`, query: params }),
      create: (body: { delegator_user_id: string; delegate_user_id: string; ends_at: number; starts_at?: number }): Promise<IgaDelegation> => request({ method: 'POST', path: `${P}/delegations`, body }),
      delete: (id: string): Promise<Deleted<'iga_delegation'>> => request({ method: 'DELETE', path: `${P}/delegations/${enc(id)}` }),
    },
    sod: {
      listRules: (): Promise<List<IgaSodRule>> => request({ method: 'GET', path: `${P}/sod_rules` }),
      createRule: (body: { name: string; entitlement_a: string; entitlement_b: string; mode?: 'block' | 'require_approval'; approver?: IgaApprovalStep; description?: string; enabled?: boolean }): Promise<IgaSodRule> => request({ method: 'POST', path: `${P}/sod_rules`, body }),
      updateRule: (id: string, body: { name?: string; description?: string; mode?: 'block' | 'require_approval'; approver?: IgaApprovalStep; enabled?: boolean }): Promise<IgaSodRule> => request({ method: 'PATCH', path: `${P}/sod_rules/${enc(id)}`, body }),
      deleteRule: (id: string): Promise<Deleted<'iga_sod_rule'>> => request({ method: 'DELETE', path: `${P}/sod_rules/${enc(id)}` }),
      /** The violations report. */
      violations: (params: { status?: 'open' | 'accepted' | 'resolved' } = {}): Promise<List<IgaSodViolation>> => request({ method: 'GET', path: `${P}/sod_violations`, query: params }),
      /** Re-check every rule against what people hold now. */
      scan: (): Promise<{ object: 'iga_sod_scan'; found: number; resolved: number }> => request({ method: 'POST', path: `${P}/sod_violations/scan` }),
    },
    lifecycle: {
      listBirthrightRules: (): Promise<List<IgaBirthrightRule>> => request({ method: 'GET', path: `${P}/birthright_rules` }),
      createBirthrightRule: (body: { name: string; match: IgaBirthrightMatch; entitlement_ids: string[]; revoke_on_unmatch?: boolean; enabled?: boolean }): Promise<IgaBirthrightRule> => request({ method: 'POST', path: `${P}/birthright_rules`, body }),
      updateBirthrightRule: (id: string, body: Partial<{ name: string; match: IgaBirthrightMatch; entitlement_ids: string[]; revoke_on_unmatch: boolean; enabled: boolean }>): Promise<IgaBirthrightRule> => request({ method: 'PATCH', path: `${P}/birthright_rules/${enc(id)}`, body }),
      deleteBirthrightRule: (id: string): Promise<Deleted<'iga_birthright_rule'>> => request({ method: 'DELETE', path: `${P}/birthright_rules/${enc(id)}` }),
      /** Re-evaluate one user's birthright access now (joiner or mover). */
      reconcile: (userId: string): Promise<{ object: 'iga_jml'; user_id: string; granted: string[]; revoked: string[] }> => request({ method: 'POST', path: `${P}/users/${enc(userId)}/reconcile` }),
      /** Offboard a leaver; with `close_account` the closure goes through the data-rights path. */
      offboard: (userId: string, body: { close_account?: boolean; grace_seconds?: number; reason?: string } = {}): Promise<IgaOffboarding> => request({ method: 'POST', path: `${P}/users/${enc(userId)}/offboard`, body }),
      settings: (): Promise<IgaSettings> => request({ method: 'GET', path: `${P}/settings` }),
      updateSettings: (body: Partial<Omit<IgaSettings, 'object'>>): Promise<IgaSettings> => request({ method: 'PUT', path: `${P}/settings`, body }),
    },
    campaigns: {
      list: (params: { status?: IgaCampaign['status'] } = {}): Promise<List<IgaCampaign>> => request({ method: 'GET', path: `${P}/campaigns`, query: params }),
      get: (id: string): Promise<IgaCampaign & { progress: IgaCampaignProgress }> => request({ method: 'GET', path: `${P}/campaigns/${enc(id)}` }),
      create: (body: IgaCampaignInput): Promise<IgaCampaign> => request({ method: 'POST', path: `${P}/campaigns`, body }),
      delete: (id: string): Promise<Deleted<'iga_campaign'>> => request({ method: 'DELETE', path: `${P}/campaigns/${enc(id)}` }),
      /** Freeze the review list (adopting access that was never granted through governance) and notify reviewers. */
      launch: (id: string): Promise<IgaCampaign> => request({ method: 'POST', path: `${P}/campaigns/${enc(id)}/launch` }),
      /** Close the campaign; with auto-revoke, access reviewers marked for revocation is removed. */
      close: (id: string): Promise<IgaCampaign> => request({ method: 'POST', path: `${P}/campaigns/${enc(id)}/close` }),
      items: (id: string, params: { decision?: IgaCampaignItem['decision']; reviewer_user_id?: string } = {}): Promise<List<IgaCampaignItem>> => request({ method: 'GET', path: `${P}/campaigns/${enc(id)}/items`, query: params }),
      progress: (id: string): Promise<IgaCampaignProgress> => request({ method: 'GET', path: `${P}/campaigns/${enc(id)}/progress` }),
      /** Audit evidence as JSON. People appear by id only; free-text comments are never included. */
      evidence: (id: string, params: { masked_emails?: boolean } = {}): Promise<IgaEvidence> => request({ method: 'GET', path: `${P}/campaigns/${enc(id)}/evidence`, query: params }),
      /** The same evidence as CSV text. */
      evidenceCsv: (id: string, params: { masked_emails?: boolean } = {}): Promise<string> => request({ method: 'GET', path: `${P}/campaigns/${enc(id)}/evidence`, query: { ...params, format: 'csv' }, raw: true }),
      decide: (itemId: string, body: { decision: 'certify' | 'revoke'; comment?: string; reviewer_user_id?: string }): Promise<IgaCampaignItem> => request({ method: 'POST', path: `${P}/campaign_items/${enc(itemId)}/decide`, body }),
    },
  };
}
