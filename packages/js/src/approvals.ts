import type { FapiClient, FapiResponse } from './fapi';

/**
 * Answering approval requests as the approver (see "Approval requests and signed receipts" in the guides).
 *
 * `listApprovals` / `getApproval` show what is waiting; render `canonical` to the person, because its SHA-256 `digest` is
 * what the signature covers. `generateApprovalKey` + `registerApprovalKey` set up a device key once; `approveRequest` signs the
 * digest with it and `denyRequest` refuses (no signature needed). `approveWithPasskey` answers with a WebAuthn assertion whose
 * challenge is the digest.
 */
export interface ApprovalForApprover {
  id: string;
  status: 'pending' | 'approved' | 'denied' | 'expired' | 'cancelled';
  description: string;
  context: Record<string, string> | null;
  userId: string;
  approvers: { mode: 'subject' | 'users' | 'role'; userIds: string[]; organizationId: string | null; role: string | null; required: number };
  /** The exact text to show; its SHA-256 (base64url) is `digest`. */
  canonical: string | null;
  digest: string | null;
  signatureRequired: boolean;
  /** True when only an approval from a trusted device counts; trust this device first with `trustApprovalDevice`. */
  requireTrustedDevice: boolean;
  /** The user the request is about cannot decide it. */
  excludeRequester: boolean;
  /** When set, `approveWithStepUp` can approve after a fresh step-up for this policy. */
  stepUpPolicy: string | null;
  expiresAt: number;
  createdAt: number;
}

interface ApprovalWire {
  id: string;
  status: ApprovalForApprover['status'];
  description: string;
  context: Record<string, string> | null;
  user_id: string;
  approvers: { mode: 'subject' | 'users' | 'role'; user_ids: string[]; organization_id: string | null; role: string | null; required: number };
  canonical: string | null;
  digest: string | null;
  signature_required: boolean;
  require_trusted_device?: boolean;
  exclude_requester?: boolean;
  step_up_policy?: string | null;
  expires_at: number;
  created_at: number;
}

const toApproval = (w: ApprovalWire): ApprovalForApprover => ({
  id: w.id,
  status: w.status,
  description: w.description,
  context: w.context,
  userId: w.user_id,
  approvers: { mode: w.approvers.mode, userIds: w.approvers.user_ids, organizationId: w.approvers.organization_id, role: w.approvers.role, required: w.approvers.required },
  canonical: w.canonical,
  digest: w.digest,
  signatureRequired: w.signature_required,
  requireTrustedDevice: w.require_trusted_device === true,
  excludeRequester: w.exclude_requester === true,
  stepUpPolicy: w.step_up_policy ?? null,
  expiresAt: w.expires_at,
  createdAt: w.created_at,
});

export interface ApprovalDecisionResult {
  status: 'pending' | 'approved' | 'denied';
  approvalsReceived: number;
  required: number;
}

interface DecisionWire {
  status: ApprovalDecisionResult['status'];
  approvals_received: number;
  required: number;
}

/** The requests waiting on the signed-in person. */
export async function listApprovals(client: FapiClient): Promise<ApprovalForApprover[]> {
  const r = await client.get<{ data: ApprovalWire[] }>('/v1/client/me/approvals');
  return r.ok && r.data ? r.data.data.map(toApproval) : [];
}

/** One request the person may decide, or null (unknown, not theirs, or no session). */
export async function getApproval(client: FapiClient, id: string): Promise<ApprovalForApprover | null> {
  const r = await client.get<ApprovalWire>(`/v1/client/me/approvals/${encodeURIComponent(id)}`);
  return r.ok && r.data ? toApproval(r.data) : null;
}

const b64u = (bytes: Uint8Array | ArrayBuffer): string => {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const jsonB64u = (o: unknown) => b64u(new TextEncoder().encode(JSON.stringify(o)));

/** An ES256 device key. Keep `privateKey` non-extractable in the platform key store where you can. */
export interface ApprovalKey {
  privateKey: CryptoKey;
  publicJwk: JsonWebKey;
}

export async function generateApprovalKey(): Promise<ApprovalKey> {
  const pair = await globalThis.crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const { kty, crv, x, y } = await globalThis.crypto.subtle.exportKey('jwk', pair.publicKey);
  return { privateKey: pair.privateKey, publicJwk: { kty, crv, x, y } };
}

async function signJws(key: CryptoKey, header: Record<string, unknown>, payload: Record<string, unknown>): Promise<string> {
  const input = `${jsonB64u({ alg: 'ES256', ...header })}.${jsonB64u(payload)}`;
  const sig = await globalThis.crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(input));
  return `${input}.${b64u(sig)}`;
}

/** Register a device key. Needs a recent sign-in; the proof shows you hold the private half. */
export async function registerApprovalKey(client: FapiClient, key: ApprovalKey, input: { userId: string; label?: string }): Promise<FapiResponse<{ id: string; thumbprint: string }>> {
  const proof = await signJws(key.privateKey, { typ: 'atlas-approval-key+jws' }, { user_id: input.userId, purpose: 'register_approval_key', iat: Math.floor(Date.now() / 1000) });
  return client.post('/v1/client/me/approval_keys', { public_jwk: key.publicJwk, proof_jws: proof, ...(input.label ? { label: input.label } : {}) });
}

async function decide(client: FapiClient, id: string, body: Record<string, unknown>): Promise<{ result: ApprovalDecisionResult | null; response: FapiResponse<DecisionWire> }> {
  const response = await client.post<DecisionWire>(`/v1/client/me/approvals/${encodeURIComponent(id)}/decision`, body);
  const d = response.data;
  return { result: response.ok && d ? { status: d.status, approvalsReceived: d.approvals_received, required: d.required } : null, response };
}

/** Approve by signing the request digest with the registered device key. `selectedNumber` is for the default number-matching flow. */
export async function approveRequest(client: FapiClient, approval: Pick<ApprovalForApprover, 'id' | 'digest'>, key: ApprovalKey & { keyId: string }, opts: { selectedNumber?: string; note?: string } = {}) {
  if (!approval.digest) throw new Error('This approval has no digest to sign.');
  const jws = await signJws(key.privateKey, { typ: 'atlas-approval-decision+jws', kid: key.keyId }, { approval_id: approval.id, digest: approval.digest, decision: 'approve', iat: Math.floor(Date.now() / 1000) });
  return decide(client, approval.id, { decision: 'approve', signature: { type: 'device_key', key_id: key.keyId, jws }, ...(opts.selectedNumber ? { selected_number: opts.selectedNumber } : {}), ...(opts.note ? { note: opts.note } : {}) });
}

/** Approve with a passkey: the assertion's challenge is the request digest (a base64url string). */
export async function approveWithPasskey(client: FapiClient, approval: Pick<ApprovalForApprover, 'id' | 'digest'>, opts: { selectedNumber?: string; note?: string } = {}) {
  if (!approval.digest) throw new Error('This approval has no digest to sign.');
  const padded = approval.digest.replace(/-/g, '+').replace(/_/g, '/');
  const challenge = Uint8Array.from(atob(padded + '='.repeat((4 - (padded.length % 4)) % 4)), (c) => c.charCodeAt(0));
  const credential = (await navigator.credentials.get({ publicKey: { challenge, userVerification: 'required' } })) as PublicKeyCredential | null;
  if (!credential) throw new Error('No passkey assertion was produced.');
  const r = credential.response as AuthenticatorAssertionResponse;
  return decide(client, approval.id, {
    decision: 'approve',
    signature: {
      type: 'passkey',
      credential_id: b64u(credential.rawId),
      authenticator_data: b64u(r.authenticatorData),
      client_data_json: b64u(r.clientDataJSON),
      signature: b64u(r.signature),
    },
    ...(opts.selectedNumber ? { selected_number: opts.selectedNumber } : {}),
    ...(opts.note ? { note: opts.note } : {}),
  });
}

/** Approve from this session after a fresh step-up for the request's `stepUpPolicy` (re-authenticate first), instead of signing. */
export function approveWithStepUp(client: FapiClient, id: string, opts: { selectedNumber?: string; note?: string } = {}) {
  return decide(client, id, { decision: 'approve', signature: { type: 'step_up' }, ...(opts.selectedNumber ? { selected_number: opts.selectedNumber } : {}), ...(opts.note ? { note: opts.note } : {}) });
}

/** Refuse. A denial needs no signature and ends the request. */
export function denyRequest(client: FapiClient, id: string, opts: { note?: string } = {}) {
  return decide(client, id, { decision: 'deny', ...(opts.note ? { note: opts.note } : {}) });
}

/** A device you can approve from, marked trusted or not. */
export interface ApprovalDevice {
  kind: 'device_key' | 'passkey' | 'push_device';
  ref: string;
  label: string | null;
  trusted: boolean;
  /** Present while trusted: pass it to `revokeApprovalDeviceTrust`. */
  trustedDeviceId: string | null;
}

interface ApprovalDeviceWire {
  kind: ApprovalDevice['kind'];
  ref: string;
  label: string | null;
  trusted: boolean;
  trusted_device_id: string | null;
}

const toDevice = (w: ApprovalDeviceWire): ApprovalDevice => ({ kind: w.kind, ref: w.ref, label: w.label, trusted: w.trusted, trustedDeviceId: w.trusted_device_id });

/** Your devices that can approve (signing keys, passkeys, verified push devices). */
export async function listApprovalDevices(client: FapiClient): Promise<ApprovalDevice[]> {
  const r = await client.get<{ data: ApprovalDeviceWire[] }>('/v1/client/me/approval_devices');
  return r.ok && r.data ? r.data.data.map(toDevice) : [];
}

/** Trust one of your devices for approvals that require a trusted device. Needs a recent sign-in. */
export async function trustApprovalDevice(client: FapiClient, device: Pick<ApprovalDevice, 'kind' | 'ref'>, opts: { label?: string } = {}): Promise<FapiResponse<ApprovalDeviceWire>> {
  return client.post('/v1/client/me/approval_devices/trust', { kind: device.kind, ref: device.ref, ...(opts.label ? { label: opts.label } : {}) });
}

/** Stop trusting a device, by its `trustedDeviceId`. */
export function revokeApprovalDeviceTrust(client: FapiClient, trustedDeviceId: string): Promise<FapiResponse<{ revoked: boolean }>> {
  return client.request(`/v1/client/me/approval_devices/${encodeURIComponent(trustedDeviceId)}`, { method: 'DELETE' });
}
