import { describe, expect, it, vi } from 'vitest';
import { FapiClient } from './fapi';
import {
  ConnectionRequestError,
  connectMyConnection,
  connectionsNeedingReconnect,
  createReconnectController,
  type AppConnection,
  connectOrganizationConnection,
  deleteOrganizationOAuthClient,
  listMyConnections,
  listOrganizationConnections,
  revokeOrganizationConnection,
  setOrganizationConnectionCredentials,
  setOrganizationOAuthClient,
  shareOrganizationConnection,
} from './connections';
import { reauthorizeExternalAccount } from './connect';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
function clientWith(handler: (url: string, init: RequestInit) => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    return handler(String(input), init);
  }) as unknown as typeof fetch;
  return { client: new FapiClient({ publishableKey: 'pk_test_x', baseUrl: 'https://fapi.example', fetchImpl }), calls, fetchImpl };
}

describe('connected accounts client', () => {
  it('lists the user\'s and the organization\'s connections', async () => {
    const { client, calls } = clientWith(() => json(200, { object: 'list', data: [{ id: 'cnx_1', status: 'connected' }] }));
    expect(await listMyConnections(client)).toHaveLength(1);
    expect(await listOrganizationConnections(client, 'org 1')).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://fapi.example/v1/client/me/connections');
    expect(calls[1]!.url).toBe('https://fapi.example/v1/client/organizations/org%201/connections');
  });

  it('enters a credential and shares an account', async () => {
    const { client, calls } = clientWith(() => json(200, { id: 'cnx_1', status: 'connected' }));
    await setOrganizationConnectionCredentials(client, 'org_1', 'cnx_1', { apiKey: 'k' });
    expect(calls[0]!.init.method).toBe('PUT');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ api_key: 'k' });
    await shareOrganizationConnection(client, 'org_1', 'cnx_1');
    expect(calls[1]!.url).toBe('https://fapi.example/v1/client/organizations/org_1/connections/cnx_1/share');
  });

  it('writes typed credentials (basic, signing key, OAuth 1.0a) with an expiry; there is no read', async () => {
    const { client, calls } = clientWith(() => json(200, { id: 'cnx_1', status: 'connected', has_secret: true, secret_expires_at: 1900000000000 }));
    const out = await setOrganizationConnectionCredentials(client, 'org_1', 'cnx_1', { username: 'u', password: 'p', consumerKey: 'ck', consumerSecret: 'cs', tokenSecret: 'ts', privateKey: 'PEM', expiresAt: 1900000000000, config: { realm: 'r' } });
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ username: 'u', password: 'p', consumer_key: 'ck', consumer_secret: 'cs', token_secret: 'ts', private_key: 'PEM', expires_at: 1900000000000, config: { realm: 'r' } });
    expect(out.secret_expires_at).toBe(1900000000000);
    expect(JSON.stringify(out)).not.toContain('"u"');
  });

  it('connects a connection with host params and sends no sign-in step', async () => {
    const { client, calls } = clientWith(() => json(200, { object: 'connection_authorization', connection_id: 'cnx_1', authorization_url: 'https://accounts.zoho.eu/oauth/v2/auth', attempt_id: 'cna_1' }));
    const out = await connectMyConnection(client, 'cnx 1', { redirectUrl: 'https://app.example/done', hostParams: { data_center: 'eu' }, createIfNew: true });
    expect(out.authorization_url).toContain('zoho.eu');
    expect(calls[0]!.url).toBe('https://fapi.example/v1/client/me/connections/cnx%201/connect');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ redirect_url: 'https://app.example/done', host_params: { data_center: 'eu' }, create_if_new: true });
    await connectOrganizationConnection(client, 'org_1', 'cnx_1', { redirectUrl: 'https://app.example/done', display: 'popup' });
    expect(calls[1]!.url).toBe('https://fapi.example/v1/client/organizations/org_1/connections/cnx_1/connect');
    await revokeOrganizationConnection(client, 'org_1', 'cnx_1');
    expect(calls[2]!.url).toBe('https://fapi.example/v1/client/organizations/org_1/connections/cnx_1/revoke');
  });

  it('sets and deletes the organization\'s own OAuth client', async () => {
    const { client, calls } = clientWith((url, init) => (init.method === 'DELETE' ? new Response(null, { status: 204 }) : json(200, { object: 'connection_oauth_client', id: 'cnc_1' })));
    await setOrganizationOAuthClient(client, 'org_1', { provider: 'salesforce', clientId: 'cid', clientSecret: 'sec', environment: 'sandbox' });
    expect(calls[0]!.url).toBe('https://fapi.example/v1/client/organizations/org_1/connection_oauth_clients');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ provider: 'salesforce', environment: 'sandbox', client_id: 'cid', client_secret: 'sec' });
    await deleteOrganizationOAuthClient(client, 'org_1', 'cnc_1');
    expect(calls[1]!.init.method).toBe('DELETE');
  });

  it('throws the server error', async () => {
    const { client } = clientWith(() => json(403, { errors: [{ code: 'FORBIDDEN', message: 'no' }] }));
    await expect(listOrganizationConnections(client, 'org_1')).rejects.toBeInstanceOf(ConnectionRequestError);
  });

  it('reauthorizes a linked account', async () => {
    const { fetchImpl } = clientWith(() => json(201, { provider: 'github', attempt_id: 'a', authorization_url: 'https://github.com/login', scopes: ['repo'] }));
    const out = await reauthorizeExternalAccount('eac_1', { api: 'https://fapi.example', publishableKey: 'pk', redirectUrl: 'https://app.example/back', fetchImpl });
    expect(out.authorizationUrl).toBe('https://github.com/login');
    expect(String((fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![0])).toBe('https://fapi.example/v1/client/me/external_accounts/eac_1/reauthorize');
  });
});

describe('reconnect controller', () => {
  it('fetches the consent link for the user\'s or the organization\'s connection and opens it', async () => {
    const { client, calls } = clientWith(() => json(200, { object: 'connection_authorization', connection_id: 'cnx_1', authorization_url: 'https://provider.example/consent?x=1', attempt_id: 'a1' }));
    const opened: string[] = [];
    const mine = createReconnectController(client, { redirectUrl: 'https://app.example/back', open: (u) => opened.push(u) });
    expect((await mine.reconnect('cnx_1')).attempt_id).toBe('a1');
    const org = createReconnectController(client, { redirectUrl: 'https://app.example/back', organizationId: 'org_1', open: (u) => opened.push(u) });
    await org.link('cnx_2');
    expect(opened).toEqual(['https://provider.example/consent?x=1']);
    expect(calls[0]!.url).toBe('https://fapi.example/v1/client/me/connections/cnx_1/connect');
    expect(calls[1]!.url).toBe('https://fapi.example/v1/client/organizations/org_1/connections/cnx_2/connect');
    expect(JSON.parse(String(calls[0]!.init.body)).redirect_url).toBe('https://app.example/back');
  });

  it('opens nothing when the link cannot be fetched', async () => {
    const { client } = clientWith(() => json(409, { errors: [{ code: 'CONFLICT', message: 'no' }] }));
    const opened: string[] = [];
    await expect(createReconnectController(client, { redirectUrl: 'https://app.example/b', open: (u) => opened.push(u) }).reconnect('cnx_1')).rejects.toBeInstanceOf(ConnectionRequestError);
    expect(opened).toEqual([]);
  });

  it('picks only oauth connections that need authorizing again', () => {
    const list = [
      { id: 'a', kind: 'oauth', status: 'needs_reauth' },
      { id: 'b', kind: 'oauth', status: 'connected' },
      { id: 'c', kind: 'api_key', status: 'needs_reauth' },
    ] as AppConnection[];
    expect(connectionsNeedingReconnect(list).map((c) => c.id)).toEqual(['a']);
  });
});
