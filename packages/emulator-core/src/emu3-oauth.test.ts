/* eslint-disable @typescript-eslint/no-explicit-any */
import { createHash, createHmac, generateKeyPairSync, sign as nodeSign, type KeyObject } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { pkceChallenge } from './crypto-util';
import { client, makeEngine } from './test-support';
import type { Engine } from './engine';
import { emu3OauthParityRequests } from './parity-emu3-oauth';

const CB = 'https://app.example/callback';
const b64 = (v: string | Buffer): string => Buffer.from(v).toString('base64url');
const nowS = () => Math.floor(Date.now() / 1000);
const ec = () => {
  const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return { ...pair, jwk: pair.publicKey.export({ format: 'jwk' }) as Record<string, string> };
};
const es256 = (key: KeyObject, header: Record<string, unknown>, payload: Record<string, unknown>): string => {
  const input = `${b64(JSON.stringify(header))}.${b64(JSON.stringify(payload))}`;
  return `${input}.${b64(nodeSign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' }))}`;
};
const hs256 = (secret: string, payload: Record<string, unknown>): string => {
  const input = `${b64(JSON.stringify({ alg: 'HS256' }))}.${b64(JSON.stringify(payload))}`;
  return `${input}.${b64(createHmac('sha256', secret).update(input).digest())}`;
};
const half = (v: string): string => createHash('sha256').update(v).digest().subarray(0, 16).toString('base64url');

const form = (e: Engine) => async (path: string, fields: Record<string, string>, headers: Record<string, string> = {}) => {
  const res = await e.handle(new Request(`http://emulator.test${path}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams(fields).toString(), redirect: 'manual' }));
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null, headers: res.headers, location: res.headers.get('location') };
};
const raw = async (e: Engine, method: string, path: string, headers: Record<string, string> = {}, body?: unknown) => {
  const res = await e.handle(new Request(`http://emulator.test${path}`, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' }));
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, json, text, location: res.headers.get('location'), headers: res.headers };
};
const authz = (e: Engine, params: Record<string, string>) => raw(e, 'GET', `/oauth2/authorize?${new URLSearchParams(params)}`);
const frag = (loc: string | null) => new URLSearchParams(new URL(loc!).hash.slice(1));
const qs = (loc: string | null) => new URL(loc!).searchParams;

const setup = async (clientBody: Record<string, unknown> = {}, engineOptions: Parameters<typeof makeEngine>[0] = {}) => {
  const e = makeEngine(engineOptions);
  const call = client(e);
  const post = form(e);
  const user = (await call('POST', '/v1/users', { email_address: 'ada@example.com', first_name: 'Ada', password: 'Correct-horse-9-battery' })).json;
  const c = (await call('POST', '/v1/oauth_clients', { name: 'App', redirect_uris: [CB], grant_types: ['authorization_code', 'refresh_token'], allowed_scopes: ['openid', 'email', 'profile', 'offline_access', 'read'], token_endpoint_auth_method: 'client_secret_post', ...clientBody })).json;
  const creds = { client_id: c.client_id, client_secret: c.client_secret };
  return { e, call, post, user, c, creds };
};
const verifier = 'v'.repeat(48);
/** Run code + PKCE for a client and user and return the token response. */
const login = async (s: { e: Engine; post: ReturnType<typeof form> }, c: any, userId: string, scope = 'openid offline_access', extra: Record<string, string> = {}) => {
  const a = await authz(s.e, { client_id: c.client_id, redirect_uri: CB, response_type: 'code', scope, login_hint: userId, nonce: 'n', code_challenge: await pkceChallenge(verifier), code_challenge_method: 'S256', ...extra });
  const code = qs(a.location).get('code')!;
  return s.post('/oauth2/token', { grant_type: 'authorization_code', code, redirect_uri: CB, client_id: c.client_id, client_secret: c.client_secret, code_verifier: verifier });
};

describe('implicit and hybrid response types', () => {
  const hybrid = { grant_types: ['authorization_code', 'implicit', 'refresh_token'], response_types: ['code', 'id_token token', 'code id_token'] };

  it('returns an ID token and access token in the fragment, bound by at_hash, with no code and no refresh token', async () => {
    const { e, user, c } = await setup(hybrid);
    const r = await authz(e, { client_id: c.client_id, redirect_uri: CB, response_type: 'id_token token', scope: 'openid email', nonce: 'n1', state: 's1', login_hint: user.id });
    expect(r.status).toBe(302);
    expect(new URL(r.location!).search).toBe('');
    const f = frag(r.location);
    expect(f.get('state')).toBe('s1');
    expect(f.get('iss')).toBe(e.issuer);
    expect(f.get('token_type')).toBe('Bearer');
    expect(f.get('code')).toBeNull();
    expect(f.get('refresh_token')).toBeNull();
    const claims = ((await e.tokens.verifyAny(f.get('id_token')!)) as any).claims;
    expect(claims).toMatchObject({ aud: c.client_id, nonce: 'n1', sub: user.id, at_hash: half(f.get('access_token')!) });
    expect(claims.sid).toBeTruthy();
    expect(claims.c_hash).toBeUndefined();
  });

  it('hybrid code id_token carries c_hash and the code redeems at the token endpoint', async () => {
    const { e, post, user, c, creds } = await setup(hybrid);
    const f = frag((await authz(e, { client_id: c.client_id, redirect_uri: CB, response_type: 'code id_token', scope: 'openid', nonce: 'n2', login_hint: user.id })).location);
    const claims = ((await e.tokens.verifyAny(f.get('id_token')!)) as any).claims;
    expect(claims.c_hash).toBe(half(f.get('code')!));
    expect(claims.at_hash).toBeUndefined();
    const tok = await post('/oauth2/token', { ...creds, grant_type: 'authorization_code', code: f.get('code')!, redirect_uri: CB });
    expect(tok.status).toBe(200);
  });

  it('refuses what the real provider refuses, as errors in the fragment', async () => {
    const { e, user, c } = await setup({ ...hybrid, response_types: [...hybrid.response_types, 'id_token'] });
    const base = { client_id: c.client_id, redirect_uri: CB, scope: 'openid', login_hint: user.id };
    expect(frag((await authz(e, { ...base, response_type: 'id_token', state: 'x' })).location).get('error')).toBe('invalid_request'); // nonce required
    expect(frag((await authz(e, { ...base, response_type: 'id_token', nonce: 'n', response_mode: 'query' })).location).get('error')).toBe('invalid_request');
    // an unknown response_type cannot say it returns tokens, so its error travels in the query
    expect(qs((await authz(e, { ...base, response_type: 'token token', nonce: 'n' })).location).get('error')).toBe('unsupported_response_type');
    expect(qs((await authz(e, { ...base, response_type: 'code', grant_management_action: 'bogus' })).location).get('error')).toBe('invalid_request');
    const plain = await setup();
    const refused = await authz(plain.e, { client_id: plain.c.client_id, redirect_uri: CB, response_type: 'id_token', nonce: 'n', scope: 'openid', login_hint: plain.user.id });
    expect(frag(refused.location).get('error')).toBe('unauthorized_client');
  });

  it('rejects a client whose response types need a grant it does not hold, and lists the types in discovery', async () => {
    const { call, e } = await setup();
    const bad = await call('POST', '/v1/oauth_clients', { name: 'Bad', redirect_uris: [CB], grant_types: ['authorization_code'], response_types: ['id_token'] });
    expect(bad.status).toBeGreaterThanOrEqual(400);
    const doc = (await (await e.handle(new Request('http://x/.well-known/openid-configuration'))).json()) as any;
    expect(doc.response_types_supported).toEqual(expect.arrayContaining(['code', 'id_token', 'id_token token', 'code id_token', 'code token', 'code id_token token']));
    expect(doc).toMatchObject({ response_modes_supported: ['query', 'fragment', 'form_post', 'jwt', 'query.jwt', 'fragment.jwt', 'form_post.jwt'], request_parameter_supported: true, request_uri_parameter_supported: true, require_request_uri_registration: true, end_session_endpoint: `${e.issuer}/oauth2/logout`, grant_management_endpoint: `${e.issuer}/oauth2/grants`, grant_management_actions_supported: ['create', 'merge', 'replace'], authorization_details_types_supported: [] });
    expect(doc.grant_types_supported).toContain('implicit');
    expect(doc.backchannel_token_delivery_modes_supported).toContain('push');
    expect(doc.registration_endpoint).toBeUndefined();
    expect(doc.request_object_signing_alg_values_supported).toContain('ES256');
  });
});

describe('signed request objects', () => {
  const key = ec();
  const jwks = { keys: [{ ...key.jwk, kid: 'k1', alg: 'ES256', use: 'sig' }] };
  const make = (e: Engine, c: any) => (claims: Record<string, unknown> = {}, header: Record<string, unknown> = {}, signer: KeyObject = key.privateKey) =>
    es256(signer, { alg: 'ES256', kid: 'k1', ...header }, { iss: c.client_id, aud: e.issuer, client_id: c.client_id, iat: nowS(), exp: nowS() + 300, response_type: 'code', redirect_uri: CB, scope: 'openid', ...claims });

  it('verifies a request object against the client keys; its parameters win over the query', async () => {
    const { e, user, c } = await setup({ jwks });
    const ro = make(e, c);
    const ok = await authz(e, { client_id: c.client_id, login_hint: user.id, request: ro({ state: 'from-object', nonce: 'n', code_challenge: await pkceChallenge(verifier), code_challenge_method: 'S256' }), state: 'from-query' });
    expect(ok.status).toBe(302);
    expect(qs(ok.location).get('state')).toBe('from-object');
    expect(qs(ok.location).get('code')).toBeTruthy();
    // signed by someone else
    const forged = await authz(e, { client_id: c.client_id, login_hint: user.id, request: ro({}, {}, ec().privateKey) });
    expect(forged.json).toMatchObject({ error: 'invalid_request_object', error_description: 'The signed request object is invalid.' });
    expect((await authz(e, { client_id: c.client_id, login_hint: user.id, request: ro({ client_id: 'someone-else' }) })).json).toMatchObject({ error: 'invalid_request_object', error_description: 'The request object client_id does not match.' });
    expect((await authz(e, { client_id: c.client_id, login_hint: user.id, request: ro({ iss: 'someone-else' }) })).json.error_description).toBe('The request object iss is not the client_id.');
    expect((await authz(e, { client_id: c.client_id, login_hint: user.id, request: ro({ aud: 'https://other.example' }) })).json.error_description).toBe('The request object aud is not this issuer.');
    expect((await authz(e, { client_id: c.client_id, login_hint: user.id, request: ro({ exp: nowS() - 600 }) })).json.error).toBe('invalid_request_object');
    // an unregistered redirect_uri inside the object is an error, never a redirect
    expect((await authz(e, { client_id: c.client_id, login_hint: user.id, request: ro({ redirect_uri: 'https://evil.example/cb' }) })).status).toBe(400);
  });

  it('refuses symmetric and unknown-key objects and enforces a registered algorithm', async () => {
    const { e, user, c } = await setup({ jwks, request_object_signing_alg: 'ES384' });
    expect((await authz(e, { client_id: c.client_id, login_hint: user.id, request: hs256(c.client_secret, { iss: c.client_id, response_type: 'code', redirect_uri: CB }) })).json.error_description).toBe('The request object must be signed with an asymmetric algorithm.');
    expect((await authz(e, { client_id: c.client_id, login_hint: user.id, request: make(e, c)() })).json.error_description).toBe('The request object algorithm is not the one this client registered.');
    expect((await authz(e, { client_id: c.client_id, login_hint: user.id, request: 'not-a-jwt' })).json.error_description).toBe('The request object is malformed.');
    const keyless = await setup();
    expect((await authz(keyless.e, { client_id: keyless.c.client_id, login_hint: keyless.user.id, request: make(keyless.e, keyless.c)() })).json.error_description).toBe('This client has no registered keys for a signed request object.');
  });

  it('require_signed_request_object refuses a plain request, on authorize and PAR', async () => {
    const { e, user, c, creds, post } = await setup({ jwks, require_signed_request_object: true });
    expect((await authz(e, { client_id: c.client_id, redirect_uri: CB, response_type: 'code', scope: 'openid', login_hint: user.id })).json).toMatchObject({ error: 'invalid_request', error_description: 'This client must send a signed request object.' });
    expect((await post('/oauth2/par', { ...creds, redirect_uri: CB, response_type: 'code' })).json.error).toBe('invalid_request');
    const par = await post('/oauth2/par', { ...creds, request: make(e, c)({ state: 'p1' }) });
    expect(par.status).toBe(201);
    const used = await authz(e, { client_id: c.client_id, request_uri: par.json.request_uri, login_hint: user.id });
    expect(qs(used.location).get('state')).toBe('p1');
    expect((await post('/oauth2/par', { ...creds, request: make(e, c)({ client_id: 'x' }) })).json.error).toBe('invalid_request_object');
  });

  it('fetches a registered https request_uri and refuses an unregistered one', async () => {
    const holder: { jwt: string } = { jwt: '' };
    const fetchSpy = vi.fn(async (url: string | URL | Request) => (String(url) === 'https://rp.example/ro.jwt' ? new Response(holder.jwt) : new Response('no', { status: 404 })));
    const { e, user, c } = await setup({ jwks, request_uris: ['https://rp.example/ro.jwt'] }, { fetch: fetchSpy as unknown as typeof fetch });
    holder.jwt = make(e, c)({ state: 'by-ref' });
    const ok = await authz(e, { client_id: c.client_id, request_uri: 'https://rp.example/ro.jwt', login_hint: user.id });
    expect(qs(ok.location).get('state')).toBe('by-ref');
    const other = await authz(e, { client_id: c.client_id, request_uri: 'https://rp.example/other.jwt', login_hint: user.id });
    expect(other.json).toMatchObject({ error: 'invalid_request_uri', error_description: 'The request_uri is not registered for this client.' });
  });

  it('validates client metadata on create', async () => {
    const { call } = await setup();
    const bad = (body: Record<string, unknown>) => call('POST', '/v1/oauth_clients', { name: 'X', redirect_uris: [CB], ...body });
    expect((await bad({ jwks: { keys: [{ kty: 'EC', d: 'secret' }] } })).status).toBeGreaterThanOrEqual(400);
    expect((await bad({ request_object_signing_alg: 'HS256' })).status).toBeGreaterThanOrEqual(400);
    expect((await bad({ request_uris: ['http://insecure.example/ro'] })).status).toBeGreaterThanOrEqual(400);
    expect((await bad({ jwks: jwks, jwks_uri: 'https://rp.example/jwks.json' })).status).toBeGreaterThanOrEqual(400);
    expect((await bad({ jwks, require_signed_request_object: true, request_object_signing_alg: 'ES256' })).status).toBe(201);
  });
});

describe('rich authorization requests', () => {
  const details = [{ type: 'payment_initiation', instructedAmount: { currency: 'EUR', amount: '5.00' } }];
  const enable = (call: ReturnType<typeof client>) => call('POST', '/__emulator/oauth/config', { authorization_details_types: ['payment_initiation'] });

  it('refuses every type until the instance allows it, then carries the details into tokens and introspection', async () => {
    const { e, call, post, user, c, creds } = await setup();
    const ask = (d: unknown) => authz(e, { client_id: c.client_id, redirect_uri: CB, response_type: 'code', scope: 'openid offline_access', login_hint: user.id, state: 's', authorization_details: typeof d === 'string' ? d : JSON.stringify(d) });
    const off = await ask(details);
    expect(qs(off.location).get('error')).toBe('invalid_authorization_details');
    expect(qs(off.location).get('error_description')).toBe('authorization_details type is not supported: payment_initiation.');
    expect((await (await e.handle(new Request('http://x/.well-known/oauth-authorization-server'))).json() as any).authorization_details_types_supported).toEqual([]);
    expect((await enable(call)).json.authorization_details_types).toEqual(['payment_initiation']);
    expect((await (await e.handle(new Request('http://x/.well-known/oauth-authorization-server'))).json() as any).authorization_details_types_supported).toEqual(['payment_initiation']);
    expect(qs((await ask('{not json')).location).get('error_description')).toBe('authorization_details must be a JSON array.');
    expect(qs((await ask([])).location).get('error_description')).toBe('authorization_details must be a non-empty JSON array.');
    expect(qs((await ask([{ amount: 1 }])).location).get('error_description')).toBe('Each authorization_details element needs a string "type".');
    expect(qs((await ask([{ type: 'other' }])).location).get('error_description')).toBe('authorization_details type is not supported: other.');
    const ok = await ask(details);
    const tok = await post('/oauth2/token', { ...creds, grant_type: 'authorization_code', code: qs(ok.location).get('code')!, redirect_uri: CB });
    expect(tok.json.authorization_details).toEqual(details);
    const intro = (await post('/oauth2/introspect', { ...creds, token: tok.json.access_token })).json;
    expect(intro.authorization_details).toEqual(details);
    const refreshed = await post('/oauth2/token', { ...creds, grant_type: 'refresh_token', refresh_token: tok.json.refresh_token });
    expect(refreshed.json.authorization_details).toEqual(details);
    expect((await post('/oauth2/introspect', { ...creds, token: tok.json.refresh_token })).json).toMatchObject({ active: false });
    expect((await post('/oauth2/introspect', { ...creds, token: refreshed.json.refresh_token })).json.authorization_details).toEqual(details);
  });

  it('validates at pushed authorization requests and keeps the details through the request_uri', async () => {
    const { e, call, post, user, c, creds } = await setup();
    const off = await post('/oauth2/par', { ...creds, redirect_uri: CB, response_type: 'code', scope: 'openid', authorization_details: JSON.stringify(details) });
    expect(off).toMatchObject({ status: 400, json: { error: 'invalid_authorization_details' } });
    await enable(call);
    const par = await post('/oauth2/par', { ...creds, redirect_uri: CB, response_type: 'code', scope: 'openid', authorization_details: JSON.stringify(details) });
    expect(par.status).toBe(201);
    const a = await authz(e, { client_id: c.client_id, request_uri: par.json.request_uri, login_hint: user.id });
    const tok = await post('/oauth2/token', { ...creds, grant_type: 'authorization_code', code: qs(a.location).get('code')!, redirect_uri: CB });
    expect(tok.json.authorization_details).toEqual(details);
    // the details also travel inside a signed request object
    const key = ec();
    const s2 = await setup({ jwks: { keys: [{ ...key.jwk, kid: 'k1' }] } });
    await enable(s2.call);
    const ro = es256(key.privateKey, { alg: 'ES256', kid: 'k1' }, { iss: s2.c.client_id, aud: s2.e.issuer, response_type: 'code', redirect_uri: CB, scope: 'openid', authorization_details: details });
    const viaObject = await authz(s2.e, { client_id: s2.c.client_id, request: ro, login_hint: s2.user.id });
    const tok2 = await s2.post('/oauth2/token', { ...s2.creds, grant_type: 'authorization_code', code: qs(viaObject.location).get('code')!, redirect_uri: CB });
    expect(tok2.json.authorization_details).toEqual(details);
  });
});

describe('grant management', () => {
  const GM = ['grant_management_query', 'grant_management_revoke'];
  const scopes = ['openid', 'email', 'profile', 'offline_access', 'read', ...GM];
  const approve = async (e: Engine, post: ReturnType<typeof form>, loc: string | null) => {
    const token = qs(loc).get('consent_token')!;
    return (await post('/oauth2/authorize/consent', { consent_token: token, decision: 'approve' })).location;
  };

  it('creates a grant, reads it, narrows it, merges new scopes through consent and revokes it with every token', async () => {
    const { e, post, user, c, creds } = await setup({ allowed_scopes: scopes, require_consent: true });
    const run = async (extra: Record<string, string>, scope: string) => {
      const a = await authz(e, { client_id: c.client_id, redirect_uri: CB, response_type: 'code', scope, login_hint: user.id, ...extra });
      const loc = a.location!.includes('/oauth2/authorize/consent') ? await approve(e, post, a.location) : a.location;
      return { redirect: a, code: qs(loc).get('code')! };
    };
    const first = await run({ grant_management_action: 'create' }, 'openid read offline_access grant_management_query grant_management_revoke');
    const tok = await post('/oauth2/token', { ...creds, grant_type: 'authorization_code', code: first.code, redirect_uri: CB });
    const gid = tok.json.grant_id;
    expect(gid).toBeTruthy();
    const claims = ((await e.tokens.verifyAny(tok.json.access_token)) as any).claims;
    expect(claims.grant_id).toBe(gid);
    const auth = { authorization: `Bearer ${tok.json.access_token}` };
    const got = await raw(e, 'GET', `/oauth2/grants/${gid}`, auth);
    expect(got.json).toMatchObject({ grant_id: gid, client_id: c.client_id, status: 'active', revision: 1 });
    expect(got.json.scopes.map((s: any) => s.scope)).toContain('read');
    // wrong or missing credentials are one answer
    expect((await raw(e, 'GET', `/oauth2/grants/${gid}`)).status).toBe(401);
    expect((await raw(e, 'GET', '/oauth2/grants/ogm_unknown', auth)).json).toMatchObject({ error: 'invalid_grant', error_description: 'Unknown grant.' });
    // the client may narrow, never widen
    expect((await raw(e, 'PATCH', `/oauth2/grants/${gid}`, auth, { scopes: ['openid', 'email'] })).status).toBe(400);
    expect((await raw(e, 'PATCH', `/oauth2/grants/${gid}`, auth, {})).status).toBe(400);
    const narrowed = await raw(e, 'PATCH', `/oauth2/grants/${gid}`, auth, { scopes: ['openid', 'grant_management_query', 'grant_management_revoke', 'offline_access'] });
    expect(narrowed.json).toMatchObject({ revision: 2 });
    expect(narrowed.json.scopes.map((s: any) => s.scope)).not.toContain('read');
    // a merge that adds a scope the user never allowed goes through the consent screen again, even though the client is remembered
    await run({}, 'email'); // remember email for this client
    const widen = await authz(e, { client_id: c.client_id, redirect_uri: CB, response_type: 'code', scope: 'openid email', login_hint: user.id, grant_management_action: 'merge', grant_id: gid });
    expect(widen.location).toContain('/oauth2/authorize/consent');
    const merged = await post('/oauth2/token', { ...creds, grant_type: 'authorization_code', code: qs(await approve(e, post, widen.location)).get('code')!, redirect_uri: CB });
    expect(merged.json.grant_id).toBe(gid);
    expect(merged.json.scope.split(' ')).toEqual(expect.arrayContaining(['openid', 'email', 'grant_management_query']));
    expect((await raw(e, 'GET', `/oauth2/grants/${gid}`, { authorization: `Bearer ${merged.json.access_token}` })).json.revision).toBe(3);
    // refusals at authorize
    const bad = await authz(e, { client_id: c.client_id, redirect_uri: CB, response_type: 'code', scope: 'openid', login_hint: user.id, grant_management_action: 'merge', grant_id: 'ogm_nope' });
    expect(qs(bad.location).get('error')).toBe('invalid_grant');
    expect(qs((await authz(e, { client_id: c.client_id, redirect_uri: CB, response_type: 'code', login_hint: user.id, grant_id: gid })).location).get('error_description')).toBe('grant_id requires grant_management_action.');
    expect(qs((await authz(e, { client_id: c.client_id, redirect_uri: CB, response_type: 'code', login_hint: user.id, grant_management_action: 'create', grant_id: gid })).location).get('error_description')).toBe('grant_id must not be sent with grant_management_action=create.');
    // revoke: the grant, its refresh tokens and its access tokens all end
    expect((await raw(e, 'DELETE', `/oauth2/grants/${gid}`, auth)).status).toBe(204);
    expect((await raw(e, 'GET', `/oauth2/grants/${gid}`, auth)).status).toBe(401);
    expect((await post('/oauth2/token', { ...creds, grant_type: 'refresh_token', refresh_token: tok.json.refresh_token })).json.error).toBe('invalid_grant');
    expect((await post('/oauth2/introspect', { ...creds, token: merged.json.access_token })).json.active).toBe(false);
    expect(e.webhooks.events.some((x) => x.type === 'grant.revoked')).toBe(true);
  });

  it('needs the grant-management scope for each call and answers 404 for another client or user', async () => {
    const { e, post, user, c, creds } = await setup({ allowed_scopes: scopes });
    const a = await authz(e, { client_id: c.client_id, redirect_uri: CB, response_type: 'code', scope: 'openid grant_management_query', login_hint: user.id, grant_management_action: 'create' });
    const tok = await post('/oauth2/token', { ...creds, grant_type: 'authorization_code', code: qs(a.location).get('code')!, redirect_uri: CB });
    const auth = { authorization: `Bearer ${tok.json.access_token}` };
    expect((await raw(e, 'GET', `/oauth2/grants/${tok.json.grant_id}`, auth)).status).toBe(200);
    expect((await raw(e, 'DELETE', `/oauth2/grants/${tok.json.grant_id}`, auth)).json.error).toBe('insufficient_scope');
    const other = await setup({ allowed_scopes: scopes });
    const a2 = await authz(other.e, { client_id: other.c.client_id, redirect_uri: CB, response_type: 'code', scope: 'openid grant_management_query', login_hint: other.user.id, grant_management_action: 'create' });
    const t2 = await other.post('/oauth2/token', { ...other.creds, grant_type: 'authorization_code', code: qs(a2.location).get('code')!, redirect_uri: CB });
    // a second client in the first engine cannot read the first client's grant
    const second = (await client(e)('POST', '/v1/oauth_clients', { name: 'Two', redirect_uris: [CB], allowed_scopes: scopes, token_endpoint_auth_method: 'client_secret_post' })).json;
    const a3 = await authz(e, { client_id: second.client_id, redirect_uri: CB, response_type: 'code', scope: 'openid grant_management_query', login_hint: user.id });
    const t3 = await post('/oauth2/token', { client_id: second.client_id, client_secret: second.client_secret, grant_type: 'authorization_code', code: qs(a3.location).get('code')!, redirect_uri: CB });
    expect((await raw(e, 'GET', `/oauth2/grants/${tok.json.grant_id}`, { authorization: `Bearer ${t3.json.access_token}` })).status).toBe(404);
    expect(t2.status).toBe(200);
  });
});

describe('dynamic client registration', () => {
  const reg = (e: Engine, body: Record<string, unknown>, headers: Record<string, string> = {}) => raw(e, 'POST', '/oauth2/register', headers, body);

  it('is off until the instance enables it, and discovery advertises it only then', async () => {
    const { e, call } = await setup();
    expect(await reg(e, { redirect_uris: [CB] })).toMatchObject({ status: 403, json: { error: 'access_denied' } });
    await call('POST', '/__emulator/oauth/config', { dynamic_registration: true });
    expect(((await (await e.handle(new Request('http://x/.well-known/openid-configuration'))).json()) as any).registration_endpoint).toBe(`${e.issuer}/oauth2/register`);
    const ok = await reg(e, { redirect_uris: [CB], client_name: 'Dyn', scope: 'openid email' });
    expect(ok.status).toBe(201);
    expect(ok.json).toMatchObject({ client_name: 'Dyn', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'client_secret_basic', scope: 'openid email', client_secret_expires_at: 0 });
    expect(ok.json.client_id).toMatch(/^client_/);
    expect(ok.json.registration_access_token).toMatch(/^oarat_/);
    expect(ok.json.registration_client_uri).toBe(`${e.issuer}/oauth2/register/${ok.json.client_id}`);
    expect(ok.headers.get('cache-control')).toBe('no-store');
  });

  it('validates the metadata with the real error codes', async () => {
    const { e, call } = await setup();
    await call('POST', '/__emulator/oauth/config', { dynamic_registration: true });
    const err = async (body: Record<string, unknown>) => (await reg(e, body)).json;
    expect(await err({})).toMatchObject({ error: 'invalid_redirect_uri' });
    expect(await err({ redirect_uris: ['http://evil.example/cb'] })).toMatchObject({ error: 'invalid_redirect_uri' });
    expect(await err({ redirect_uris: [`${CB}#frag`] })).toMatchObject({ error: 'invalid_redirect_uri' });
    expect(await err({ redirect_uris: [CB], application_type: 'desktop' })).toMatchObject({ error: 'invalid_client_metadata' });
    expect(await err({ redirect_uris: [CB], scope: 'openid admin' })).toMatchObject({ error: 'invalid_client_metadata', error_description: 'Unsupported scope: admin.' });
    expect(await err({ redirect_uris: [CB], grant_types: ['client_credentials'] })).toMatchObject({ error: 'invalid_client_metadata', error_description: 'Unsupported grant_types: client_credentials.' });
    expect(await err({ redirect_uris: [CB], response_types: ['id_token'] })).toMatchObject({ error: 'invalid_client_metadata', error_description: 'response_type "id_token" needs the implicit grant_type.' });
    expect(await err({ redirect_uris: [CB], post_logout_redirect_uris: ['http://evil.example/'] })).toMatchObject({ error: 'invalid_client_metadata' });
    expect(await err({ redirect_uris: [CB], token_endpoint_auth_method: 'tls_client_auth' })).toMatchObject({ error: 'invalid_client_metadata' });
    const native = (await reg(e, { redirect_uris: ['com.example.app:/cb'], application_type: 'native' })).json;
    expect(native.token_endpoint_auth_method).toBe('none');
    expect(native.client_secret).toBeUndefined();
    expect((await reg(e, { redirect_uris: ['com.example.app:/cb'] })).json.error).toBe('invalid_redirect_uri'); // a web client may not use a private-use scheme
  });

  it('demands an initial access token when required and spends one use per registration', async () => {
    const { e, call } = await setup();
    await call('POST', '/__emulator/oauth/config', { dynamic_registration: true, require_initial_access_token: true });
    const none = await reg(e, { redirect_uris: [CB] });
    expect(none.status).toBe(401);
    expect(none.headers.get('www-authenticate')).toBe('Bearer error="invalid_token"');
    expect((await reg(e, { redirect_uris: [CB] }, { authorization: 'Bearer oiat_made_up' })).status).toBe(401);
    const iat = (await call('POST', '/v1/oauth_initial_access_tokens', { description: 'Partner', max_uses: 1, allowed_grant_types: ['authorization_code'], https_redirects_only: true })).json;
    expect(iat.token).toMatch(/^oiat_/);
    expect(iat).toMatchObject({ object: 'oauth_initial_access_token', status: 'active', max_uses: 1, use_count: 0 });
    const auth = { authorization: `Bearer ${iat.token}` };
    // a malformed or policy-violating registration never burns the use
    expect((await reg(e, { redirect_uris: ['http://localhost:3000/cb'], grant_types: ['authorization_code'] }, auth)).json.error).toBe('invalid_redirect_uri');
    expect((await reg(e, { redirect_uris: [CB], grant_types: ['authorization_code', 'refresh_token'] }, auth)).json).toMatchObject({ error: 'invalid_client_metadata', error_description: 'grant_type refresh_token is not allowed for this developer.' });
    expect((await call('GET', '/v1/oauth_initial_access_tokens')).json.data[0].use_count).toBe(0);
    expect((await reg(e, { redirect_uris: [CB], grant_types: ['authorization_code'] }, auth)).status).toBe(201);
    expect((await reg(e, { redirect_uris: [CB], grant_types: ['authorization_code'] }, auth)).json.error_description).toBe('The initial access token is invalid, expired, revoked or used up.');
    expect((await call('GET', '/v1/oauth_initial_access_tokens')).json.data[0]).toMatchObject({ status: 'used_up', use_count: 1 });
    const second = (await call('POST', '/v1/oauth_initial_access_tokens', { expires_in_seconds: 3600 })).json;
    expect((await call('DELETE', `/v1/oauth_initial_access_tokens/${second.id}`)).json.status).toBe('revoked');
    expect((await reg(e, { redirect_uris: [CB] }, { authorization: `Bearer ${second.token}` })).status).toBe(401);
    expect((await call('DELETE', '/v1/oauth_initial_access_tokens/oiat_nope')).status).toBe(404);
    expect((await call('POST', '/v1/oauth_initial_access_tokens', { expires_in_seconds: 5 })).status).toBeGreaterThanOrEqual(400);
    expect((await call('POST', '/v1/oauth_initial_access_tokens', { max_clients: 2 })).status).toBeGreaterThanOrEqual(400); // needs an owner
  });

  it('manages the registration with the registration access token only, and the client works', async () => {
    const { e, call, post, user } = await setup();
    await call('POST', '/__emulator/oauth/config', { dynamic_registration: true, dynamic_client_secret_ttl_seconds: 60 });
    const made = (await reg(e, { redirect_uris: [CB], client_name: 'Self managed', token_endpoint_auth_method: 'client_secret_post' })).json;
    expect(made.client_secret_expires_at).toBeGreaterThan(0);
    const rat = { authorization: `Bearer ${made.registration_access_token}` };
    const url = `/oauth2/register/${made.client_id}`;
    expect((await raw(e, 'GET', url, rat)).json).toMatchObject({ client_id: made.client_id, client_name: 'Self managed' });
    // unknown client, wrong token and a dashboard-made client are one answer
    const dash = (await call('POST', '/v1/oauth_clients', { name: 'Dash', redirect_uris: [CB] })).json;
    const wrong = await raw(e, 'GET', url, { authorization: 'Bearer wrong' });
    expect(wrong).toMatchObject({ status: 401, json: { error: 'invalid_token', error_description: 'Invalid registration access token.' } });
    expect((await raw(e, 'GET', '/oauth2/register/client_nope', rat)).json).toEqual(wrong.json);
    expect((await raw(e, 'GET', `/oauth2/register/${dash.client_id}`, rat)).json).toEqual(wrong.json);
    expect((await raw(e, 'GET', url)).status).toBe(401);
    // update
    const put = await raw(e, 'PUT', url, rat, { client_name: 'Renamed', redirect_uris: ['https://app.example/other'] });
    expect(put.json).toMatchObject({ client_name: 'Renamed', redirect_uris: ['https://app.example/other'] });
    expect((await raw(e, 'PUT', url, rat, { redirect_uris: ['http://evil.example/cb'] })).json.error).toBe('invalid_redirect_uri');
    expect((await raw(e, 'PUT', url, rat, { scope: 'openid admin' })).json.error).toBe('invalid_client_metadata');
    // the registered client signs a user in
    const a = await authz(e, { client_id: made.client_id, redirect_uri: 'https://app.example/other', response_type: 'code', scope: 'openid', login_hint: user.id });
    const tok = await post('/oauth2/token', { grant_type: 'authorization_code', code: qs(a.location).get('code')!, redirect_uri: 'https://app.example/other', client_id: made.client_id, client_secret: made.client_secret });
    expect(tok.status).toBe(200);
    // rotate: a new secret, the old one overlaps; the secret lifetime ends the client's authentication
    const rotated = (await raw(e, 'POST', `${url}/secret`, rat)).json;
    expect(rotated.client_secret).not.toBe(made.client_secret);
    expect(rotated.client_secret_expires_at).toBeGreaterThan(0);
    expect((await post('/oauth2/token', { grant_type: 'client_credentials', client_id: made.client_id, client_secret: rotated.client_secret })).json.error).not.toBe('invalid_client');
    await call('POST', '/__emulator/time/advance', { ms: 120_000 });
    expect((await post('/oauth2/token', { grant_type: 'client_credentials', client_id: made.client_id, client_secret: rotated.client_secret })).json.error).toBe('invalid_client');
    const publicClient = (await reg(e, { redirect_uris: [CB], token_endpoint_auth_method: 'none' })).json;
    expect((await raw(e, 'POST', `/oauth2/register/${publicClient.client_id}/secret`, { authorization: `Bearer ${publicClient.registration_access_token}` })).json.error).toBe('invalid_request');
    // delete
    expect((await raw(e, 'DELETE', url, rat)).status).toBe(204);
    expect((await raw(e, 'GET', url, rat)).status).toBe(401);
    expect((await authz(e, { client_id: made.client_id, redirect_uri: CB, response_type: 'code' })).status).toBe(400);
    expect((await post('/oauth2/introspect', { client_id: made.client_id, client_secret: rotated.client_secret, token: tok.json.access_token })).status).toBe(401);
  });

  it('caps what an owner may hold with max_clients and counts clients by owner', async () => {
    const { e, call } = await setup();
    await call('POST', '/__emulator/oauth/config', { dynamic_registration: true, require_initial_access_token: true });
    const iat = (await call('POST', '/v1/oauth_initial_access_tokens', { owner: 'user_dev', max_clients: 1 })).json;
    const auth = { authorization: `Bearer ${iat.token}` };
    expect((await reg(e, { redirect_uris: [CB] }, auth)).json.owner).toBe('user_dev');
    expect((await reg(e, { redirect_uris: [CB] }, auth)).json.error_description).toBe('This developer already holds the maximum of 1 clients.');
  });
});

describe('RP-initiated logout', () => {
  const setupLogout = async () => {
    const calls: Array<{ url: string; method?: string; body: string }> = [];
    const fetchSpy = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method, body: String(init?.body ?? '') });
      return new Response(null, { status: 204 });
    });
    const s = await setup({ post_logout_redirect_uris: ['https://app.example/bye'], backchannel_logout_uri: 'https://app.example/bcl' }, { fetch: fetchSpy as unknown as typeof fetch });
    const front = (await s.call('POST', '/v1/oauth_clients', { name: 'Front', redirect_uris: [CB], token_endpoint_auth_method: 'client_secret_post', frontchannel_logout_uri: 'https://front.example/logout', post_logout_redirect_uris: ['https://front.example/bye'] })).json;
    return { ...s, calls, front };
  };
  const logout = (e: Engine, params: Record<string, string>) => raw(e, 'GET', `/oauth2/logout?${new URLSearchParams(params)}`);

  it('ends the session, tells every client under it, then redirects with state echoed', async () => {
    const s = await setupLogout();
    const { e, c, user, post, creds, calls } = s;
    const tok = await login(s, c, user.id);
    const idClaims = ((await e.tokens.verifyAny(tok.json.id_token)) as any).claims;
    expect(idClaims.sid).toBeTruthy();
    const out = await logout(e, { id_token_hint: tok.json.id_token, post_logout_redirect_uri: 'https://app.example/bye', state: 'bye-1' });
    expect(out.status).toBe(302);
    expect(out.location).toBe('https://app.example/bye?state=bye-1');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: 'https://app.example/bcl', method: 'POST' });
    const logoutToken = decodeURIComponent(calls[0]!.body.replace('logout_token=', ''));
    const lc = ((await e.tokens.verifyAny(logoutToken)) as any).claims;
    expect(lc).toMatchObject({ aud: c.client_id, sub: user.id, sid: idClaims.sid, events: { 'http://schemas.openid.net/event/backchannel-logout': {} } });
    expect(lc.nonce).toBeUndefined();
    // the session's grants and tokens ended
    expect((await post('/oauth2/token', { ...creds, grant_type: 'refresh_token', refresh_token: tok.json.refresh_token })).json.error).toBe('invalid_grant');
    expect((await post('/oauth2/introspect', { ...creds, token: tok.json.access_token })).json.active).toBe(false);
    // a second logout of the same session is harmless and notifies nobody
    expect((await logout(e, { id_token_hint: tok.json.id_token, post_logout_redirect_uri: 'https://app.example/bye' })).status).toBe(302);
    expect(calls).toHaveLength(1);
  });

  it('honours a post_logout_redirect_uri only when the hint client registered it exactly, and never on a bad hint', async () => {
    const s = await setupLogout();
    const { e, c, user, post, creds } = s;
    const tok = await login(s, c, user.id);
    const unregistered = await logout(e, { id_token_hint: tok.json.id_token, post_logout_redirect_uri: 'https://evil.example/bye', state: 'x' });
    expect(unregistered.status).toBe(200);
    expect(unregistered.text).toContain('signed out');
    // another client's registered URI does not count
    const tok2 = await login(s, c, user.id);
    expect((await logout(e, { id_token_hint: tok2.json.id_token, post_logout_redirect_uri: 'https://front.example/bye' })).status).toBe(200);
    // a hint that fails validation ends nothing and ignores the redirect
    const tok3 = await login(s, c, user.id);
    const tampered = `${tok3.json.id_token.slice(0, -4)}AAAA`;
    const bad = await logout(e, { id_token_hint: tampered, client_id: c.client_id, post_logout_redirect_uri: 'https://app.example/bye' });
    expect(bad.status).toBe(200);
    expect(bad.location).toBeNull();
    expect((await post('/oauth2/token', { ...creds, grant_type: 'refresh_token', refresh_token: tok3.json.refresh_token })).status).toBe(200);
    // client_id must agree with the hint's audience
    expect((await logout(e, { id_token_hint: tok3.json.id_token, client_id: 'someone-else', post_logout_redirect_uri: 'https://app.example/bye' })).status).toBe(200);
    // without a hint nothing is ended
    expect((await logout(e, { client_id: c.client_id })).text).toContain('Sign out?');
  });

  it('loads front-channel logout URIs with iss and sid on the page instead of redirecting at once', async () => {
    const s = await setupLogout();
    const { e, c, user, front } = s;
    const t1 = await login(s, c, user.id);
    // the same OP session is shared by both clients
    const fr = await login(s, front, user.id);
    const sid = ((await e.tokens.verifyAny(fr.json.id_token)) as any).claims.sid;
    expect(((await e.tokens.verifyAny(t1.json.id_token)) as any).claims.sid).toBe(sid);
    const out = await logout(e, { id_token_hint: fr.json.id_token, post_logout_redirect_uri: 'https://front.example/bye', state: 'f1' });
    expect(out.status).toBe(200);
    expect(out.headers.get('content-type')).toContain('text/html');
    expect(out.text).toContain(`https://front.example/logout?iss=${encodeURIComponent(e.issuer)}&amp;sid=${sid}`);
    expect(out.text).toContain('https://front.example/bye?state=f1');
    expect(s.calls.some((x) => x.url === 'https://app.example/bcl')).toBe(true); // the other client was told too
  });

  it('accepts POST and an expired hint', async () => {
    const s = await setupLogout();
    const { e, c, user } = s;
    const tok = await login(s, c, user.id);
    e.clock.advance(3 * 3600_000);
    const res = await raw(e, 'POST', '/oauth2/logout', {}, { id_token_hint: tok.json.id_token, post_logout_redirect_uri: 'https://app.example/bye' });
    expect(res.status).toBe(302);
  });
});

describe('CIBA push mode', () => {
  const CIBA = 'urn:openid:params:grant-type:ciba';
  const NOTIFY = 'https://rp.example/ciba';
  const token = 'n'.repeat(24);
  const setupPush = async () => {
    const posts: Array<{ url: string; headers: Record<string, string>; body: any }> = [];
    const fetchSpy = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      posts.push({ url: String(url), headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)), body: JSON.parse(String(init?.body)) });
      return new Response(null, { status: 204 });
    });
    const s = await setup({ grant_types: ['authorization_code', 'refresh_token', CIBA], backchannel_token_delivery_mode: 'push', backchannel_client_notification_endpoint: NOTIFY }, { fetch: fetchSpy as unknown as typeof fetch });
    const session = (await s.call('POST', '/v1/sessions', { user_id: s.user.id })).json;
    const answer = (id: string, decision: string) => raw(s.e, 'POST', `/v1/client/me/backchannel_requests/${id}`, { authorization: `Bearer ${session.jwt}` }, { decision });
    return { ...s, posts, answer };
  };

  it('requires a client_notification_token of at least 128 bits, answers without an interval and refuses polling', async () => {
    const { post, user, creds } = await setupPush();
    const start = (extra: Record<string, string> = {}) => post('/oauth2/backchannel_authentication', { ...creds, login_hint: user.id, scope: 'openid', ...extra });
    expect((await start()).json.error).toBe('invalid_request');
    expect((await start({ client_notification_token: 'short' })).json.error).toBe('invalid_request');
    expect((await start({ client_notification_token: 'x'.repeat(21) })).status).toBe(400);
    const ok = await start({ client_notification_token: 'x'.repeat(22) });
    expect(ok.status).toBe(200);
    expect(ok.json.interval).toBeUndefined();
    expect(ok.json.expires_in).toBe(120);
    const poll = await post('/oauth2/token', { ...creds, grant_type: CIBA, auth_req_id: ok.json.auth_req_id });
    expect(poll.json).toMatchObject({ error: 'invalid_request', error_description: 'This request uses push delivery; the tokens are sent to the client notification endpoint.' });
  });

  it('delivers the token response to the notification endpoint on approval, and the refusal on denial', async () => {
    const { e, post, user, creds, posts, answer } = await setupPush();
    const a = (await post('/oauth2/backchannel_authentication', { ...creds, login_hint: user.id, scope: 'openid offline_access', client_notification_token: token })).json;
    const done = await answer(a.auth_req_id, 'approve');
    expect(done.json).toMatchObject({ status: 'approved' });
    expect(posts).toHaveLength(1);
    expect(posts[0]!.url).toBe(NOTIFY);
    expect(posts[0]!.headers.authorization).toBe(`Bearer ${token}`);
    expect(posts[0]!.body).toMatchObject({ auth_req_id: a.auth_req_id, token_type: 'Bearer', scope: 'openid offline_access' });
    expect(((await e.tokens.verifyAny(posts[0]!.body.access_token)) as any).ok).toBe(true);
    expect(posts[0]!.body.refresh_token).toBeTruthy();
    // delivered once: the request is spent
    expect((await answer(a.auth_req_id, 'approve')).status).toBeGreaterThanOrEqual(400);
    const b = (await post('/oauth2/backchannel_authentication', { ...creds, login_hint: user.id, client_notification_token: token })).json;
    expect((await answer(b.auth_req_id, 'deny')).json.status).toBe('denied');
    expect(posts[1]!.body).toEqual({ auth_req_id: b.auth_req_id, error: 'access_denied', error_description: 'The user denied the request.' });
  });

  it('ping delivers only the auth_req_id, and ping/push clients need an endpoint', async () => {
    const posts: any[] = [];
    const fetchSpy = vi.fn(async (_u: string | URL | Request, init?: RequestInit) => (posts.push(JSON.parse(String(init?.body))), new Response(null, { status: 204 })));
    const s = await setup({ grant_types: ['authorization_code', CIBA], backchannel_token_delivery_mode: 'ping', backchannel_client_notification_endpoint: NOTIFY }, { fetch: fetchSpy as unknown as typeof fetch });
    const session = (await s.call('POST', '/v1/sessions', { user_id: s.user.id })).json;
    const a = (await s.post('/oauth2/backchannel_authentication', { ...s.creds, login_hint: s.user.id, client_notification_token: token })).json;
    expect(a.interval).toBe(5);
    await raw(s.e, 'POST', `/v1/client/me/backchannel_requests/${a.auth_req_id}`, { authorization: `Bearer ${session.jwt}` }, { decision: 'approve' });
    expect(posts).toEqual([{ auth_req_id: a.auth_req_id }]);
    expect((await s.call('POST', '/v1/oauth_clients', { name: 'NoEndpoint', redirect_uris: [CB], backchannel_token_delivery_mode: 'push' })).status).toBeGreaterThanOrEqual(400);
  });

  it('accepts a signed authentication request and enforces require_signed_request_object', async () => {
    const key = ec();
    const s = await setup({ grant_types: ['authorization_code', CIBA], jwks: { keys: [{ ...key.jwk, kid: 'k1' }] }, require_signed_request_object: true });
    expect((await s.post('/oauth2/backchannel_authentication', { ...s.creds, login_hint: s.user.id })).json).toMatchObject({ error: 'invalid_request', error_description: 'This client must send a signed authentication request.' });
    const request = es256(key.privateKey, { alg: 'ES256', kid: 'k1' }, { iss: s.c.client_id, aud: s.e.issuer, login_hint: s.user.id, scope: 'openid', requested_expiry: 90 });
    const ok = await s.post('/oauth2/backchannel_authentication', { ...s.creds, request });
    expect(ok.status).toBe(200);
    expect(ok.json.expires_in).toBe(90);
  });
});

describe('UMA 2.0', () => {
  const UMA = 'urn:ietf:params:oauth:grant-type:uma-ticket';
  const setupUma = async () => {
    const s = await setup({ name: 'Resource server', grant_types: ['authorization_code', 'refresh_token', 'client_credentials'] });
    const userB = (await s.call('POST', '/v1/users', { email_address: 'bob@example.com', password: 'Correct-horse-9-battery' })).json;
    const rp = (await s.call('POST', '/v1/oauth_clients', { name: 'Requesting app', redirect_uris: [CB], grant_types: ['authorization_code', 'refresh_token'], token_endpoint_auth_method: 'client_secret_post', claims_redirect_uris: ['https://rp.example/claims'] })).json;
    return { ...s, userB, rp };
  };
  const pat = async (s: Awaited<ReturnType<typeof setupUma>>) => (await s.post('/oauth2/token', { ...s.creds, grant_type: 'client_credentials', scope: 'uma_protection' })).json;

  it('is off until enabled', async () => {
    const s = await setupUma();
    expect((await raw(s.e, 'GET', '/.well-known/uma2-configuration')).status).toBe(404);
    expect((await pat(s)).error).toBe('invalid_scope'); // uma_protection is just an unknown scope while UMA is off
    await s.call('POST', '/__emulator/oauth/config', { uma_enabled: true });
    const doc = (await raw(s.e, 'GET', '/.well-known/uma2-configuration')).json;
    expect(doc).toMatchObject({ resource_registration_endpoint: `${s.e.issuer}/oauth2/uma/resource_set`, permission_endpoint: `${s.e.issuer}/oauth2/uma/permission`, claims_interaction_endpoint: `${s.e.issuer}/oauth2/uma/claims` });
    expect(((await (await s.e.handle(new Request('http://x/.well-known/openid-configuration'))).json()) as any).grant_types_supported).toContain(UMA);
  });

  it('issues a protection API token only for uma_protection and only to confidential clients', async () => {
    const s = await setupUma();
    await s.call('POST', '/__emulator/oauth/config', { uma_enabled: true });
    expect(await pat(s)).toMatchObject({ token_type: 'Bearer', scope: 'uma_protection', expires_in: 3600 });
    expect((await s.post('/oauth2/token', { ...s.creds, grant_type: 'client_credentials', scope: 'uma_protection read' })).json.error).toBe('invalid_scope');
    const pub = (await s.call('POST', '/v1/oauth_clients', { name: 'Pub', redirect_uris: [CB], token_endpoint_auth_method: 'none' })).json;
    expect((await s.post('/oauth2/token', { client_id: pub.client_id, grant_type: 'client_credentials', scope: 'uma_protection' })).status).toBe(401);
  });

  it('registers resources, hands out permission tickets and trades them for an RPT per the owner and shares', async () => {
    const s = await setupUma();
    const { e, call, post, user, userB, rp } = s;
    await call('POST', '/__emulator/oauth/config', { uma_enabled: true });
    const auth = { authorization: `Bearer ${(await pat(s)).access_token}` };
    // the protection API needs the PAT
    const denied = await raw(e, 'POST', '/oauth2/uma/resource_set', {}, { name: 'Doc' });
    expect(denied).toMatchObject({ status: 401 });
    expect(denied.headers.get('www-authenticate')).toContain('uma_protection');
    const plain = (await post('/oauth2/token', { ...s.creds, grant_type: 'client_credentials' })).json;
    expect((await raw(e, 'GET', '/oauth2/uma/resource_set', { authorization: `Bearer ${plain.access_token}` })).status).toBe(403);
    expect((await raw(e, 'POST', '/oauth2/uma/resource_set', auth, { resource_scopes: ['read'] })).status).toBe(400);
    const made = await raw(e, 'POST', '/oauth2/uma/resource_set', auth, { name: 'Report', type: 'doc', resource_scopes: ['read', 'write'], owner: user.id });
    expect(made.status).toBe(201);
    const rid = made.json._id;
    expect(made.headers.get('location')).toBe(`${e.issuer}/oauth2/uma/resource_set/${rid}`);
    expect((await raw(e, 'GET', '/oauth2/uma/resource_set', auth)).json).toEqual([rid]);
    expect((await raw(e, 'GET', `/oauth2/uma/resource_set/${rid}`, auth)).json).toMatchObject({ _id: rid, name: 'Report', resource_scopes: ['read', 'write'], owner: user.id });
    expect((await raw(e, 'PUT', `/oauth2/uma/resource_set/${rid}`, auth, { name: 'Report v2', resource_scopes: ['read', 'write'] })).json.name).toBe('Report v2');
    expect((await raw(e, 'GET', '/oauth2/uma/resource_set/umar_nope', auth)).status).toBe(404);
    const ticketFor = async (scopes: string[]) => (await raw(e, 'POST', '/oauth2/uma/permission', auth, { resource_id: rid, resource_scopes: scopes })).json.ticket as string;
    expect((await raw(e, 'POST', '/oauth2/uma/permission', auth, { resource_id: rid, resource_scopes: ['delete'] })).json.errors[0].code).toBe('invalid_scope');
    expect((await raw(e, 'POST', '/oauth2/uma/permission', auth, { resource_id: 'umar_nope' })).json.errors[0].code).toBe('invalid_resource_id');
    // the requesting party is identified by an ID token the requesting app holds
    const idOf = async (userId: string) => (await login(s, rp, userId, 'openid')).json.id_token as string;
    const rpCreds = { client_id: rp.client_id, client_secret: rp.client_secret };
    const exchange = (fields: Record<string, string>) => post('/oauth2/token', { ...rpCreds, grant_type: UMA, ...fields });
    // no party yet: need_info with a fresh ticket
    const t1 = await ticketFor(['read', 'write']);
    const info = await exchange({ ticket: t1 });
    expect(info).toMatchObject({ status: 403, json: { error: 'need_info', redirect_user: `${e.issuer}/oauth2/uma/claims` } });
    expect((await exchange({ ticket: t1 })).json.error).toBe('invalid_grant'); // the old ticket is gone
    // the owner holds everything
    const owner = await exchange({ ticket: info.json.ticket, claim_token: await idOf(user.id), claim_token_format: 'http://openid.net/specs/openid-connect-core-1_0.html#IDToken' });
    expect(owner.status).toBe(200);
    expect(owner.json).toMatchObject({ token_type: 'Bearer', upgraded: false, expires_in: 300 });
    const rptClaims = ((await e.tokens.verifyAny(owner.json.access_token)) as any).claims;
    expect(rptClaims.permissions[0]).toMatchObject({ resource_id: rid, resource_scopes: ['read', 'write'] });
    expect(rptClaims.uma_rs).toBe(s.c.client_id);
    // the resource server introspects the RPT
    expect((await post('/oauth2/introspect', { ...s.creds, token: owner.json.access_token })).json).toMatchObject({ active: true, permissions: [{ resource_id: rid }] });
    // a spent ticket cannot be reused
    expect((await exchange({ ticket: info.json.ticket, claim_token: await idOf(user.id) })).json.error).toBe('invalid_grant');
    // another party has nothing until the owner shares; the share grants only what it names
    const idB = await idOf(userB.id);
    expect((await exchange({ ticket: await ticketFor(['read']), claim_token: idB })).json).toMatchObject({ error: 'request_denied' });
    await call('POST', '/__emulator/oauth/uma/share', { resource_id: rid, user_id: userB.id, scopes: ['read'] });
    const shared = await exchange({ ticket: await ticketFor(['read', 'write']), claim_token: idB });
    expect(((await e.tokens.verifyAny(shared.json.access_token)) as any).claims.permissions[0].resource_scopes).toEqual(['read']);
    // the persisted claims token skips claims gathering next time
    const again = await exchange({ ticket: await ticketFor(['read']), pct: shared.json.pct });
    expect(again.status).toBe(200);
    // an earlier RPT upgrades: carried scopes are re-checked against what the party holds now
    await call('POST', '/__emulator/oauth/uma/share', { resource_id: rid, user_id: userB.id, scopes: ['read', 'write'] });
    const up = await exchange({ ticket: await ticketFor(['write']), pct: shared.json.pct, rpt: shared.json.access_token });
    expect(up.json.upgraded).toBe(true);
    expect(((await e.tokens.verifyAny(up.json.access_token)) as any).claims.permissions[0].resource_scopes.sort()).toEqual(['read', 'write']);
    // validation
    expect((await exchange({})).json.error).toBe('invalid_request');
    expect((await exchange({ ticket: await ticketFor(['read']), claim_token_format: 'x' })).json.error).toBe('invalid_request');
    expect((await exchange({ ticket: await ticketFor(['read']), claim_token: 'not-a-token' })).json.error).toBe('request_denied');
    expect((await raw(e, 'DELETE', `/oauth2/uma/resource_set/${rid}`, auth)).status).toBe(204);
    expect((await raw(e, 'GET', `/oauth2/uma/resource_set/${rid}`, auth)).status).toBe(404);
  });

  it('gathers claims by sending the requesting party back to a registered claims redirect with a ticket bound to them', async () => {
    const s = await setupUma();
    const { e, call, post, user, userB, rp } = s;
    await call('POST', '/__emulator/oauth/config', { uma_enabled: true });
    const auth = { authorization: `Bearer ${(await pat(s)).access_token}` };
    const rid = (await raw(e, 'POST', '/oauth2/uma/resource_set', auth, { name: 'Doc', resource_scopes: ['read'], owner: user.id })).json._id;
    await call('POST', '/__emulator/oauth/uma/share', { resource_id: rid, user_id: userB.id, scopes: ['read'] });
    const ticket = (await raw(e, 'POST', '/oauth2/uma/permission', auth, { resource_id: rid })).json.ticket;
    const claims = (params: Record<string, string>) => raw(e, 'GET', `/oauth2/uma/claims?${new URLSearchParams({ client_id: rp.client_id, ...params })}`);
    expect((await claims({ ticket: 'nope' })).status).toBe(400);
    expect((await claims({ ticket, claims_redirect_uri: 'https://evil.example/claims' })).status).toBe(400);
    const denied = await claims({ ticket, state: 's1', login_hint: userB.id, emulator_decision: 'deny' });
    expect(qs(denied.location).get('error')).toBe('access_denied');
    const back = await claims({ ticket, state: 's2', login_hint: userB.id });
    expect(back.location).toMatch(/^https:\/\/rp\.example\/claims\?/);
    expect(qs(back.location).get('state')).toBe('s2');
    const rpt = await post('/oauth2/token', { client_id: rp.client_id, client_secret: rp.client_secret, grant_type: UMA, ticket: qs(back.location).get('ticket')! });
    expect(rpt.status).toBe(200);
    expect(((await e.tokens.verifyAny(rpt.json.access_token)) as any).claims.sub).toBe(userB.id);
  });
});

describe('parity coverage', () => {
  it('lists a request for every new route pattern', () => {
    const covered = (method: string, re: RegExp) => emu3OauthParityRequests.some((r) => r.method === method && re.test(r.path.split('?')[0]!));
    for (const [method, re] of [
      ['POST', /^\/oauth2\/register$/],
      ['GET', /^\/oauth2\/register\/[^/]+$/],
      ['PUT', /^\/oauth2\/register\/[^/]+$/],
      ['DELETE', /^\/oauth2\/register\/[^/]+$/],
      ['POST', /^\/oauth2\/register\/[^/]+\/secret$/],
      ['GET', /^\/oauth2\/logout$/],
      ['POST', /^\/oauth2\/logout$/],
      ['GET', /^\/oauth2\/grants\/[^/]+$/],
      ['PATCH', /^\/oauth2\/grants\/[^/]+$/],
      ['DELETE', /^\/oauth2\/grants\/[^/]+$/],
      ['GET', /^\/v1\/oauth_initial_access_tokens$/],
      ['POST', /^\/v1\/oauth_initial_access_tokens$/],
      ['DELETE', /^\/v1\/oauth_initial_access_tokens\/[^/]+$/],
      ['GET', /^\/\.well-known\/uma2-configuration$/],
      ['POST', /^\/oauth2\/uma\/resource_set$/],
      ['GET', /^\/oauth2\/uma\/resource_set$/],
      ['GET', /^\/oauth2\/uma\/resource_set\/[^/]+$/],
      ['PUT', /^\/oauth2\/uma\/resource_set\/[^/]+$/],
      ['DELETE', /^\/oauth2\/uma\/resource_set\/[^/]+$/],
      ['POST', /^\/oauth2\/uma\/permission$/],
      ['GET', /^\/oauth2\/uma\/claims$/],
    ] as const) expect(covered(method, re), `${method} ${re}`).toBe(true);
    expect(emu3OauthParityRequests.every((r) => r.group === 'oauth_flows')).toBe(true);
  });
});
