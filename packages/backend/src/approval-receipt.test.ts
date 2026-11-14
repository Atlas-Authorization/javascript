import { describe, expect, it } from 'vitest';
import { CompactSign, SignJWT, exportJWK, generateKeyPair } from 'jose';
import { APPROVAL_DECISION_TYP, APPROVAL_RECEIPT_TYP, ApprovalReceiptError, approvalDigest, verifyApprovalReceipt } from './approval-receipt';

const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));

async function fixture(over: { tamperDigest?: boolean; method?: 'device_key' | 'number_match'; users?: string[]; required?: number; decisionDigest?: string } = {}) {
  const instance = await generateKeyPair('ES256');
  const device = await generateKeyPair('ES256');
  const jwks = { keys: [{ ...(await exportJWK(instance.publicKey)), kid: 'k1', alg: 'ES256', use: 'sig' }] };
  const canonical = JSON.stringify({ approvers: { mode: 'users', required: over.required ?? 1, user_ids: over.users ?? ['user_a'] }, binding: 'b1', id: 'appr_1', instance: 'ins_1', v: 1 });
  const digest = await approvalDigest(canonical);
  const decision = await new CompactSign(enc({ approval_id: 'appr_1', digest: over.decisionDigest ?? digest, decision: 'approve', iat: 1 }))
    .setProtectedHeader({ alg: 'ES256', typ: APPROVAL_DECISION_TYP }).sign(device.privateKey);
  const claims = {
    v: 1, iss: 'https://fapi.test', iat: 1, jti: 'appr_1', instance_id: 'ins_1', subject_user_id: 'user_s', status: 'approved',
    digest: over.tamperDigest ? 'x' : digest, canonical, binding: 'b1', reference: null, required_approvals: over.required ?? 1, approved_at: Date.now(),
    approvals: [{ approver_user_id: 'user_a', method: over.method ?? 'device_key', key_id: 'apprk_1', public_key: await exportJWK(device.publicKey), proof: { jws: decision }, signed_at: 1 }],
  };
  const receipt = await new CompactSign(enc(claims)).setProtectedHeader({ alg: 'ES256', kid: 'k1', typ: APPROVAL_RECEIPT_TYP }).sign(instance.privateKey);
  return { receipt, jwks };
}

describe('verifyApprovalReceipt', () => {
  it('accepts a well-formed receipt and reports the approver proof', async () => {
    const { receipt, jwks } = await fixture();
    const out = await verifyApprovalReceipt(receipt, { jwks, issuer: 'https://fapi.test', approvalId: 'appr_1', binding: 'b1' });
    expect(out.approvers).toEqual([{ approver_user_id: 'user_a', method: 'device_key', proof: 'verified' }]);
  });

  it('rejects another instance key, another request, a wrong binding and a stale receipt', async () => {
    const { receipt, jwks } = await fixture();
    const other = await fixture();
    await expect(verifyApprovalReceipt(receipt, { jwks: other.jwks })).rejects.toBeInstanceOf(ApprovalReceiptError);
    await expect(verifyApprovalReceipt(receipt, { jwks, approvalId: 'appr_2' })).rejects.toMatchObject({ reason: 'wrong_request' });
    await expect(verifyApprovalReceipt(receipt, { jwks, binding: 'other' })).rejects.toMatchObject({ reason: 'wrong_binding' });
    await expect(verifyApprovalReceipt(receipt, { jwks, maxAgeSeconds: 1, now: Date.now() + 5000 })).rejects.toMatchObject({ reason: 'too_old' });
  });

  it('rejects a digest that does not match the canonical request', async () => {
    const { receipt, jwks } = await fixture({ tamperDigest: true });
    await expect(verifyApprovalReceipt(receipt, { jwks })).rejects.toMatchObject({ reason: 'digest_mismatch' });
  });

  it('rejects an approver signature that covers a different request', async () => {
    const { receipt, jwks } = await fixture({ decisionDigest: 'something-else' });
    await expect(verifyApprovalReceipt(receipt, { jwks })).rejects.toMatchObject({ reason: 'bad_proof' });
  });

  it('requires a signature by default and the quorum', async () => {
    const unsigned = await fixture({ method: 'number_match' });
    await expect(verifyApprovalReceipt(unsigned.receipt, { jwks: unsigned.jwks })).rejects.toMatchObject({ reason: 'unsigned_approver' });
    await expect(verifyApprovalReceipt(unsigned.receipt, { jwks: unsigned.jwks, requireSignatures: false })).resolves.toBeTruthy();
    const short = await fixture({ required: 2, users: ['user_a', 'user_b'] });
    await expect(verifyApprovalReceipt(short.receipt, { jwks: short.jwks })).rejects.toMatchObject({ reason: 'quorum_not_met' });
  });

  it('rejects a plain JWT that is not a receipt', async () => {
    const k = await generateKeyPair('ES256');
    const jwt = await new SignJWT({}).setProtectedHeader({ alg: 'ES256', kid: 'k1' }).sign(k.privateKey);
    await expect(verifyApprovalReceipt(jwt, { jwks: { keys: [] } })).rejects.toMatchObject({ reason: 'wrong_type' });
  });
});
