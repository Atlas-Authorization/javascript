import { describe, expect, it, vi } from 'vitest';
import { createAtlasClient } from './index';

const SECRET = 'sk_test_placeholder_not_a_real_key';
const API_URL = 'https://api.example.test';

function mockFetch(responses: Array<{ status?: number; body?: unknown }>) {
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body?: string }> =
    [];
  let i = 0;
  const impl = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const spec = responses[Math.min(i, responses.length - 1)];
    i += 1;
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(init?.headers ?? {})) headers[k.toLowerCase()] = v as string;
    calls.push({
      url: String(url),
      method: init?.method ?? 'GET',
      headers,
      body: init?.body as string | undefined,
    });
    const status = spec?.status ?? 200;
    return new Response(spec?.body === undefined ? '' : JSON.stringify(spec.body), { status });
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

function setup(body: unknown = { ok: true }) {
  const { impl, calls } = mockFetch([{ body }]);
  const atlas = createAtlasClient({ secretKey: SECRET, apiUrl: API_URL, fetch: impl });
  const last = () => {
    const c = calls[calls.length - 1]!;
    return { ...c, json: c.body ? JSON.parse(c.body) : undefined };
  };
  return { atlas, last };
}

describe('mcp + mcpConnector', () => {
  it('describes the server', async () => {
    const { atlas, last } = setup({ object: 'mcp_server', tools: [] });
    const res = await atlas.mcp.describe();
    expect(last().method).toBe('GET');
    expect(last().url).toBe(`${API_URL}/v1/mcp`);
    expect(res.object).toBe('mcp_server');
  });

  it('sends JSON-RPC envelopes', async () => {
    const { atlas, last } = setup({ jsonrpc: '2.0', id: 7, result: {} });
    await atlas.mcp.rpc('ping', undefined, 7);
    expect(last().method).toBe('POST');
    expect(last().url).toBe(`${API_URL}/v1/mcp`);
    expect(last().json).toEqual({ jsonrpc: '2.0', id: 7, method: 'ping' });

    await atlas.mcp.listTools();
    expect(last().json).toMatchObject({ jsonrpc: '2.0', method: 'tools/list' });

    await atlas.mcp.callTool('users.get', { id: 'user_1' });
    expect(last().json).toMatchObject({
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: 'users.get', arguments: { id: 'user_1' } },
    });
  });

  it('reads, updates and disables the connector', async () => {
    const { atlas, last } = setup({ object: 'mcp_connector', enabled: true });
    await atlas.mcpConnector.get();
    expect(last().method).toBe('GET');
    expect(last().url).toBe(`${API_URL}/v1/mcp_connector`);

    await atlas.mcpConnector.update({ enabled: true, exposed_scopes: ['profile', 'email'] }, 'idem-1');
    expect(last().method).toBe('PUT');
    expect(last().url).toBe(`${API_URL}/v1/mcp_connector`);
    expect(last().json).toEqual({ enabled: true, exposed_scopes: ['profile', 'email'] });
    expect(last().headers['idempotency-key']).toBe('idem-1');

    await atlas.mcpConnector.disable();
    expect(last().method).toBe('DELETE');
    expect(last().url).toBe(`${API_URL}/v1/mcp_connector`);
  });
});

describe('legacyAuthConnection', () => {
  it('gets, sets and deletes', async () => {
    const { atlas, last } = setup({ object: 'legacy_auth_connection', configured: false });
    const got = await atlas.legacyAuthConnection.get();
    expect(last().method).toBe('GET');
    expect(last().url).toBe(`${API_URL}/v1/legacy_auth_connection`);
    expect(got.configured).toBe(false);

    await atlas.legacyAuthConnection.set({
      verify_url: 'https://legacy.example.com/verify',
      signing_secret: 's3cret',
      enabled: true,
    });
    expect(last().method).toBe('PUT');
    expect(last().json).toEqual({
      verify_url: 'https://legacy.example.com/verify',
      signing_secret: 's3cret',
      enabled: true,
    });

    await atlas.legacyAuthConnection.delete();
    expect(last().method).toBe('DELETE');
    expect(last().url).toBe(`${API_URL}/v1/legacy_auth_connection`);
  });
});

describe('redirectUrls', () => {
  it('covers list/create/get/delete', async () => {
    const { atlas, last } = setup({ object: 'redirect_url', id: 'ru_1', url: 'https://a.test/cb' });
    await atlas.redirectUrls.list();
    expect(last().method).toBe('GET');
    expect(last().url).toBe(`${API_URL}/v1/redirect_urls`);

    await atlas.redirectUrls.create('https://a.test/cb');
    expect(last().method).toBe('POST');
    expect(last().json).toEqual({ url: 'https://a.test/cb' });

    await atlas.redirectUrls.get('ru/1');
    expect(last().url).toBe(`${API_URL}/v1/redirect_urls/ru%2F1`);

    await atlas.redirectUrls.delete('ru_1');
    expect(last().method).toBe('DELETE');
    expect(last().url).toBe(`${API_URL}/v1/redirect_urls/ru_1`);
  });
});

describe('sessionExchangeApps', () => {
  it('covers CRUD', async () => {
    const { atlas, last } = setup({ object: 'session_exchange_app', id: 'sxa_1' });
    await atlas.sessionExchangeApps.list();
    expect(last().method).toBe('GET');
    expect(last().url).toBe(`${API_URL}/v1/session_exchange_apps`);

    await atlas.sessionExchangeApps.create({
      name: 'Forum',
      backchannel_logout_uri: 'https://forum.test/logout',
    });
    expect(last().method).toBe('POST');
    expect(last().json).toEqual({ name: 'Forum', backchannel_logout_uri: 'https://forum.test/logout' });

    await atlas.sessionExchangeApps.get('sxa_1');
    expect(last().method).toBe('GET');
    expect(last().url).toBe(`${API_URL}/v1/session_exchange_apps/sxa_1`);

    await atlas.sessionExchangeApps.update('sxa_1', { audience: null });
    expect(last().method).toBe('PATCH');
    expect(last().json).toEqual({ audience: null });

    await atlas.sessionExchangeApps.delete('sxa_1');
    expect(last().method).toBe('DELETE');
    expect(last().url).toBe(`${API_URL}/v1/session_exchange_apps/sxa_1`);
  });
});

describe('tickets', () => {
  it('creates and redeems', async () => {
    const { atlas, last } = setup({ object: 'ticket_redemption', id: 'tkt_id', payload: { a: 1 } });
    await atlas.tickets.create({ ttl_seconds: 60, payload: { file: 'x' }, bound_user: 'user_1' });
    expect(last().method).toBe('POST');
    expect(last().url).toBe(`${API_URL}/v1/tickets`);
    expect(last().json).toEqual({ ttl_seconds: 60, payload: { file: 'x' }, bound_user: 'user_1' });

    const r = await atlas.tickets.redeem<{ a: number }>({ ticket: 'tkt_abc', for_user: 'user_1' });
    expect(last().url).toBe(`${API_URL}/v1/tickets/redeem`);
    expect(last().json).toEqual({ ticket: 'tkt_abc', for_user: 'user_1' });
    expect(r.payload.a).toBe(1);
  });
});

describe('testMode', () => {
  it('hits the test-instance, purge and testing-token routes', async () => {
    const { atlas, last } = setup({ object: 'test_instance' });
    await atlas.testMode.testInstance({ rotate_secret: true });
    expect(last().method).toBe('POST');
    expect(last().url).toBe(`${API_URL}/v1/test_instance`);
    expect(last().json).toEqual({ rotate_secret: true });

    await atlas.testMode.purgeTestUsers({ limit: 50 });
    expect(last().url).toBe(`${API_URL}/v1/test_users/purge`);
    expect(last().json).toEqual({ limit: 50 });

    await atlas.testMode.createTestingToken();
    expect(last().method).toBe('POST');
    expect(last().url).toBe(`${API_URL}/v1/testing_tokens`);
    expect(last().body).toBeUndefined();

    await atlas.testMode.createSignInUrl({ user_id: 'user_1', redirect_url: 'http://localhost:3000/' });
    expect(last().method).toBe('POST');
    expect(last().url).toBe(`${API_URL}/v1/testing/sign_in_url`);
    expect(last().json).toEqual({ user_id: 'user_1', redirect_url: 'http://localhost:3000/' });
  });
});

describe('diagnostics', () => {
  it('passes the probe inputs as query params', async () => {
    const { atlas, last } = setup({ object: 'login_readiness', ready: true, checks: [] });
    await atlas.diagnostics.loginReadiness({ origin: 'https://app.acme.com', live: true });
    expect(last().method).toBe('GET');
    expect(last().url).toBe(
      `${API_URL}/v1/diagnostics/login_readiness?origin=https%3A%2F%2Fapp.acme.com&live=true`,
    );

    await atlas.diagnostics.requestInspector({
      origin: 'https://app.acme.com',
      method: 'DELETE',
      path: '/v1/me',
    });
    expect(last().url).toBe(
      `${API_URL}/v1/diagnostics/request_inspector?origin=https%3A%2F%2Fapp.acme.com&method=DELETE&path=%2Fv1%2Fme`,
    );
  });
});

describe('oauthClients.import', () => {
  it('posts the clients array', async () => {
    const { atlas, last } = setup({ object: 'list', data: [] });
    await atlas.oauthClients.import(
      { clients: [{ client_id: 'c1', name: 'Legacy', redirect_uris: ['https://a.test/cb'], client_secret_hash: 'h' }] },
      'idem-imp',
    );
    expect(last().method).toBe('POST');
    expect(last().url).toBe(`${API_URL}/v1/oauth_clients/import`);
    expect(last().json.clients[0]).toEqual({
      client_id: 'c1',
      name: 'Legacy',
      redirect_uris: ['https://a.test/cb'],
      client_secret_hash: 'h',
    });
    expect(last().headers['idempotency-key']).toBe('idem-imp');
  });
});
