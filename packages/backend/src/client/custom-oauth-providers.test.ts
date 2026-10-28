import { describe, expect, it, vi } from 'vitest';
import { createAtlasClient } from './index';

function mockFetch(body: unknown = { object: 'x' }) {
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  const impl = vi.fn(async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return new Response(JSON.stringify(body), { status: 200 });
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

describe('customOAuthProviders + OIDC connection RP tools', () => {
  it('maps every method to its Backend API route', async () => {
    const { impl, calls } = mockFetch();
    const c = createAtlasClient({ secretKey: 'sk_test_x', apiUrl: 'https://api.example.test', fetch: impl });
    const create = { provider_key: 'acme', display_name: 'Acme', issuer: 'https://idp.example', token_endpoint_auth_method: 'private_key_jwt' as const };
    await c.customOAuthProviders.list();
    await c.customOAuthProviders.create(create);
    await c.customOAuthProviders.get('coap_1');
    await c.customOAuthProviders.update('coap_1', { enabled: true });
    await c.customOAuthProviders.delete('coap_1');
    await c.customOAuthProviders.discover({ issuer: 'https://idp.example' });
    await c.customOAuthProviders.previewProfileMapping({ profile_mapping: { fields: { email: 'mail' } }, userinfo: { mail: 'a@b.c' } });
    await c.customOAuthProviders.previewProfileMapping({ userinfo: { sub: '1' } }, 'coap_1');
    await c.customOAuthProviders.signingKeys('coap_1').list();
    await c.customOAuthProviders.signingKeys('coap_1').rotate({ alg: 'ES256' });
    await c.customOAuthProviders.signingKeys('coap_1').retire('kid/1');
    await c.ssoConnections.previewProfileMapping('ssoc_1', { id_token: 'a.b.c' });
    await c.ssoConnections.signingKeys('ssoc_1').rotate();
    await c.ssoConnections.signingKeys('ssoc_1').retire('k');
    expect(calls.map((x) => `${x.method} ${x.url.replace('https://api.example.test', '')}`)).toEqual([
      'GET /v1/custom_oauth_providers',
      'POST /v1/custom_oauth_providers',
      'GET /v1/custom_oauth_providers/coap_1',
      'PATCH /v1/custom_oauth_providers/coap_1',
      'DELETE /v1/custom_oauth_providers/coap_1',
      'POST /v1/custom_oauth_providers/discover',
      'POST /v1/custom_oauth_providers/profile_mapping/preview',
      'POST /v1/custom_oauth_providers/coap_1/profile_mapping/preview',
      'GET /v1/custom_oauth_providers/coap_1/signing_keys',
      'POST /v1/custom_oauth_providers/coap_1/signing_keys',
      'POST /v1/custom_oauth_providers/coap_1/signing_keys/kid%2F1/retire',
      'POST /v1/sso_connections/ssoc_1/profile_mapping/preview',
      'POST /v1/sso_connections/ssoc_1/signing_keys',
      'POST /v1/sso_connections/ssoc_1/signing_keys/k/retire',
    ]);
    expect(calls[1]!.body).toEqual(create);
    expect(calls[9]!.body).toEqual({ alg: 'ES256' });
  });
});
