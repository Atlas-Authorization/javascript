import type { FapiClient, FapiResponse } from './fapi';
import type { FieldError } from './attempt';

/**
 * Identity governance for the signed-in user: browse what can be requested,
 * request it, follow requests, decide approvals waiting on you, certify access
 * you were asked to review, and hand your approvals to a stand-in.
 */

export type AccessRisk = 'low' | 'medium' | 'high' | 'critical';
export type AccessRequestStatus = 'pending' | 'approved' | 'denied' | 'cancelled' | 'fulfilled' | 'failed';

export interface AccessCatalogItem {
  object: 'iga_catalog_item';
  id: string;
  key: string;
  name: string;
  description: string | null;
  kind: 'role' | 'org_membership' | 'group' | 'resource_role' | 'app_assignment' | 'custom';
  risk_level: AccessRisk;
  /** How many approval steps a request goes through (0 = granted immediately). */
  approval_steps: number;
  max_duration_seconds: number | null;
  require_justification: boolean;
}

export interface AccessGrant {
  object: 'iga_grant';
  id: string;
  user_id: string;
  entitlement_id: string;
  source: 'request' | 'admin' | 'birthright' | 'existing';
  status: 'active' | 'revoked' | 'expired';
  granted_at: number;
  /** When a time-bound grant ends; null = until revoked. */
  expires_at: number | null;
}

export interface AccessRequest {
  object: 'iga_request';
  id: string;
  entitlement_id: string;
  beneficiary_user_id: string;
  justification: string | null;
  duration_seconds: number | null;
  status: AccessRequestStatus;
  /** The step waiting on a decision (null once the request is final). */
  current_step: number | null;
  steps: Array<{ index: number; type: string; mode: 'any' | 'all'; approvers: string[]; status: 'pending' | 'approved' | 'denied'; escalated: boolean }>;
  approvals: Array<{ step: number; approver_user_id: string; acting_for_user_id: string | null; decision: 'approve' | 'deny'; comment: string | null; decided_at: number }>;
  created_at: number;
}

export interface AccessReviewItem {
  object: 'iga_campaign_item';
  id: string;
  campaign_id: string;
  user_id: string;
  entitlement_id: string;
  decision: 'pending' | 'certified' | 'revoked';
}

export interface AccessDelegation {
  object: 'iga_delegation';
  id: string;
  delegator_user_id: string;
  delegate_user_id: string;
  starts_at: number;
  ends_at: number;
}

export type AccessResult<T> = { ok: true; data: T } | { ok: false; errors: FieldError[] };
type Listed<T> = { object: 'list'; data: T[] };

const P = '/v1/client/me/iga';
const wrap = <T>(res: FapiResponse<T>): AccessResult<T> => (res.ok && res.data !== null ? { ok: true, data: res.data } : { ok: false, errors: res.errors });
const list = async <T>(client: FapiClient, path: string): Promise<AccessResult<T[]>> => {
  const r = wrap(await client.get<Listed<T>>(path));
  return r.ok ? { ok: true, data: r.data.data } : r;
};

/** What the signed-in user may request. */
export const listAccessCatalog = (client: FapiClient) => list<AccessCatalogItem>(client, `${P}/catalog`);
/** Access the user holds through governance, with expiry dates. */
export const listMyAccess = (client: FapiClient) => list<AccessGrant>(client, `${P}/grants`);
export const listMyAccessRequests = (client: FapiClient) => list<AccessRequest>(client, `${P}/requests`);

/**
 * Ask for access. A refusal carries the reason: a missing justification (400), access
 * already held or already requested (409), or a separation-of-duties conflict (409, with
 * `meta.sod`).
 */
export async function requestAccess(client: FapiClient, input: { entitlement: string; justification?: string; durationSeconds?: number }): Promise<AccessResult<AccessRequest>> {
  return wrap(await client.post<AccessRequest>(`${P}/requests`, { entitlement: input.entitlement, justification: input.justification, duration_seconds: input.durationSeconds }));
}
export async function getAccessRequest(client: FapiClient, id: string): Promise<AccessResult<AccessRequest>> {
  return wrap(await client.get<AccessRequest>(`${P}/requests/${encodeURIComponent(id)}`));
}
export async function cancelAccessRequest(client: FapiClient, id: string): Promise<AccessResult<AccessRequest>> {
  return wrap(await client.post<AccessRequest>(`${P}/requests/${encodeURIComponent(id)}/cancel`, {}));
}

/** Requests waiting on this user's decision (their own steps and those delegated to them). */
export const listPendingApprovals = (client: FapiClient) => list<AccessRequest>(client, `${P}/approvals`);
export async function decideAccessRequest(client: FapiClient, id: string, decision: 'approve' | 'deny', comment?: string): Promise<AccessResult<AccessRequest>> {
  return wrap(await client.post<AccessRequest>(`${P}/requests/${encodeURIComponent(id)}/decide`, { decision, comment }));
}

/** Access review items waiting on this user. */
export const listAccessReviews = (client: FapiClient) => list<AccessReviewItem>(client, `${P}/reviews`);
export async function decideAccessReview(client: FapiClient, id: string, decision: 'certify' | 'revoke', comment?: string): Promise<AccessResult<AccessReviewItem>> {
  return wrap(await client.post<AccessReviewItem>(`${P}/reviews/${encodeURIComponent(id)}/decide`, { decision, comment }));
}

export const listAccessDelegations = (client: FapiClient) => list<AccessDelegation>(client, `${P}/delegations`);
/** Let another user decide your approvals and reviews until `endsAt` (epoch ms, at most a year out). */
export async function delegateApprovals(client: FapiClient, input: { delegateUserId: string; endsAt: number; startsAt?: number }): Promise<AccessResult<AccessDelegation>> {
  return wrap(await client.post<AccessDelegation>(`${P}/delegations`, { delegate_user_id: input.delegateUserId, ends_at: input.endsAt, starts_at: input.startsAt }));
}
export async function endDelegation(client: FapiClient, id: string): Promise<AccessResult<{ id: string; deleted: true }>> {
  return wrap(await client.request<{ id: string; deleted: true }>(`${P}/delegations/${encodeURIComponent(id)}`, { method: 'DELETE' }));
}
