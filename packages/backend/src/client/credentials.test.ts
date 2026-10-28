import { describe, expect, it } from 'vitest';
import { beforeNm, openSealedBox, sealBox } from './sealed-box';
import { generateSealKeyPair, openSealedSecret, exchangeOperatorToken, OAuthFlowError } from './operator';
import { createAtlasClient, requestPartnerLink, verifyPartnerLinkDelivery } from './index';
import { createHmac } from 'node:crypto';

const hex = (s: string) => Uint8Array.from(s.match(/../g)!.map((h) => parseInt(h, 16)));
const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

describe('sealed box (pure JS)', () => {
  it('crypto_box_beforenm matches the NaCl reference vector', () => {
    const alicesk = hex('77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a');
    const bobpk = hex('de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f');
    expect(toHex(beforeNm(bobpk, alicesk))).toBe('1b27556473e985d462cd51197a9a46c76009549eac6474f206c4ee0844f68389');
  });

  it('round-trips and opens base64 fields', () => {
    const pair = generateSealKeyPair();
    expect(pair.secretRecipient).toMatch(/^x25519:/);
    const sealed = sealBox('atlas_live_sk_x', pair.publicKey);
    expect(new TextDecoder().decode(openSealedBox(sealed, pair.publicKey, pair.secretKey))).toBe('atlas_live_sk_x');
    const b64 = btoa(String.fromCharCode(...sealed));
    expect(openSealedSecret(b64, pair)).toBe('atlas_live_sk_x');
  });
});

describe('credential namespaces', () => {
  it('whoami, secretKeys, partnerLinks and atlasIdGrants hit the right paths; secretRecipient is sent', async () => {
    const calls: Array<{ url: string; method: string; headers: Record<string, string> }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, method: String(init.method), headers: init.headers as Record<string, string> });
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const atlas = createAtlasClient({ secretKey: 'sk_live_x', apiUrl: 'https://api.test', fetch: fetchImpl, secretRecipient: 'x25519:abc' });
    await atlas.whoami();
    await atlas.secretKeys.create({ scopes: ['read_only'] });
    await atlas.secretKeys.rotate('key_1', { overlap_seconds: 0 });
    await atlas.keys.list();
    await atlas.partnerLinks.create({ partner: 'onetrust', scopes: ['privacy:execute'] });
    await atlas.partnerLinks.outbound.save('cookiemunch', { client_id: 'a', client_secret: 'b' });
    await atlas.atlasIdGrants.revoke('oac_1', 'oacon_1');
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'GET https://api.test/v1/whoami',
      'POST https://api.test/v1/secret_keys',
      'POST https://api.test/v1/secret_keys/key_1/rotate',
      'GET https://api.test/v1/keys',
      'POST https://api.test/v1/partner_links',
      'PUT https://api.test/v1/partner_links/outbound/cookiemunch',
      'DELETE https://api.test/v1/atlas_id_apps/oac_1/grants/oacon_1',
    ]);
    expect(calls[0]!.headers['x-secret-recipient']).toBe('x25519:abc');
  });

  it('exchangeOperatorToken posts RFC 8693 fields and surfaces errors', async () => {
    let body = '';
    const ok = (async (_u: string, init: RequestInit) => {
      body = String(init.body);
      return new Response(JSON.stringify({ access_token: 'atlas_live_at_x', token_type: 'Bearer', expires_in: 3600, resource: 'ins_1' }), { status: 200 });
    }) as unknown as typeof fetch;
    const t = await exchangeOperatorToken('op', { resource: 'ins_1', scope: ['read'] }, { fetch: ok, apiUrl: 'https://api.test' });
    expect(t.access_token).toBe('atlas_live_at_x');
    const p = new URLSearchParams(body);
    expect(p.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:token-exchange');
    expect(p.get('audience')).toBe('atlas');
    const bad = (async () => new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'no' }), { status: 400 })) as unknown as typeof fetch;
    await expect(exchangeOperatorToken('op', { resource: 'ins_1', scope: 'read' }, { fetch: bad })).rejects.toBeInstanceOf(OAuthFlowError);
  });
});

describe('partner link requests, mTLS and key provisioning fields', () => {
  it('hits the request, approve, deny, certificate and metadata-filter paths', async () => {
    const calls: Array<{ url: string; method: string; body?: string }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, method: String(init.method), body: init.body ? String(init.body) : undefined });
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const atlas = createAtlasClient({ secretKey: 'sk_live_x', apiUrl: 'https://api.test', fetch: fetchImpl });
    await atlas.partnerLinks.requests.list({ status: ['pending'] });
    await atlas.partnerLinks.requests.approve('plreq_1', { scopes: ['privacy:execute'] });
    await atlas.partnerLinks.requests.deny('plreq_2');
    await atlas.partnerLinks.setCertificates('pl_1', ['ab'.repeat(32)]);
    await atlas.partnerLinks.outbound.request('cookiemunch', { scopes: ['dsar:write'] });
    await atlas.secretKeys.list({ metadata: { sandbox: 'true' } });
    await atlas.secretKeys.create({ scopes: ['read_only'], external_ref: 'ci/main', metadata: { env: 'ci' }, allowed_origins: ['https://app.example.com'] });
    expect(calls.map((c) => `${c.method} ${decodeURIComponent(c.url)}`)).toEqual([
      'GET https://api.test/v1/partner_links/requests?status=pending',
      'POST https://api.test/v1/partner_links/requests/plreq_1/approve',
      'POST https://api.test/v1/partner_links/requests/plreq_2/deny',
      'PATCH https://api.test/v1/partner_links/pl_1',
      'POST https://api.test/v1/partner_links/outbound/cookiemunch/request',
      'GET https://api.test/v1/secret_keys?metadata[sandbox]=true',
      'POST https://api.test/v1/secret_keys',
    ]);
    expect(JSON.parse(calls[6]!.body!)).toMatchObject({ external_ref: 'ci/main', metadata: { env: 'ci' } });
  });

  it('a partner requests a link without a credential and verifies the signed delivery', async () => {
    let posted = '';
    const fetchImpl = (async (url: string, init: RequestInit) => {
      posted = `${String(init.method)} ${url} ${String(init.body)}`;
      return new Response(JSON.stringify({ object: 'partner_link_request', id: 'plreq_1', status: 'pending', request_secret: 'plrs_secret' }), { status: 201 });
    }) as unknown as typeof fetch;
    const created = await requestPartnerLink(
      { partner: 'acme', resource: 'ins_1', scopes: ['privacy:execute'], callback_url: 'https://acme.test/cb' },
      { apiUrl: 'https://api.test', fetch: fetchImpl },
    );
    expect(created.request_secret).toBe('plrs_secret');
    expect(posted).toContain('POST https://api.test/v1/partner_link_requests');

    const body = JSON.stringify({ object: 'partner_link.credentials', request_id: 'plreq_1', client_id: 'pl_1', client_secret: 'atlas_live_pl_x' });
    const ts = Date.now();
    const sig = createHmac('sha256', 'plrs_secret').update(`evt_1.${ts}.${body}`).digest('base64');
    const ok = verifyPartnerLinkDelivery({ body, headers: { 'atlas-id': 'evt_1', 'atlas-timestamp': String(ts), 'atlas-signature': `v1,${sig}` }, requestSecret: 'plrs_secret' });
    expect(ok.verified).toBe(true);
    expect(ok.event).toMatchObject({ object: 'partner_link.credentials', client_id: 'pl_1' });
    const bad = verifyPartnerLinkDelivery({ body, headers: { 'atlas-id': 'evt_1', 'atlas-timestamp': String(ts), 'atlas-signature': `v1,${sig}` }, requestSecret: 'other' });
    expect(bad.verified).toBe(false);

    const refused = (async () => new Response(JSON.stringify({ errors: [{ message: 'nope' }] }), { status: 400 })) as unknown as typeof fetch;
    await expect(requestPartnerLink({ partner: 'acme', resource: 'ins_1', scopes: ['x'], callback_url: 'https://acme.test/cb' }, { fetch: refused })).rejects.toThrow(/HTTP 400: nope/);
  });
});
