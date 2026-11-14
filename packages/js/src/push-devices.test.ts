import { describe, expect, it } from 'vitest';
import { FapiClient } from './fapi';
import { listPushDevices, registerApprovalDevice, removePushDevice, respondToPushDevice } from './push-devices';

function setup(body: unknown, status = 200) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { client: new FapiClient({ publishableKey: 'pk_test_x', baseUrl: 'https://fapi.example', fetchImpl }), calls };
}

describe('push devices', () => {
  it('registers an approvals-only device and returns the number to show', async () => {
    const { client, calls } = setup({ id: 'pd_1', platform: 'expo', label: null, purpose: 'approvals', verified: false, created_at: 1, last_seen_at: null, challenge_id: 'c1', number_match: '42', expires_at: 9 }, 201);
    const { pending } = await registerApprovalDevice(client, { deviceToken: 'ExponentPushToken[abc]', platform: 'expo' });
    expect(pending).toMatchObject({ challengeId: 'c1', number: '42', device: { id: 'pd_1', purpose: 'approvals' } });
    expect(calls[0]!.url).toBe('https://fapi.example/v1/client/me/push_devices');
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ device_token: 'ExponentPushToken[abc]', platform: 'expo' });
  });

  it('confirms, lists and removes', async () => {
    const yes = setup({ status: 'approved', verified: true });
    await respondToPushDevice(yes.client, { challengeId: 'c1', number: '42' });
    expect(yes.calls[0]!.url).toBe('https://fapi.example/v1/client/me/push_devices/challenges/c1/respond');
    expect(JSON.parse(String(yes.calls[0]!.init?.body))).toEqual({ action: 'approve', selected_number: '42' });
    const list = setup({ data: [{ id: 'pd_1', platform: 'apns', label: 'Phone', purpose: 'approvals', verified: true, created_at: 1, last_seen_at: null }] });
    expect(await listPushDevices(list.client)).toEqual([{ id: 'pd_1', platform: 'apns', label: 'Phone', purpose: 'approvals', verified: true, createdAt: 1, lastSeenAt: null }]);
    const del = setup({ deleted: true });
    await removePushDevice(del.client, 'pd_1');
    expect(del.calls[0]!.init?.method).toBe('DELETE');
  });
});
