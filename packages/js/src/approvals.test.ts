import { describe, expect, it } from 'vitest';
import { FapiClient } from './fapi';
import { approveRequest, denyRequest, generateApprovalKey, getApproval, listApprovalDevices, listApprovals, registerApprovalKey, revokeApprovalDeviceTrust, trustApprovalDevice } from './approvals';

function setup(body: unknown, status = 200) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { client: new FapiClient({ publishableKey: 'pk_test_x', baseUrl: 'https://fapi.example', fetchImpl }), calls };
}

const wire = { id: 'appr_1', status: 'pending', description: 'Wire', context: null, user_id: 'user_1', approvers: { mode: 'users', user_ids: ['user_a'], organization_id: null, role: null, required: 1 }, canonical: '{}', digest: 'dg', signature_required: true, expires_at: 9, created_at: 1 };
const b64uJson = (s: string) => JSON.parse(atob(s.replace(/-/g, '+').replace(/_/g, '/')));

describe('approvals (approver side)', () => {
  it('lists and reads requests', async () => {
    const list = setup({ data: [wire] });
    expect((await listApprovals(list.client))[0]).toMatchObject({ id: 'appr_1', digest: 'dg', signatureRequired: true, approvers: { userIds: ['user_a'] } });
    const one = setup(wire);
    expect(await getApproval(one.client, 'appr_1')).toMatchObject({ id: 'appr_1' });
    expect(one.calls[0]!.url).toBe('https://fapi.example/v1/client/me/approvals/appr_1');
    expect(await getApproval(setup({ errors: [] }, 404).client, 'x')).toBeNull();
  });

  it('signs the digest with the device key and posts the decision', async () => {
    const key = await generateApprovalKey();
    const { client, calls } = setup({ status: 'pending', approvals_received: 1, required: 2 });
    const { result } = await approveRequest(client, { id: 'appr_1', digest: 'dg' }, { ...key, keyId: 'apprk_1' });
    expect(result).toEqual({ status: 'pending', approvalsReceived: 1, required: 2 });
    const body = JSON.parse(String(calls[0]!.init?.body));
    expect(body.signature.type).toBe('device_key');
    const [h, p, s] = body.signature.jws.split('.');
    expect(b64uJson(h)).toMatchObject({ alg: 'ES256', typ: 'atlas-approval-decision+jws', kid: 'apprk_1' });
    expect(b64uJson(p)).toMatchObject({ approval_id: 'appr_1', digest: 'dg', decision: 'approve' });
    expect(s.length).toBeGreaterThan(40);
  });

  it('registers a key with a proof of possession and denies without a signature', async () => {
    const key = await generateApprovalKey();
    const reg = setup({ id: 'apprk_1', thumbprint: 't' }, 201);
    await registerApprovalKey(reg.client, key, { userId: 'user_a', label: 'Phone' });
    const sent = JSON.parse(String(reg.calls[0]!.init?.body));
    expect(sent.public_jwk).toMatchObject({ kty: 'EC', crv: 'P-256' });
    expect(b64uJson(sent.proof_jws.split('.')[1])).toMatchObject({ user_id: 'user_a', purpose: 'register_approval_key' });
    const d = setup({ status: 'denied', approvals_received: 0, required: 1 });
    await denyRequest(d.client, 'appr_1');
    expect(JSON.parse(String(d.calls[0]!.init?.body))).toEqual({ decision: 'deny' });
  });

  it('lists, trusts and revokes trusted devices', async () => {
    const list = setup({ data: [{ kind: 'device_key', ref: 'apprk_1', label: 'Phone', trusted: true, trusted_device_id: 'apprtd_1' }] });
    expect(await listApprovalDevices(list.client)).toEqual([{ kind: 'device_key', ref: 'apprk_1', label: 'Phone', trusted: true, trustedDeviceId: 'apprtd_1' }]);
    expect(list.calls[0]!.url).toBe('https://fapi.example/v1/client/me/approval_devices');
    const trust = setup({ kind: 'device_key', ref: 'apprk_1', trusted: true }, 201);
    await trustApprovalDevice(trust.client, { kind: 'device_key', ref: 'apprk_1' }, { label: 'Phone' });
    expect(trust.calls[0]!.url).toBe('https://fapi.example/v1/client/me/approval_devices/trust');
    expect(JSON.parse(String(trust.calls[0]!.init?.body))).toEqual({ kind: 'device_key', ref: 'apprk_1', label: 'Phone' });
    const revoke = setup({ revoked: true });
    await revokeApprovalDeviceTrust(revoke.client, 'apprtd_1');
    expect(revoke.calls[0]!.init?.method).toBe('DELETE');
    expect(revoke.calls[0]!.url).toBe('https://fapi.example/v1/client/me/approval_devices/apprtd_1');
  });
});
