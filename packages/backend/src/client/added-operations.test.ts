import { describe, expect, it, vi } from 'vitest';
import { createAtlasClient, createAtlasPlatformClient } from './index';

const API_URL = 'https://api.example.test';

function mockFetch(body: unknown = { object: 'x' }) {
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body?: unknown }> =
    [];
  const impl = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(init?.headers ?? {})) headers[k.toLowerCase()] = v as string;
    calls.push({ url: String(url), method: init?.method ?? 'GET', headers, body: init?.body });
    return new Response(JSON.stringify(body), { status: 200 });
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

type Bapi = ReturnType<typeof createAtlasClient>;
type Plat = ReturnType<typeof createAtlasPlatformClient>;

const MOVE = { from: 'https://old.example.com', to: 'https://new.example.com', dry_run: true };

// [method, path+query, expected JSON body (undefined = none), call]
const BAPI: Array<[string, string, unknown, (c: Bapi) => Promise<unknown>]> = [
  ['POST', '/v1/instance/move_origin', MOVE, (c) => c.instance.moveOrigin(MOVE)],
  ['GET', '/v1/instance/connections', undefined, (c) => c.instance.connections()],
  ['GET', '/v1/instance/integrations/chatly', undefined, (c) => c.instance.integrations.chatly.get()],
  ['PUT', '/v1/instance/integrations/chatly', { channel: 'support' }, (c) => c.instance.integrations.chatly.set({ channel: 'support' })],
  ['DELETE', '/v1/instance/integrations/chatly', undefined, (c) => c.instance.integrations.chatly.delete()],
  ['GET', '/v1/instance/integrations/forumulate', undefined, (c) => c.instance.integrations.forumulate.get()],
  [
    'PUT',
    '/v1/instance/integrations/forumulate',
    { org_id: 'org_1', spaces: ['sp_1', { id: 'sp_2', redeem_url: 'https://docs.example.com/r' }] },
    (c) =>
      c.instance.integrations.forumulate.set({
        org_id: 'org_1',
        spaces: ['sp_1', { id: 'sp_2', redeem_url: 'https://docs.example.com/r' }],
      }),
  ],
  ['DELETE', '/v1/instance/integrations/forumulate', undefined, (c) => c.instance.integrations.forumulate.delete()],
  ['GET', '/v1/logout_notify_endpoints', undefined, (c) => c.logoutNotifyEndpoints.list()],
  [
    'POST',
    '/v1/logout_notify_endpoints',
    { url: 'https://hooks.example.com/logout', oauth_client_id: 'client_1' },
    (c) => c.logoutNotifyEndpoints.create({ url: 'https://hooks.example.com/logout', oauth_client_id: 'client_1' }),
  ],
  ['GET', '/v1/logout_notify_endpoints/lne_1', undefined, (c) => c.logoutNotifyEndpoints.get('lne_1')],
  ['PATCH', '/v1/logout_notify_endpoints/lne_1', { description: 'x' }, (c) => c.logoutNotifyEndpoints.update('lne_1', { description: 'x' })],
  ['DELETE', '/v1/logout_notify_endpoints/lne_1', undefined, (c) => c.logoutNotifyEndpoints.delete('lne_1')],
  ['GET', '/v1/logout_notify_endpoints/lne_1/deliveries?limit=5', undefined, (c) => c.logoutNotifyEndpoints.listDeliveries('lne_1', { limit: 5 })],
  ['GET', '/v1/messaging_providers/email/managed', undefined, (c) => c.messaging.managedEmail.get()],
  [
    'POST',
    '/v1/messaging_providers/email/managed',
    { from_address: 'Acme <no-reply@example.com>', dns: { provider: 'cloudflare', api_token: 'tok' } },
    (c) =>
      c.messaging.managedEmail.create({
        from_address: 'Acme <no-reply@example.com>',
        dns: { provider: 'cloudflare', api_token: 'tok' },
      }),
  ],
  ['POST', '/v1/messaging_providers/email/managed/verify', undefined, (c) => c.messaging.managedEmail.verify()],
  ['DELETE', '/v1/messaging_providers/email/managed?force=true', undefined, (c) => c.messaging.managedEmail.delete({ force: true })],
  ['GET', '/v1/oauth_clients/oac_1/backchannel_deliveries?limit=10', undefined, (c) => c.oauthClients.listBackchannelDeliveries('oac_1', { limit: 10 })],
  ['POST', '/v1/oauth_clients/oac_1/backchannel_logout/test', undefined, (c) => c.oauthClients.testBackchannelLogout('oac_1')],
  ['POST', '/v1/users/user_1/sessions/revoke', { revoke_grants: true }, (c) => c.users.revokeSessions('user_1', { revoke_grants: true })],
  ['POST', '/v1/domains', { host: 'auth.example.com', dns: { provider: 'cloudflare', api_token: 'tok' } }, (c) => c.domains.create({ host: 'auth.example.com', dns: { provider: 'cloudflare', api_token: 'tok' } })],
];

const PLATFORM: Array<[string, string, unknown, (c: Plat) => Promise<unknown>]> = [
  ['GET', '/v1/platform/atlas_id_apps/app_1/backchannel_deliveries', undefined, (c) => c.atlasIdApps.listBackchannelDeliveries('app_1')],
  ['POST', '/v1/platform/atlas_id_apps/app_1/backchannel_logout/test', undefined, (c) => c.atlasIdApps.testBackchannelLogout('app_1')],
  ['GET', '/v1/platform/atlas_id_apps/app_1/preflight', undefined, (c) => c.atlasIdApps.preflight('app_1')],
  ['GET', '/v1/platform/atlas_id_apps/app_1/users?email=a%40example.com', undefined, (c) => c.atlasIdApps.findUsers('app_1', 'a@example.com')],
  ['DELETE', '/v1/platform/atlas_id_apps/app_1/grants/gr_1', undefined, (c) => c.atlasIdApps.revokeGrant('app_1', 'gr_1')],
  ['POST', '/v1/platform/atlas_id_apps/app_1/move_origin', MOVE, (c) => c.atlasIdApps.moveOrigin('app_1', MOVE)],
  ['POST', '/v1/platform/atlas_id_apps/app_1/webhook/rotate_secret', undefined, (c) => c.atlasIdApps.rotateWebhookSecret('app_1')],
  ['PATCH', '/v1/platform/atlas_id_apps/app_1', { webhook_url: null }, (c) => c.atlasIdApps.update('app_1', { webhook_url: null })],
  ['GET', '/v1/platform/atlas_id_publisher', undefined, (c) => c.atlasIdPublisher.get()],
  ['PUT', '/v1/platform/atlas_id_publisher', { name: 'Acme', domain: 'example.com' }, (c) => c.atlasIdPublisher.set({ name: 'Acme', domain: 'example.com' })],
  ['PATCH', '/v1/platform/atlas_id_publisher', { skip_consent: true }, (c) => c.atlasIdPublisher.update({ skip_consent: true })],
  ['DELETE', '/v1/platform/atlas_id_publisher', undefined, (c) => c.atlasIdPublisher.delete()],
  ['POST', '/v1/platform/atlas_id_publisher/verify', undefined, (c) => c.atlasIdPublisher.verify()],
  ['GET', '/v1/platform/config_changelog?action=atlas_id_app.updated&limit=5', undefined, (c) => c.configChangelog.list({ action: 'atlas_id_app.updated', limit: 5 })],
];

describe('added Backend API operations', () => {
  it.each(BAPI)('%s %s', async (method, path, body, call) => {
    const { impl, calls } = mockFetch();
    await call(createAtlasClient({ secretKey: 'sk_test_x', apiUrl: API_URL, fetch: impl }));
    const c = calls[calls.length - 1]!;
    expect([c.method, c.url]).toEqual([method, `${API_URL}${path}`]);
    expect(c.body === undefined ? undefined : JSON.parse(c.body as string)).toEqual(body);
  });

  it('sends Atlas-Strict on the new writes when strict', async () => {
    const { impl, calls } = mockFetch();
    const atlas = createAtlasClient({ secretKey: 'sk_test_x', apiUrl: API_URL, fetch: impl, strict: true });
    await atlas.instance.moveOrigin(MOVE);
    expect(calls[0]!.headers['atlas-strict']).toBe('true');
  });

  it('decodes an origin move, managed email, connections and the new fields', async () => {
    const move = {
      object: 'origin_move',
      ...MOVE,
      applied: false,
      changes: [{ object: 'oauth_client', id: 'oac_1', field: 'redirect_uris', before: ['https://old.example.com/cb'], after: ['https://new.example.com/cb'] }],
      problems: [],
    };
    let m = mockFetch(move);
    const r = await createAtlasClient({ secretKey: 'sk_test_x', apiUrl: API_URL, fetch: m.impl }).instance.moveOrigin(MOVE);
    expect(r.changes[0]!.after).toEqual(['https://new.example.com/cb']);

    m = mockFetch({ object: 'cookie_consent', enabled: true, culture: 'page', declared_cookies: [{ name: '__session', pattern: null, store: 'cookie', domain: '.example.com', lifetime_seconds: null, lifetime: 'session', http_only: true, category: 'necessary', purpose: 'p', written_when: 'w', set_by: 'atlas_frontend_api' }] });
    const cc = await createAtlasClient({ secretKey: 'sk_test_x', apiUrl: API_URL, fetch: m.impl }).instance.cookieConsent.get();
    expect(cc.declared_cookies![0]!.store).toBe('cookie');
    expect(cc.culture).toBe('page');
  });
});

describe('added Platform API operations', () => {
  it.each(PLATFORM)('%s %s', async (method, path, body, call) => {
    const { impl, calls } = mockFetch();
    await call(createAtlasPlatformClient({ platformKey: 'psk_test_x', apiUrl: API_URL, fetch: impl }));
    const c = calls[calls.length - 1]!;
    expect([c.method, c.url]).toEqual([method, `${API_URL}${path}`]);
    expect(c.body === undefined ? undefined : JSON.parse(c.body as string)).toEqual(body);
  });

  it('decodes the publisher and the app user lookup', async () => {
    const m = mockFetch({ object: 'list', data: [{ object: 'atlas_id_user', atlas_id_user: true, sub: 'u_1', grant_id: 'gr_1', scopes: ['openid'], granted_at: 1 }] });
    const r = await createAtlasPlatformClient({ platformKey: 'psk_test_x', apiUrl: API_URL, fetch: m.impl }).atlasIdApps.findUsers('app_1', 'a@example.com');
    expect(r.data[0]!.grant_id).toBe('gr_1');
  });
});
