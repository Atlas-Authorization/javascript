import { describe, expect, it, vi } from 'vitest';
import { createAtlasClient, type OAuthClient } from './index';

const SECRET = 'sk_test_placeholder_not_a_real_key';
const API_URL = 'https://api.example.test';

const CLIENT: OAuthClient = {
  object: 'oauth_client',
  id: 'oac_1',
  client_id: 'client_1',
  name: 'Acme',
  logo_url: null,
  redirect_uris: ['https://acme.test/cb'],
  allowed_scopes: ['openid'],
  grant_types: ['authorization_code'],
  token_endpoint_auth_method: 'client_secret_basic',
  secret_prefix: 'abcd',
  is_public: false,
  first_party: false,
  post_logout_redirect_uris: ['https://acme.test/'],
  backchannel_logout_uri: 'https://acme.test/bcl',
  backchannel_logout_session_required: true,
  frontchannel_logout_uri: null,
  frontchannel_logout_session_required: false,
  created_at: 1,
  updated_at: 2,
};

function setup(body: unknown) {
  const calls: Array<{ url: string; method: string; body?: string }> = [];
  const impl = vi.fn(async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? 'GET', body: init?.body as string });
    return new Response(JSON.stringify(body), { status: 200 });
  });
  const atlas = createAtlasClient({ secretKey: SECRET, apiUrl: API_URL, fetch: impl as unknown as typeof fetch });
  return { atlas, last: () => calls[calls.length - 1]! };
}

describe('oauthClients logout registration', () => {
  it('sends the logout fields on create and decodes them', async () => {
    const { atlas, last } = setup({ ...CLIENT, client_secret: 's', note: 'shown once' });
    const created = await atlas.oauthClients.create({
      name: 'Acme',
      redirect_uris: ['https://acme.test/cb'],
      post_logout_redirect_uris: ['https://acme.test/'],
      backchannel_logout_uri: 'https://acme.test/bcl',
      backchannel_logout_session_required: true,
      frontchannel_logout_uri: 'https://acme.test/fcl',
      frontchannel_logout_session_required: false,
    });
    expect(last().method).toBe('POST');
    expect(last().url).toBe(`${API_URL}/v1/oauth_clients`);
    expect(JSON.parse(last().body!)).toEqual({
      name: 'Acme',
      redirect_uris: ['https://acme.test/cb'],
      post_logout_redirect_uris: ['https://acme.test/'],
      backchannel_logout_uri: 'https://acme.test/bcl',
      backchannel_logout_session_required: true,
      frontchannel_logout_uri: 'https://acme.test/fcl',
      frontchannel_logout_session_required: false,
    });
    expect(created.backchannel_logout_uri).toBe('https://acme.test/bcl');
    expect(created.post_logout_redirect_uris).toEqual(['https://acme.test/']);
  });

  it('clears logout settings on update with null and []', async () => {
    const { atlas, last } = setup(CLIENT);
    await atlas.oauthClients.update('oac_1', {
      post_logout_redirect_uris: [],
      backchannel_logout_uri: null,
      frontchannel_logout_uri: null,
      frontchannel_logout_session_required: true,
    });
    expect(last().method).toBe('PATCH');
    expect(last().url).toBe(`${API_URL}/v1/oauth_clients/oac_1`);
    expect(JSON.parse(last().body!)).toEqual({
      post_logout_redirect_uris: [],
      backchannel_logout_uri: null,
      frontchannel_logout_uri: null,
      frontchannel_logout_session_required: true,
    });
  });
});
