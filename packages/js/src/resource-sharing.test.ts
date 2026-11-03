import { describe, expect, it } from 'vitest';
import type { FapiClient } from './fapi';
import { getRoleMatrix, listResourceShares, listShareableResources, shareResource, unshareResource } from './resource-sharing';

function fake() {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const ok = (data: unknown) => ({ ok: true, status: 200, data, errors: [] });
  const client = {
    get: async (path: string) => (calls.push({ method: 'GET', path }), ok(path.includes('shareable') ? { data: [{ id: 'res_1' }] } : { object: 'x' })),
    post: async (path: string, body: unknown) => (calls.push({ method: 'POST', path, body }), ok({ id: 'share_1' })),
    request: async (path: string, init: { method: string }) => (calls.push({ method: init.method, path }), ok({ id: 's', deleted: true })),
  } as unknown as FapiClient;
  return { client, calls };
}

describe('resource sharing client', () => {
  it('addresses the org-scoped routes and encodes ids', async () => {
    const { client, calls } = fake();
    expect(await listShareableResources(client, 'org 1', { type: 'doc', limit: 10 })).toEqual({ ok: true, data: [{ id: 'res_1' }] });
    await listResourceShares(client, 'org_1', 'res/1');
    await shareResource(client, 'org_1', 'res_1', { userId: 'user_2', role: 'editor' });
    await unshareResource(client, 'org_1', 'res_1', 'share_1');
    await getRoleMatrix(client, 'org_1', 'doc');
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET /v1/client/organizations/org%201/shareable_resources?type=doc&limit=10',
      'GET /v1/client/organizations/org_1/resources/res%2F1/shares',
      'POST /v1/client/organizations/org_1/resources/res_1/shares',
      'DELETE /v1/client/organizations/org_1/resources/res_1/shares/share_1',
      'GET /v1/client/organizations/org_1/resource_types/doc',
    ]);
    expect(calls[2]!.body).toEqual({ user_id: 'user_2', role: 'editor' });
  });
});
