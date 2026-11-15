import { enc, type RequestFn } from './request';

export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired' | 'cancelled';

export interface ApprovalApprovers {
  /** Named users. Give this or `organization_id` with `role`. */
  user_ids?: string[];
  organization_id?: string;
  /** An organization role key; members holding it may decide. */
  role?: string;
  /** How many distinct approvers must approve. Default 1. */
  required?: number;
}

export interface CreateApprovalRequestBody {
  /** The user the request is about. */
  user_id: string;
  /** What is being approved, shown to the approver. */
  description: string;
  context?: Record<string, string>;
  /** 10 to 604800. Default 120. */
  ttl_seconds?: number;
  approvers?: ApprovalApprovers;
  /** Demand a signature over the canonical request even from the user themselves. */
  require_signature?: boolean;
  /** An opaque value the receipt can only be consumed against (for example a hash of the tool and its arguments). */
  binding?: string;
  reference?: string;
  /** Only an approval from a device the approver trusted counts (see `approvals.trustDevice`). The instance setting approvals.requireTrustedDevice makes this the rule for every request. */
  require_trusted_device?: boolean;
  /** The user the request is about can never approve or reject it, even holding the approver role. Needs `approvers`. Default false. */
  exclude_requester?: boolean;
  /** Name of a step-up policy: an approver may approve from a session that just met it instead of signing with a device key. */
  step_up_policy?: string;
}

export interface ApprovalDecision {
  approver_user_id: string;
  decision: 'approve' | 'deny';
  method: 'device_key' | 'passkey' | 'step_up' | 'number_match';
  /** The free-text note the approver left with this decision. */
  note?: string | null;
  key_id: string | null;
  /** The trusted device the decision came from, when it came from one. */
  trusted_device_id?: string | null;
  decided_at: number;
}

export interface ApprovalRequest {
  object: 'approval_request';
  id: string;
  status: ApprovalStatus;
  user_id: string;
  description?: string;
  context?: Record<string, string>;
  created_at?: number;
  expires_at: number;
  resolved_at?: number | null;
  ttl_seconds?: number | null;
  reference: string | null;
  binding: string | null;
  require_signature: boolean;
  require_trusted_device?: boolean;
  exclude_requester?: boolean;
  step_up_policy?: string | null;
  approvers: { mode: 'subject' | 'users' | 'role'; user_ids: string[]; organization_id: string | null; role: string | null; required: number };
  /** SHA-256 of `canonical`, base64url: what an approver signs. */
  digest: string | null;
  canonical: string | null;
  /** The signed receipt (a compact JWS) once approved. Verify it with `verifyApprovalReceipt`. */
  receipt: string | null;
  consumed_at: number | null;
  approvals_received?: number;
  decisions?: ApprovalDecision[];
}

export interface ApprovalRequestCreated {
  object: 'approval_request';
  id: string;
  status: 'pending';
  user_id: string;
  /** Show this to the user in the default flow; null when the request names its own approvers. */
  match_number: string | null;
  expires_at: number;
  approvers: ApprovalRequest['approvers'];
  require_signature: boolean;
  require_trusted_device?: boolean;
  exclude_requester?: boolean;
  step_up_policy?: string | null;
  digest: string | null;
  reference: string | null;
  binding: string | null;
}

export type ApprovalDeviceKind = 'device_key' | 'passkey' | 'push_device';

/** A device a user can approve from, marked trusted or not. */
export interface ApprovalDevice {
  object: 'approval_device';
  kind: ApprovalDeviceKind;
  /** The id within its kind: the signing key id, the passkey credential id or the push device id. */
  ref: string;
  label: string | null;
  platform: string | null;
  created_at: number | null;
  last_used_at: number | null;
  trusted: boolean;
  /** Present while trusted: the id to revoke, and the one decisions record. */
  trusted_device_id: string | null;
  trusted_at: number | null;
  trusted_by: { type: 'user' | 'api_key' | 'dashboard_user'; id: string | null } | null;
}

export interface ListApprovalRequestsParams {
  status?: ApprovalStatus;
  user_id?: string;
  approver_user_id?: string;
  reference?: string;
  /** Epoch ms. */
  created_after?: number;
  created_before?: number;
  limit?: number;
  starting_after?: string;
}

/** Approval requests v2 (`/v1/approval_requests`): lifetime, N-of-M approvers, signed receipts. */
export function approvalsResource(request: RequestFn) {
  return {
    create(body: CreateApprovalRequestBody, opts: { idempotencyKey?: string } = {}): Promise<ApprovalRequestCreated> {
      return request({ method: 'POST', path: '/v1/approval_requests', body, ...(opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {}) });
    },
    list(params: ListApprovalRequestsParams = {}): Promise<{ object: 'list'; data: ApprovalRequest[]; has_more: boolean }> {
      return request({ method: 'GET', path: '/v1/approval_requests', query: { ...params } });
    },
    /** `waitSeconds` (0 to 25) holds the call open until the request leaves pending. */
    get(id: string, opts: { waitSeconds?: number } = {}): Promise<ApprovalRequest> {
      return request({ method: 'GET', path: `/v1/approval_requests/${enc(id)}`, ...(opts.waitSeconds ? { query: { wait_seconds: opts.waitSeconds } } : {}) });
    },
    /** Spend an approved request once; pass the `binding` it was created with. */
    consume(id: string, body: { binding?: string } = {}): Promise<ApprovalRequest> {
      return request({ method: 'POST', path: `/v1/approval_requests/${enc(id)}/consume`, body });
    },
    cancel(id: string): Promise<ApprovalRequest> {
      return request({ method: 'POST', path: `/v1/approval_requests/${enc(id)}/cancel` });
    },
    /** Every device the user can approve from, each marked trusted or not. */
    listDevices(userId: string): Promise<{ object: 'list'; data: ApprovalDevice[]; has_more: boolean }> {
      return request({ method: 'GET', path: `/v1/users/${enc(userId)}/approval_devices` });
    },
    /** Trust one of the user's devices for approvals that require a trusted device. Trusting a trusted device changes nothing. */
    trustDevice(userId: string, body: { kind: ApprovalDeviceKind; ref: string; label?: string }, opts: { idempotencyKey?: string } = {}): Promise<ApprovalDevice> {
      return request({ method: 'POST', path: `/v1/users/${enc(userId)}/approval_devices/trust`, body, ...(opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {}) });
    },
    /** Stop trusting a device by its `trusted_device_id`. */
    revokeDevice(userId: string, trustedDeviceId: string): Promise<{ object: 'approval_trusted_device'; id: string; kind: string; ref: string; revoked: boolean; revoked_at: number }> {
      return request({ method: 'DELETE', path: `/v1/users/${enc(userId)}/approval_devices/${enc(trustedDeviceId)}` });
    },
  };
}
