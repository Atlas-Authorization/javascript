import { describe, expect, it } from 'vitest';
import { createAtlasClient } from './index';

function client() {
  const seen: Array<{ url: string; method: string; body?: string }> = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    seen.push({ url, method: init.method ?? 'GET', body: init.body as string | undefined });
    return new Response(JSON.stringify({ object: 'approval_request', id: 'appr_1' }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { atlas: createAtlasClient({ secretKey: 'sk_test_x', apiUrl: 'https://api.test', fetch: fetchFn }), seen };
}

describe('approvals resource', () => {
  it('maps every operation to its route', async () => {
    const { atlas, seen } = client();
    await atlas.approvals.create({ user_id: 'u', description: 'd', ttl_seconds: 30 });
    await atlas.approvals.list({ status: 'pending', limit: 5 });
    await atlas.approvals.get('appr_1', { waitSeconds: 10 });
    await atlas.approvals.consume('appr_1', { binding: 'b' });
    await atlas.approvals.cancel('appr_1');
    await atlas.approvals.listDevices('user_1');
    await atlas.approvals.trustDevice('user_1', { kind: 'device_key', ref: 'apprk_1', label: 'Laptop' });
    await atlas.approvals.revokeDevice('user_1', 'apprtd_1');
    expect(seen.map((s) => `${s.method} ${new URL(s.url).pathname}`)).toEqual([
      'POST /v1/approval_requests',
      'GET /v1/approval_requests',
      'GET /v1/approval_requests/appr_1',
      'POST /v1/approval_requests/appr_1/consume',
      'POST /v1/approval_requests/appr_1/cancel',
      'GET /v1/users/user_1/approval_devices',
      'POST /v1/users/user_1/approval_devices/trust',
      'DELETE /v1/users/user_1/approval_devices/apprtd_1',
    ]);
    expect(JSON.parse(seen[6]!.body!)).toEqual({ kind: 'device_key', ref: 'apprk_1', label: 'Laptop' });
    expect(new URL(seen[1]!.url).search).toContain('status=pending');
    expect(new URL(seen[2]!.url).search).toContain('wait_seconds=10');
    expect(JSON.parse(seen[3]!.body!)).toEqual({ binding: 'b' });
  });
});
