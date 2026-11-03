import { describe, expect, it, vi } from 'vitest';
import { FapiClient } from './fapi';
import { AuthorizedAppsError, disconnectAuthorizedApp, listAuthorizedApps, revokeAppGrant } from './authorized-apps';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function clientWith(handler: (url: string, init: RequestInit) => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    return handler(String(input), init);
  }) as unknown as typeof fetch;
  return { client: new FapiClient({ publishableKey: 'pk_test_x', baseUrl: 'https://fapi.example', fetchImpl }), calls };
}

describe('authorized apps client', () => {
  it('lists apps with their grants, tolerating a server without grants', async () => {
    const { client, calls } = clientWith(() =>
      json(200, { object: 'list', data: [{ object: 'oauth_grant', id: 'c1', name: 'A', scopes: ['openid'], grants: [{ id: 'gnt_1', scopes: ['openid'], resource: null, created_at: 1, updated_at: 1 }] }, { object: 'oauth_grant', id: 'c2', name: 'B', scopes: [] }] }),
    );
    const apps = await listAuthorizedApps(client);
    expect(calls[0]!.url).toBe('https://fapi.example/v1/client/me/oauth_grants');
    expect(calls[0]!.init.credentials).toBe('include');
    expect(apps[0]!.grants[0]!.id).toBe('gnt_1');
    expect(apps[1]!.grants).toEqual([]);
  });

  it('withdraws one grant and reports the tokens that ended', async () => {
    const { client, calls } = clientWith(() => json(200, { object: 'managed_grant', id: 'gnt_1', deleted: true, tokens_ended: 2 }));
    expect(await revokeAppGrant(client, 'gnt_1')).toEqual({ tokensEnded: 2 });
    expect(calls[0]!.url).toBe('https://fapi.example/v1/client/me/managed_grants/gnt_1');
    expect(calls[0]!.init.method).toBe('DELETE');
  });

  it('disconnects an app by consent id and surfaces the server error', async () => {
    const { client, calls } = clientWith(() => json(404, { errors: [{ code: 'NOT_FOUND', message: 'Unknown authorized app.' }] }));
    await expect(disconnectAuthorizedApp(client, 'c9')).rejects.toMatchObject({ name: 'AuthorizedAppsError', status: 404, code: 'NOT_FOUND' });
    expect(calls[0]!.url).toBe('https://fapi.example/v1/client/me/oauth_grants/c9');
    expect(new AuthorizedAppsError(400, 'X', 'm').code).toBe('X');
  });
});
