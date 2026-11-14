import { compactVerify, createLocalJWKSet, decodeProtectedHeader, importJWK, type JSONWebKeySet, type JWK } from 'jose';

/**
 * Verify an approval receipt offline.
 *
 * A receipt is a compact JWS Atlas signs with the instance signing key when an approval request reaches its quorum
 * (header `typ: "atlas-approval-receipt+jws"`). It carries the canonical request exactly as the approvers saw it, its
 * digest, and every approver's proof. Verification needs only the instance JWKS (`<issuer>/.well-known/jwks.json`):
 * no call to Atlas.
 *
 * What is proven, per approver:
 *  - `device_key`  the approver's own ES256 signature over `{ approval_id, digest, decision }` is verified against the
 *                  public key stored in the receipt, so the receipt is evidence even apart from Atlas's signature;
 *  - `passkey`     the WebAuthn assertion's challenge is checked to be the digest (the authenticator's signature
 *                  itself is not re-verified offline; Atlas verified it before signing the receipt);
 *  - `number_match` the approver answered on their own device by matching the number; there is no signature.
 */

export const APPROVAL_RECEIPT_TYP = 'atlas-approval-receipt+jws';
export const APPROVAL_DECISION_TYP = 'atlas-approval-decision+jws';

export interface ApprovalReceiptApproval {
  approver_user_id: string;
  method: 'device_key' | 'passkey' | 'number_match';
  key_id: string | null;
  public_key: unknown;
  proof: Record<string, unknown>;
  signed_at: number;
}

export interface ApprovalReceiptClaims {
  v: 1;
  iss: string;
  iat: number;
  jti: string;
  instance_id: string;
  subject_user_id: string;
  status: 'approved';
  digest: string;
  canonical: string;
  binding: string | null;
  reference: string | null;
  required_approvals: number;
  approved_at: number;
  approvals: ApprovalReceiptApproval[];
}

export type ApproverProof = 'verified' | 'challenge_bound' | 'none';

export interface VerifiedApprovalReceipt {
  claims: ApprovalReceiptClaims;
  /** What each approver's evidence amounts to. */
  approvers: Array<{ approver_user_id: string; method: ApprovalReceiptApproval['method']; proof: ApproverProof }>;
}

export interface VerifyApprovalReceiptOptions {
  /** The instance's public keys. */
  jwks: JSONWebKeySet;
  /** Require this issuer (the instance's Frontend API origin). */
  issuer?: string;
  /** Require the receipt to be for this approval request id. */
  approvalId?: string;
  /** Require the receipt's binding to equal this. */
  binding?: string;
  /** Reject a receipt older than this many seconds (by `approved_at`). */
  maxAgeSeconds?: number;
  /** Reject an approval whose approvers have no signature (number-match only). Default true. */
  requireSignatures?: boolean;
  /** Epoch ms; default now. */
  now?: number;
}

export class ApprovalReceiptError extends Error {
  override readonly name = 'ApprovalReceiptError';
  constructor(readonly reason: string, message?: string) {
    super(message ?? `Invalid approval receipt: ${reason}.`);
  }
}

const b64u = (bytes: ArrayBuffer): string => {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

/** SHA-256 of the canonical text, base64url: the value approvers sign. */
export async function approvalDigest(canonical: string): Promise<string> {
  return b64u(await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical)));
}

const fail = (reason: string, message?: string): never => {
  throw new ApprovalReceiptError(reason, message);
};

export async function verifyApprovalReceipt(receipt: string, opts: VerifyApprovalReceiptOptions): Promise<VerifiedApprovalReceipt> {
  let claims: ApprovalReceiptClaims;
  try {
    const header = decodeProtectedHeader(receipt);
    if (header.typ !== APPROVAL_RECEIPT_TYP) return fail('wrong_type');
    const { payload } = await compactVerify(receipt, createLocalJWKSet(opts.jwks), { algorithms: ['ES256', 'RS256'] });
    claims = JSON.parse(new TextDecoder().decode(payload)) as ApprovalReceiptClaims;
  } catch (e) {
    if (e instanceof ApprovalReceiptError) throw e;
    return fail('bad_signature', 'The receipt signature does not verify against the instance keys.');
  }
  if (claims.v !== 1 || claims.status !== 'approved') return fail('unsupported');
  if (opts.issuer && claims.iss !== opts.issuer) return fail('wrong_issuer');
  if (opts.approvalId && claims.jti !== opts.approvalId) return fail('wrong_request');
  if (opts.binding !== undefined && claims.binding !== opts.binding) return fail('wrong_binding');
  if (opts.maxAgeSeconds !== undefined && (opts.now ?? Date.now()) - claims.approved_at > opts.maxAgeSeconds * 1000) return fail('too_old');

  // The canonical text must be the one the digest covers, and it must describe this very request.
  if ((await approvalDigest(claims.canonical)) !== claims.digest) return fail('digest_mismatch');
  let canonical: { id?: string; instance?: string; approvers?: { mode?: string; user_ids?: string[]; required?: number }; binding?: string | null };
  try {
    canonical = JSON.parse(claims.canonical);
  } catch {
    return fail('bad_canonical');
  }
  if (canonical.id !== claims.jti || canonical.instance !== claims.instance_id) return fail('canonical_mismatch');
  if ((canonical.binding ?? null) !== (claims.binding ?? null)) return fail('canonical_mismatch');
  const required = canonical.approvers?.required ?? 1;
  if (claims.required_approvals !== required) return fail('canonical_mismatch');

  const seen = new Set<string>();
  const approvers: VerifiedApprovalReceipt['approvers'] = [];
  for (const a of claims.approvals) {
    if (seen.has(a.approver_user_id)) return fail('duplicate_approver');
    seen.add(a.approver_user_id);
    if (canonical.approvers?.mode === 'users' && !(canonical.approvers.user_ids ?? []).includes(a.approver_user_id)) return fail('unnamed_approver');
    approvers.push({ approver_user_id: a.approver_user_id, method: a.method, proof: await checkProof(a, claims) });
  }
  if (approvers.length < required) return fail('quorum_not_met');
  if ((opts.requireSignatures ?? true) && approvers.some((a) => a.proof === 'none')) return fail('unsigned_approver', 'An approver answered without a signature.');
  return { claims, approvers };
}

async function checkProof(a: ApprovalReceiptApproval, claims: ApprovalReceiptClaims): Promise<ApproverProof> {
  if (a.method === 'number_match') return 'none';
  if (a.method === 'device_key') {
    const jws = a.proof?.jws;
    if (typeof jws !== 'string' || !a.public_key) return fail('bad_proof', 'A device-key approval carries no signature.');
    try {
      if (decodeProtectedHeader(jws).typ !== APPROVAL_DECISION_TYP) return fail('bad_proof');
      const { payload } = await compactVerify(jws, await importJWK(a.public_key as JWK, 'ES256'), { algorithms: ['ES256'] });
      const p = JSON.parse(new TextDecoder().decode(payload)) as { approval_id?: string; digest?: string; decision?: string };
      if (p.approval_id !== claims.jti || p.digest !== claims.digest || p.decision !== 'approve') return fail('bad_proof', 'An approver signature does not cover this request.');
    } catch (e) {
      if (e instanceof ApprovalReceiptError) throw e;
      return fail('bad_proof', 'An approver signature does not verify.');
    }
    return 'verified';
  }
  const cd = a.proof?.client_data_json;
  if (typeof cd !== 'string') return fail('bad_proof', 'A passkey approval carries no assertion.');
  try {
    const raw = atob(cd.replace(/-/g, '+').replace(/_/g, '/'));
    const data = JSON.parse(raw) as { type?: string; challenge?: string };
    if (data.type !== 'webauthn.get' || data.challenge !== claims.digest) return fail('bad_proof', 'A passkey assertion does not cover this request.');
  } catch (e) {
    if (e instanceof ApprovalReceiptError) throw e;
    return fail('bad_proof', 'A passkey assertion could not be read.');
  }
  return 'challenge_bound';
}
