import { describe, expect, it } from 'vitest';
import { UmaError, decideUmaAccessRequest, listUmaAccessRequests, listUmaResources, parseUmaClaimsRedirect, shareUmaResource, umaClaimsUrl, unshareUmaResource } from './uma';
import type { FapiClient } from './fapi';

function fake(reply: (path: string, init: RequestInit) => { ok: boolean; status: number; data?: unknown; errors?: Array<{ code: string; message: string }> }) {
  const calls: Array<{ path: string; init: RequestInit }> = [];
  const client = { request: async (path: string, init: RequestInit) => { calls.push({ path, init }); const r = reply(path, init); return { errors: [], ...r }; } } as unknown as FapiClient;
  return { client, calls };
}

describe('owner calls', () => {
  it('list resources and requests, share, unshare and decide on the right routes', async () => {
    const f = fake(() => ({ ok: true, status: 200, data: { data: [{ id: 'x' }] } }));
    expect(await listUmaResources(f.client)).toEqual([{ id: 'x' }]);
    expect(await listUmaAccessRequests(f.client, 'pending')).toEqual([{ id: 'x' }]);
    await shareUmaResource(f.client, 'umar 1', { email: 'a@b.co' }, ['view']);
    await unshareUmaResource(f.client, 'umar 1', { type: 'user', id: 'u/1' });
    await decideUmaAccessRequest(f.client, 'umarq_1', 'approve', ['view']);
    expect(f.calls.map((c) => `${c.init.method} ${c.path}`)).toEqual([
      'GET /v1/client/me/uma/resources',
      'GET /v1/client/me/uma/requests?status=pending',
      'PUT /v1/client/me/uma/resources/umar%201/policies',
      'DELETE /v1/client/me/uma/resources/umar%201/policies/user/u%2F1',
      'POST /v1/client/me/uma/requests/umarq_1/decision',
    ]);
    expect(JSON.parse(String(f.calls[2]!.init.body))).toEqual({ email: 'a@b.co', scopes: ['view'] });
    expect(JSON.parse(String(f.calls[4]!.init.body))).toEqual({ decision: 'approve', scopes: ['view'] });
  });

  it('throws a typed error carrying the server code', async () => {
    const f = fake(() => ({ ok: false, status: 409, errors: [{ code: 'already_decided', message: 'done' }] }));
    await expect(decideUmaAccessRequest(f.client, 'r', 'deny')).rejects.toMatchObject({ status: 409, code: 'already_decided' });
    await expect(decideUmaAccessRequest(f.client, 'r', 'deny')).rejects.toBeInstanceOf(UmaError);
  });
});

describe('claims gathering helpers', () => {
  it('builds the interaction URL and reads the redirect back', () => {
    const url = umaClaimsUrl('https://auth.example.com/oauth2/uma/claims', { clientId: 'c', ticket: 't', claimsRedirectUri: 'https://app.example.com/cb', state: 's' });
    expect(new URL(url).searchParams.get('claims_redirect_uri')).toBe('https://app.example.com/cb');
    expect(parseUmaClaimsRedirect('https://app.example.com/cb?ticket=t2&state=s')).toEqual({ ticket: 't2', error: undefined, state: 's' });
    expect(parseUmaClaimsRedirect('https://app.example.com/cb?error=access_denied')).toMatchObject({ error: 'access_denied' });
  });
});
