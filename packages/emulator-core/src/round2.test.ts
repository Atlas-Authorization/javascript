/* eslint-disable @typescript-eslint/no-explicit-any */
import { generateKeyPairSync, sign as nodeSign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { annotateCoverage, coverageList } from './coverage';
import { pkceChallenge } from './crypto-util';
import { GATED_EVENTS } from './event-gate';
import { defaultParityRequests, runParity } from './parity';
import { fullParityRequests, uncoveredRoutes } from './parity-routes';
import { KEY, client, makeEngine, snapshot } from './test-support';
import { createVirtualAuthenticator } from './webauthn-virtual';
import { subscribed } from './webhooks';
import type { Engine } from './engine';

const CB = 'https://app.example/callback';

/** An RFC 6749 form POST straight into the engine. */
const form = (e: Engine) => async (path: string, fields: Record<string, string>, headers: Record<string, string> = {}) => {
  const res = await e.handle(new Request(`http://emulator.test${path}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams(fields).toString() }));
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null, headers: res.headers };
};
const authorize = async (e: Engine, params: Record<string, string>) => {
  const res = await e.handle(new Request(`http://emulator.test/oauth2/authorize?${new URLSearchParams(params)}`));
  return { status: res.status, location: res.headers.get('location'), json: res.status === 302 ? null : await res.json() };
};

describe('webhook wildcard gating', () => {
  it('lets `*` skip events added after the endpoint unless it opts in; naming always delivers', () => {
    const gated = GATED_EVENTS[0]!;
    const before = Date.parse('2026-11-14T00:00:00Z');
    const after = Date.parse('2026-11-16T00:00:00Z');
    expect(subscribed(['*'], gated, before)).toBe(false);
    expect(subscribed(['*'], gated, after)).toBe(true);
    expect(subscribed(['*', 'include_new_event_types'], gated, before)).toBe(true);
    expect(subscribed([gated], gated, before)).toBe(true);
    expect(subscribed(['*'], 'user.created', before)).toBe(true);
    expect(subscribed(['user.updated'], 'user.created', after)).toBe(false);
  });

  it('applies it on delivery: an old `*` endpoint misses a gated event, an opted-in one gets it', async () => {
    const delivered: string[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => (delivered.push(`${url}|${JSON.parse(String(init.body)).type}`), new Response('ok'))) as unknown as typeof fetch;
    const e = makeEngine({ fetch: fetchImpl, now: () => Date.parse('2026-11-14T00:00:00Z') });
    const call = client(e);
    await call('POST', '/v1/webhook_endpoints', { url: 'https://old.example/h', enabled_events: ['*'] });
    await call('POST', '/v1/webhook_endpoints', { url: 'https://opt.example/h', enabled_events: ['*', 'include_new_event_types'] });
    e.webhooks.emit('signing_key.rotated', { kid: 'k' });
    e.webhooks.emit('user.created', { id: 'u' });
    await e.flush();
    expect(delivered.filter((d) => d.startsWith('https://old.example')).map((d) => d.split('|')[1])).toEqual(['user.created']);
    expect(delivered.filter((d) => d.startsWith('https://opt.example')).map((d) => d.split('|')[1]).sort()).toEqual(['signing_key.rotated', 'user.created']);
  });
});

describe('machine device-key flow', () => {
  const setup = async () => {
    const e = makeEngine();
    const call = client(e);
    const pair = generateKeyPairSync('ed25519');
    const pem = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const tok = (await call('POST', '/v1/machine_enrolment_tokens', { max_uses: 2 })).json;
    const anon = client(e, null);
    return { e, call, anon, pair, pem, tok };
  };
  const signNonce = (pair: ReturnType<typeof generateKeyPairSync>, nonce: string) => nodeSign(null, Buffer.from(nonce), pair.privateKey).toString('base64url');

  it('enrols with a token, signs a challenge and gets a JWKS-verifiable machine token bound to a grant', async () => {
    const { e, call, anon, pair, pem, tok } = await setup();
    expect(tok.secret).toMatch(/^met_/);
    const m = (await anon('POST', '/v1/machines/enroll', { enrolment_token: tok.secret, public_key_pem: pem, name: 'edge-1', device_key: 'dev-1' })).json;
    expect(m).toMatchObject({ object: 'machine', status: 'active', approval_required: false, device_key: 'dev-1' });
    expect(m.public_key_jkt).toBeTruthy();
    await call('POST', '/v1/resource_servers', { identifier: 'https://api.example', name: 'API', scopes: [{ name: 'read' }, { name: 'write' }] });
    await call('POST', `/v1/machines/${m.id}/grants`, { resource_server_id: 'https://api.example', scopes: ['read', 'write'] });
    const nonce = (await anon('POST', '/v1/machines/challenge', { machine_id: m.id })).json.nonce;
    // a wrong signature is refused and does not spend the nonce
    const bad = await anon('POST', '/v1/machines/token', { machine_id: m.id, nonce, signature: signNonce(generateKeyPairSync('ed25519'), nonce) });
    expect(bad.status).toBe(400);
    const ok = await anon('POST', '/v1/machines/token', { machine_id: m.id, nonce, signature: signNonce(pair, nonce), audience: 'https://api.example', scopes: ['read'] });
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({ object: 'machine_token', token_type: 'Bearer', audience: 'https://api.example', scope: 'read' });
    const claims = (await e.tokens.verifyAny(ok.json.token)) as any;
    expect(claims.claims).toMatchObject({ sub: m.id, token_use: 'm2m', aud: 'https://api.example', scope: 'read', grant_type: 'machine' });
    expect(claims.claims.grants[0]).toMatchObject({ type: 'machine', resource: 'https://api.example', scopes: ['read'] });
    // single use: the nonce cannot mint again
    expect((await anon('POST', '/v1/machines/token', { machine_id: m.id, nonce, signature: signNonce(pair, nonce) })).json.errors[0].code).toBe('VALIDATION_FAILED');
    // the BAPI verify reads the JWT too, and reports the machine's grants
    const v = (await call('POST', '/v1/m2m_tokens/verify', { token: ok.json.token })).json;
    expect(v).toMatchObject({ object: 'm2m_verification', valid: true, machine_id: m.id, audience: 'https://api.example', scopes: ['read'] });
    expect(v.grants[0].scopes).toEqual(['read', 'write']);
    // a scope outside the grant is refused, not dropped
    const n2 = (await anon('POST', '/v1/machines/challenge', { machine_id: m.id })).json.nonce;
    expect((await anon('POST', '/v1/machines/token', { machine_id: m.id, nonce: n2, signature: signNonce(pair, n2), audience: 'https://api.example', scopes: ['admin'] })).status).toBe(403);
    // a revoked machine's token no longer verifies
    await call('POST', `/v1/machines/${m.id}/revoke`);
    expect((await call('POST', '/v1/m2m_tokens/verify', { token: ok.json.token })).json.valid).toBe(false);
  });

  it('holds an approval-gated device pending, supersedes a re-enrolment of the same device_key, honours caps and user codes', async () => {
    const { e, call, anon, pem } = await setup();
    const gated = (await call('POST', '/v1/machine_enrolment_tokens', { requires_approval: true, max_uses: 5 })).json;
    const pending = (await anon('POST', '/v1/machines/enroll', { enrolment_token: gated.secret, public_key_pem: pem, device_key: 'dev-9' })).json;
    expect(pending).toMatchObject({ status: 'pending', approval_required: true });
    const n = (await anon('POST', '/v1/machines/challenge', { machine_id: pending.id })).json.nonce;
    expect((await anon('POST', '/v1/machines/token', { machine_id: pending.id, nonce: n, signature: 'x' })).status).toBe(403);
    const again = (await anon('POST', '/v1/machines/enroll', { enrolment_token: gated.secret, public_key_pem: pem, device_key: 'dev-9' })).json;
    expect((await call('GET', `/v1/machines/${pending.id}`)).json.status).toBe('revoked');
    expect(again.id).not.toBe(pending.id);
    expect(e.webhooks.events.some((x) => x.type === 'machine.revoked' && x.payload.data.reason === 'superseded')).toBe(true);
    const code = (await call('POST', '/v1/machine_enrolment_tokens', { format: 'user_code' })).json;
    expect(code.user_code).toMatch(/^[A-Z]{4}-[A-Z]{4}$/);
    const redeemed = await anon('POST', '/v1/machines/redeem', { enrolment_token: code.user_code.toLowerCase().replace('-', ' ') });
    expect(redeemed.json).toMatchObject({ object: 'machine_enrolment_redemption', id: code.id });
    expect((await anon('POST', '/v1/machines/redeem', { enrolment_token: code.user_code })).json.errors[0].code).toBe('ENROLMENT_TOKEN_EXHAUSTED');
    expect((await anon('POST', '/v1/machines/enroll', { enrolment_token: 'met_nope', public_key_pem: pem })).json.errors[0].code).toBe('ENROLMENT_TOKEN_INVALID');
    expect((await anon('POST', '/v1/machines/enroll', { enrolment_token: gated.secret, public_key_pem: 'not a key' })).status).toBe(400);
  });
});

describe('agents and agent grants', () => {
  it('registers, auto-approves for a trusted agent, mints a token carrying the grant, and counts usage on /v1/grants/agent', async () => {
    const e = makeEngine();
    const call = client(e);
    const anon = client(e, null);
    expect((await anon('POST', '/v1/agents/register', { identity: 'anonymous', name: 'a' })).status).toBe(404); // disabled instances do not reveal themselves
    await call('PUT', '/v1/agent_registration', { enabled: true, allow_anonymous: true, allow_service_auth: true, untrusted_scopes: ['read'], trusted_scopes: ['read', 'write'], auto_approve_rules: [{ kind: 'tool', resource: 'tool:*' }] });
    const user = (await call('POST', '/v1/users', { email_address: 'owner@example.com' })).json;
    const stranger = (await anon('POST', '/v1/agents/register', { identity: 'anonymous', name: 'anon' })).json;
    expect(stranger).toMatchObject({ tier: 'untrusted', scopes: ['read'] });
    const trusted = (await call('POST', '/v1/agents/register', { identity: 'service_auth', name: 'svc', owner_user_id: user.id })).json;
    expect(trusted).toMatchObject({ tier: 'trusted', owner_user_id: user.id });
    expect((await anon('POST', '/v1/agents/register', { identity: 'service_auth', name: 'x' })).status).toBe(401);
    const req = (await anon('POST', '/v1/agents/access_requests', { agent_id: trusted.id, agent_secret: trusted.secret, kind: 'tool', resource: 'tool:search', scopes: ['read'], constraints: { counters: { calls: { limit: 2, window: 'day' } } } })).json;
    expect(req).toMatchObject({ status: 'approved', auto_approved: true });
    // an untrusted agent's request waits for an approver
    const waiting = (await anon('POST', '/v1/agents/access_requests', { agent_id: stranger.id, agent_secret: stranger.secret, kind: 'tool', resource: 'tool:search', scopes: ['read'] })).json;
    expect(waiting.status).toBe('pending');
    expect((await call('POST', `/v1/agent_access_requests/${waiting.id}/approve`, { expires_in_seconds: 3600 })).json.status).toBe('approved');
    expect((await call('POST', `/v1/agent_access_requests/${waiting.id}/deny`)).status).toBe(409);
    const tok = (await anon('POST', '/v1/agents/token', { agent_id: trusted.id, agent_secret: trusted.secret })).json;
    const claims = ((await e.tokens.verifyAny(tok.token)) as any).claims;
    expect(claims.grants[0]).toMatchObject({ type: 'agent', id: req.id, resource: 'tool:search', kind: 'tool' });
    expect(claims.agent_grants[0]).toMatchObject({ grant_id: req.id, grant_type: 'agent' });
    // usage counters work on agent grants (they answered 404 before)
    const c1 = await call('POST', `/v1/grants/agent/${req.id}/consume`, { counter: 'calls', idempotency_key: 'k1' });
    expect(c1.json).toMatchObject({ allowed: true, used: 1, remaining: 1 });
    await call('POST', `/v1/grants/agent/${req.id}/consume`, { counter: 'calls', idempotency_key: 'k2' });
    expect((await call('POST', `/v1/grants/agent/${req.id}/consume`, { counter: 'calls', idempotency_key: 'k3' })).json).toMatchObject({ allowed: false, reason: 'limit_reached' });
    expect((await call('GET', `/v1/grants/agent/${req.id}/usage`)).json).toMatchObject({ grant_type: 'agent', grant_id: req.id, machine_id: trusted.id });
    expect((await call('POST', '/v1/grants/agent/areq_missing/consume', { counter: 'calls', idempotency_key: 'z' })).status).toBe(404);
    // revoking access ends the grants
    await call('POST', `/v1/agents/${trusted.id}/revoke_access`, {});
    expect((await call('GET', `/v1/grants/agent/${req.id}/usage`)).status).toBe(404);
    // claim ceremony: a backend claim promotes and sets the owner
    expect((await call('POST', `/v1/agents/${stranger.id}/claim`, { user_id: user.id })).json).toMatchObject({ tier: 'trusted', owner_user_id: user.id });
  });
});

describe('session refresh on the real Frontend API route', () => {
  it('rotates by cookie or body, replays within the grace window, and revokes on theft', async () => {
    const e = makeEngine();
    const call = client(e);
    const anon = client(e, null);
    const u = (await call('POST', '/v1/users', { email_address: 'rf2@example.com' })).json;
    const s = (await call('POST', '/v1/sessions', { user_id: u.id })).json;
    const r1 = await anon('POST', `/v1/client/sessions/${s.id}/tokens`, { refresh_token: s.refresh_token });
    expect(r1.status).toBe(200);
    expect(r1.json).toMatchObject({ object: 'session_tokens', session_id: s.id });
    expect(r1.json.refresh_token).not.toBe(s.refresh_token);
    expect((await e.tokens.verify(r1.json.jwt)).ok).toBe(true);
    expect(r1.headers.getSetCookie().some((c) => c.startsWith('__atlas_rt='))).toBe(true);
    // a cookie caller does not get the token in the body; the cookie carries it
    const viaCookie = await anon('POST', `/v1/client/sessions/${s.id}/tokens`, undefined, { cookie: `__atlas_rt=${r1.json.refresh_token}` });
    expect(viaCookie.json.refresh_token).toBeUndefined();
    expect(viaCookie.headers.getSetCookie().find((c) => c.startsWith('__atlas_rt='))).toBeTruthy();
    // the id in the path must be the token's session
    expect((await anon('POST', '/v1/client/sessions/sess_other/tokens', { refresh_token: r1.json.refresh_token })).status).toBe(404);
    // replay inside the grace window is idempotent: the successor already issued
    const replay = await anon('POST', `/v1/client/sessions/${s.id}/tokens`, { refresh_token: s.refresh_token });
    expect(replay.json.refresh_token).toBe(r1.json.refresh_token);
    await call('POST', '/__emulator/time/advance', { ms: 31_000 });
    const theft = await anon('POST', `/v1/client/sessions/${s.id}/tokens`, { refresh_token: s.refresh_token });
    expect(theft.json.errors[0].code).toBe('REFRESH_REUSE_DETECTED');
    expect((await call('GET', `/v1/sessions/${s.id}`)).json.status).toBe('revoked');
    expect((await call('GET', '/v1/sessions/revocations')).json.data[0]).toMatchObject({ sid: s.id, reason: 'refresh_token_reuse' });
  });
});

describe('OAuth provider', () => {
  const setup = async (clientBody: Record<string, unknown> = {}) => {
    const e = makeEngine();
    const call = client(e);
    const post = form(e);
    const user = (await call('POST', '/v1/users', { email_address: 'oauth@example.com', first_name: 'Ada' })).json;
    const c = (await call('POST', '/v1/oauth_clients', { name: 'App', redirect_uris: [CB], grant_types: ['authorization_code', 'refresh_token', 'client_credentials'], allowed_scopes: ['openid', 'email', 'profile', 'offline_access', 'read'], ...clientBody })).json;
    return { e, call, post, user, c };
  };
  const verifier = 'v'.repeat(48);

  it('serves discovery and the JWKS, and runs code + PKCE to signed tokens', async () => {
    const { e, post, user, c } = await setup();
    const doc = (await (await e.handle(new Request('http://x/.well-known/openid-configuration'))).json()) as any;
    expect(doc).toMatchObject({ code_challenge_methods_supported: ['S256'], revocation_endpoint: expect.stringContaining('/oauth2/revoke'), introspection_endpoint: expect.stringContaining('/oauth2/introspect') });
    const a = await authorize(e, { client_id: c.client_id, redirect_uri: CB, response_type: 'code', scope: 'openid email offline_access', state: 's1', nonce: 'n1', code_challenge: await pkceChallenge(verifier), code_challenge_method: 'S256', login_hint: 'oauth@example.com' });
    expect(a.status).toBe(302);
    const back = new URL(a.location!);
    expect(back.searchParams.get('state')).toBe('s1');
    expect(back.searchParams.get('iss')).toBe(e.issuer);
    const code = back.searchParams.get('code')!;
    expect((await post('/oauth2/token', { grant_type: 'authorization_code', code, redirect_uri: CB, client_id: c.client_id, client_secret: c.client_secret, code_verifier: 'wrong' })).json.error).toBe('invalid_grant');
    const code2 = new URL((await authorize(e, { client_id: c.client_id, redirect_uri: CB, response_type: 'code', scope: 'openid email offline_access', code_challenge: await pkceChallenge(verifier), code_challenge_method: 'S256', login_hint: user.id, nonce: 'n2' })).location!).searchParams.get('code')!;
    const tok = await post('/oauth2/token', { grant_type: 'authorization_code', code: code2, redirect_uri: CB, client_id: c.client_id, client_secret: c.client_secret, code_verifier: verifier });
    expect(tok.status).toBe(200);
    expect(tok.json).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: 'openid email offline_access' });
    const id = ((await e.tokens.verifyAny(tok.json.id_token)) as any).claims;
    expect(id).toMatchObject({ sub: user.id, aud: c.client_id, nonce: 'n2', email: 'oauth@example.com', email_verified: true });
    const access = ((await e.tokens.verifyAny(tok.json.access_token)) as any).claims;
    expect(access).toMatchObject({ sub: user.id, client_id: c.client_id, scope: 'openid email offline_access' });
    // the code is single use, and replaying it revokes what it produced (RFC 6749 4.1.2)
    expect((await post('/oauth2/token', { grant_type: 'authorization_code', code: code2, redirect_uri: CB, client_id: c.client_id, client_secret: c.client_secret, code_verifier: verifier })).json.error).toBe('invalid_grant');
    const intro = await post('/oauth2/introspect', { token: tok.json.access_token, client_id: c.client_id, client_secret: c.client_secret });
    expect(intro.json.active).toBe(false);
  });

  it('userinfo, introspection, refresh rotation with reuse detection, revocation', async () => {
    const { e, post, user, c } = await setup();
    const issue = async () => {
      const code = new URL((await authorize(e, { client_id: c.client_id, redirect_uri: CB, response_type: 'code', scope: 'openid email offline_access', code_challenge: await pkceChallenge(verifier), code_challenge_method: 'S256', login_hint: user.id })).location!).searchParams.get('code')!;
      return (await post('/oauth2/token', { grant_type: 'authorization_code', code, redirect_uri: CB, client_id: c.client_id, client_secret: c.client_secret, code_verifier: verifier })).json;
    };
    const t = await issue();
    const ui = await e.handle(new Request('http://x/oauth2/userinfo', { headers: { authorization: `Bearer ${t.access_token}` } }));
    expect(await ui.json()).toMatchObject({ sub: user.id, email: 'oauth@example.com' });
    expect((await e.handle(new Request('http://x/oauth2/userinfo'))).status).toBe(401);
    const creds = { client_id: c.client_id, client_secret: c.client_secret };
    expect((await post('/oauth2/introspect', { token: t.access_token, ...creds })).json).toMatchObject({ active: true, client_id: c.client_id, sub: user.id });
    // a wrong secret is invalid_client
    expect((await post('/oauth2/introspect', { token: t.access_token, client_id: c.client_id, client_secret: 'nope' })).status).toBe(401);
    const r1 = await post('/oauth2/token', { grant_type: 'refresh_token', refresh_token: t.refresh_token, ...creds });
    expect(r1.status).toBe(200);
    expect(r1.json.refresh_token).not.toBe(t.refresh_token);
    // widening scope on refresh is refused
    expect((await post('/oauth2/token', { grant_type: 'refresh_token', refresh_token: r1.json.refresh_token, scope: 'openid read', ...creds })).json.error).toBe('invalid_scope');
    // the spent token inside the grace window replays to the same successor; after it, reuse kills the family
    expect((await post('/oauth2/token', { grant_type: 'refresh_token', refresh_token: t.refresh_token, ...creds })).json.refresh_token).toBe(r1.json.refresh_token);
    e.clock.advance(31_000);
    expect((await post('/oauth2/token', { grant_type: 'refresh_token', refresh_token: t.refresh_token, ...creds })).json.error).toBe('invalid_grant');
    expect((await post('/oauth2/introspect', { token: r1.json.access_token, ...creds })).json.active).toBe(false);
    // revocation answers 200 whatever the token, and kills a live one
    const t2 = await issue();
    expect((await post('/oauth2/revoke', { token: 'garbage', ...creds })).status).toBe(200);
    expect((await post('/oauth2/revoke', { token: t2.refresh_token, ...creds })).status).toBe(200);
    expect((await post('/oauth2/introspect', { token: t2.access_token, ...creds })).json.active).toBe(false);
  });

  it('refuses what it should at authorize: unknown client, unregistered redirect, missing PKCE for public clients, denial', async () => {
    const { e, c } = await setup();
    expect((await authorize(e, { client_id: 'oac_nope', redirect_uri: CB, response_type: 'code' })).status).toBe(400);
    expect((await authorize(e, { client_id: c.client_id, redirect_uri: 'https://evil.example/cb', response_type: 'code' })).status).toBe(400);
    const denied = await authorize(e, { client_id: c.client_id, redirect_uri: CB, response_type: 'code', state: 'x', emulator_decision: 'deny' });
    expect(new URL(denied.location!).searchParams.get('error')).toBe('access_denied');
    const none = await authorize(e, { client_id: c.client_id, redirect_uri: CB, response_type: 'code', login_hint: 'nobody@example.com' });
    expect(new URL(none.location!).searchParams.get('error')).toBe('login_required');
    const pub = (await client(e)('POST', '/v1/oauth_clients', { name: 'SPA', redirect_uris: [CB], token_endpoint_auth_method: 'none' })).json;
    expect(pub.client_secret).toBeUndefined();
    expect(new URL((await authorize(e, { client_id: pub.client_id, redirect_uri: CB, response_type: 'code' })).location!).searchParams.get('error')).toBe('invalid_request');
  });

  it('client_credentials and token exchange (narrowing, actor, revoked subject)', async () => {
    const { e, post, c } = await setup();
    const creds = { client_id: c.client_id, client_secret: c.client_secret };
    const cc = await post('/oauth2/token', { grant_type: 'client_credentials', scope: 'read', ...creds });
    expect(cc.json).toMatchObject({ token_type: 'Bearer', scope: 'read' });
    expect(((await e.tokens.verifyAny(cc.json.access_token)) as any).claims.sub).toBe(c.client_id);
    expect((await post('/oauth2/token', { grant_type: 'client_credentials', scope: 'admin', ...creds })).json.error).toBe('invalid_scope');
    const ex = await post('/oauth2/token', { grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange', subject_token: cc.json.access_token, subject_token_type: 'urn:ietf:params:oauth:token-type:access_token', audience: 'https://svc.example', ...creds });
    expect(ex.json).toMatchObject({ issued_token_type: 'urn:ietf:params:oauth:token-type:access_token', token_type: 'Bearer' });
    expect(((await e.tokens.verifyAny(ex.json.access_token)) as any).claims.aud).toBe('https://svc.example');
    expect((await post('/oauth2/token', { grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange', subject_token: cc.json.access_token, scope: 'read write', ...creds })).json.error).toBe('invalid_scope');
    const withActor = await post('/oauth2/token', { grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange', subject_token: cc.json.access_token, actor_token: cc.json.access_token, ...creds });
    expect(((await e.tokens.verifyAny(withActor.json.access_token)) as any).claims.act).toMatchObject({ sub: c.client_id });
    await post('/oauth2/revoke', { token: cc.json.access_token, ...creds });
    expect((await post('/oauth2/token', { grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange', subject_token: cc.json.access_token, ...creds })).json.error).toBe('invalid_grant');
    expect((await post('/oauth2/token', { grant_type: 'nonsense', ...creds })).json.error).toBe('unauthorized_client');
  });

  it('rotating the client secret invalidates the old one; deleting the client ends its tokens', async () => {
    const { e, call, post, c } = await setup();
    const rot = (await call('POST', `/v1/oauth_clients/${c.id}/rotate_secret`, { overlap_seconds: 0 })).json;
    expect(rot.client_secret).not.toBe(c.client_secret);
    expect((await post('/oauth2/token', { grant_type: 'client_credentials', client_id: c.client_id, client_secret: c.client_secret })).status).toBe(401);
    const cc = (await post('/oauth2/token', { grant_type: 'client_credentials', client_id: c.client_id, client_secret: rot.client_secret })).json;
    await call('DELETE', `/v1/oauth_clients/${c.id}`);
    expect((await post('/oauth2/introspect', { token: cc.access_token, client_id: c.client_id, client_secret: rot.client_secret })).status).toBe(401);
    expect((await call('GET', `/v1/oauth_clients/${c.id}`)).status).toBe(404);
  });
});

describe('SCIM', () => {
  const setup = async (scopes?: string[]) => {
    const e = makeEngine();
    const call = client(e);
    const org = (await call('POST', '/v1/organizations', { name: 'Scim Org' })).json;
    const t = (await call('POST', '/v1/scim_tokens', { organization_id: org.id, ...(scopes ? { scopes } : {}) })).json;
    const scim = async (method: string, path: string, body?: unknown, token: string | null = t.token) => {
      const res = await e.handle(new Request(`http://emulator.test/scim/v2${path}`, { method, headers: { 'content-type': 'application/scim+json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }));
      const text = await res.text();
      return { status: res.status, json: text ? JSON.parse(text) : null, headers: res.headers };
    };
    return { e, call, org, t, scim };
  };

  it('provisions, filters, patches, deactivates and de-provisions users into the token organization', async () => {
    const { e, call, org, t, scim } = await setup();
    expect(t.token).toMatch(/^scim_/);
    expect((await scim('GET', '/Users', undefined, null)).status).toBe(401);
    expect((await scim('GET', '/ServiceProviderConfig')).json.patch.supported).toBe(true);
    const made = await scim('POST', '/Users', { schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'], userName: 'sam@example.com', name: { givenName: 'Sam', familyName: 'Lee' }, externalId: 'idp-1' });
    expect(made.status).toBe(201);
    expect(made.headers.get('content-type')).toContain('application/scim+json');
    expect(made.json).toMatchObject({ userName: 'sam@example.com', active: true, externalId: 'idp-1' });
    expect((await call('GET', `/v1/organizations/${org.id}/memberships`)).json.data.map((m: any) => m.user_id)).toContain(made.json.id);
    expect((await scim('POST', '/Users', { userName: 'sam@example.com' })).status).toBe(409);
    expect((await scim('GET', '/Users?filter=userName%20eq%20%22sam%40example.com%22')).json).toMatchObject({ totalResults: 1, Resources: [{ id: made.json.id }] });
    expect((await scim('GET', '/Users?filter=userName%20eq%20%22nobody%40example.com%22')).json.totalResults).toBe(0);
    expect((await scim('GET', '/Users?filter=bogus')).json.scimType).toBe('invalidFilter');
    const off = await scim('PATCH', `/Users/${made.json.id}`, { schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'], Operations: [{ op: 'replace', path: 'active', value: false }] });
    expect(off.json.active).toBe(false);
    expect(e.webhooks.events.map((x) => x.type)).toEqual(expect.arrayContaining(['scim_token.created', 'scim_user.created', 'scim_user.deactivated']));
    expect((await scim('GET', '/Users/nobody')).status).toBe(404);
    expect((await scim('DELETE', `/Users/${made.json.id}`)).status).toBe(204);
    expect((await call('GET', `/v1/organizations/${org.id}/memberships`)).json.data).toHaveLength(0);
    expect((await call('GET', `/v1/users/${made.json.id}`)).status).toBe(200); // the account stays; only the seat goes
  });

  it('groups: create, add and remove members, delete; a read-only token refuses writes; a revoked token answers 401', async () => {
    const { call, t, scim } = await setup();
    const g = (await scim('POST', '/Groups', { displayName: 'Eng' })).json;
    const u = (await scim('POST', '/Users', { userName: 'g@example.com' })).json;
    const added = await scim('PATCH', `/Groups/${g.id}`, { Operations: [{ op: 'add', path: 'members', value: [{ value: u.id }] }] });
    expect(added.json.members).toHaveLength(1);
    const removed = await scim('PATCH', `/Groups/${g.id}`, { Operations: [{ op: 'remove', path: `members[value eq "${u.id}"]` }] });
    expect(removed.json.members).toHaveLength(0);
    expect((await scim('DELETE', `/Groups/${g.id}`)).status).toBe(204);
    const ro = await call('POST', '/v1/scim_tokens', { organization_id: (await call('GET', '/v1/scim_tokens')).json.data[0].organization_id, scopes: ['read'] });
    expect((await scim('GET', '/Users', undefined, ro.json.token)).status).toBe(200);
    expect((await scim('POST', '/Users', { userName: 'ro@example.com' }, ro.json.token)).status).toBe(403);
    await call('POST', `/v1/scim_tokens/${t.id}/revoke`);
    expect((await scim('GET', '/Users')).status).toBe(401);
  });
});

describe('WebAuthn and the Passkey API', () => {
  it('runs registration and login with the virtual authenticator, tracks the counter and flags a clone', async () => {
    const e = makeEngine();
    const call = client(e);
    const auth = createVirtualAuthenticator({ origin: 'https://app.example' });
    const init = (await call('POST', '/v1/passkey_api/registration/init', { user_id: 'ext-1', username: 'ada' })).json;
    expect(init.options.rp.id).toBe(new URL(e.issuer).hostname);
    const created = await auth.create(init.options);
    const bad = await call('POST', '/v1/passkey_api/registration/finalize', { user_id: 'ext-1', challenge: 'other', attestation_object: created.attestation_object, client_data_json: created.client_data_json });
    expect(bad.status).toBe(400);
    const reg = await call('POST', '/v1/passkey_api/registration/finalize', { user_id: 'ext-1', challenge: init.options.challenge, attestation_object: created.attestation_object, client_data_json: created.client_data_json, name: 'laptop', transports: created.transports });
    expect(reg.status).toBe(201);
    expect(reg.json).toMatchObject({ object: 'external_passkey', user_id: 'ext-1', credential_id: created.credential_id, name: 'laptop' });
    expect((await call('GET', '/v1/passkey_api/users/ext-1/passkeys')).json.data).toHaveLength(1);
    const login = async () => {
      const li = (await call('POST', '/v1/passkey_api/login/init', { user_id: 'ext-1' })).json;
      expect(li.options.allowCredentials[0].id).toBe(created.credential_id);
      const a = await auth.get(li.options);
      return call('POST', '/v1/passkey_api/login/finalize', { handle: li.handle, challenge: li.options.challenge, credential_id: a.credential_id, authenticator_data: a.authenticator_data, client_data_json: a.client_data_json, signature: a.signature });
    };
    const ok = await login();
    expect(ok.json).toMatchObject({ object: 'passkey_login_result', verified: true, user_id: 'ext-1', user_verified: true, cloned_warning: false });
    expect((await login()).json.cloned_warning).toBe(false); // counter 2 > 1
    auth.frozenCounter = true;
    expect((await login()).json.cloned_warning).toBe(true); // counter stuck at 2: a clone
    // a tampered signature never verifies
    const li = (await call('POST', '/v1/passkey_api/login/init', { user_id: 'ext-1' })).json;
    const a = await auth.get(li.options);
    const forged = await call('POST', '/v1/passkey_api/login/finalize', { handle: li.handle, challenge: li.options.challenge, credential_id: a.credential_id, authenticator_data: a.authenticator_data, client_data_json: a.client_data_json, signature: a.signature.slice(0, -4) + 'AAAA' });
    expect(forged.status).toBe(400);
    expect((await call('GET', '/v1/passkey_api/usage')).json.passkeys).toBe(1);
    expect(e.webhooks.events.some((x) => x.type === 'passkey.registered')).toBe(true);
    expect((await call('DELETE', `/v1/passkey_api/users/ext-1/passkeys/${reg.json.id}`)).json.deleted).toBe(true);
  });

  it('a second registration of the same authenticator is refused by excludeCredentials, and the HTTP helper drives a round trip', async () => {
    const e = makeEngine();
    const call = client(e);
    const anon = client(e, null);
    const va = (await anon('POST', '/__emulator/webauthn/authenticators', { origin: 'https://app.example' })).json;
    const init = (await call('POST', '/v1/passkey_api/registration/init', { user_id: 'ext-2' })).json;
    const created = (await anon('POST', `/__emulator/webauthn/authenticators/${va.id}/create`, { options: init.options })).json;
    await call('POST', '/v1/passkey_api/registration/finalize', { user_id: 'ext-2', challenge: init.options.challenge, attestation_object: created.attestation_object, client_data_json: created.client_data_json });
    const again = (await call('POST', '/v1/passkey_api/registration/init', { user_id: 'ext-2' })).json;
    expect(again.options.excludeCredentials).toHaveLength(1);
    expect((await anon('POST', `/__emulator/webauthn/authenticators/${va.id}/create`, { options: again.options })).status).toBe(500);
  });
});

describe('round-two routes', () => {
  it('rotates an API key with an overlap and reports posture and callers', async () => {
    const e = makeEngine();
    const call = client(e);
    const u = (await call('POST', '/v1/users', { email_address: 'k@example.com' })).json;
    const k = (await call('POST', '/v1/api_keys', { subject_type: 'user', subject_id: u.id, name: 'wide', scopes: ['*'] })).json;
    const rot = await call('POST', `/v1/api_keys/${k.id}/rotate`, { overlap_seconds: 600 });
    expect(rot.status).toBe(200);
    expect(rot.json.secret).not.toBe(k.secret);
    expect(rot.json.previous_key).toMatchObject({ id: k.id, revoked: false });
    // both secrets verify during the overlap, only the new one after it
    expect((await call('POST', '/v1/api_keys/verify', { secret: k.secret, client_ip: '203.0.113.9' })).json.valid).toBe(true);
    expect((await call('POST', '/v1/api_keys/verify', { secret: rot.json.secret })).json.valid).toBe(true);
    e.clock.advance(601_000);
    expect((await call('POST', '/v1/api_keys/verify', { secret: k.secret })).json.valid).toBe(false);
    expect((await call('POST', '/v1/api_keys/verify', { secret: rot.json.secret })).json.valid).toBe(true);
    expect(e.webhooks.events.some((x) => x.type === 'api_key.rotated')).toBe(true);
    const zero = (await call('POST', `/v1/api_keys/${rot.json.id}/rotate`, { overlap_seconds: 0 })).json;
    expect(zero.previous_key.revoked).toBe(true);
    const posture = (await call('GET', '/v1/api_keys/posture')).json;
    expect(posture.data.find((f: any) => f.key_id === zero.id).issues).toEqual(expect.arrayContaining(['over_scoped', 'no_expiry', 'no_ip_allowlist']));
    const callers = (await call('GET', `/v1/api_keys/${k.id}/callers`)).json;
    expect(callers.ip[0]).toMatchObject({ value: '203.0.113.9', count: 1 });
    expect((await call('POST', `/v1/api_keys/${k.id}/rotate`, { overlap_seconds: 9_999_999 })).status).toBe(400);
  });

  it('feeds revoked sessions, signs a status list the verifier can read, and revokes by filter', async () => {
    const e = makeEngine();
    const call = client(e);
    const u = (await call('POST', '/v1/users', { email_address: 'sl@example.com' })).json;
    const s1 = (await call('POST', '/v1/sessions', { user_id: u.id })).json;
    const s2 = (await call('POST', '/v1/sessions', { user_id: u.id })).json;
    await call('POST', `/v1/sessions/${s1.id}/revoke`);
    expect((await call('GET', '/v1/sessions/revocations')).json.data).toEqual([expect.objectContaining({ sid: s1.id, sub: u.id, reason: 'admin' })]);
    const list = (await call('GET', '/v1/sessions/revocations/status-list')).json;
    expect(list).toMatchObject({ object: 'session_status_list', count: 1, truncated: false });
    const claims = ((await e.tokens.verifyAny(list.token)) as any).claims;
    expect(claims).toMatchObject({ aud: 'atlas:session-status-list', hash_bytes: 8, count: 1 });
    expect((await call('GET', `/v1/sessions/${s1.id}/events`)).json.data.map((x: any) => x.type)).toEqual(['created', 'revoked']);
    expect((await call('POST', '/v1/sessions/revoke_by_filter', {})).status).toBe(400);
    expect((await call('POST', '/v1/sessions/revoke_by_filter', { user_id: u.id, dry_run: true })).json).toMatchObject({ dry_run: true, matched: 1 });
    const job = await call('POST', '/v1/sessions/revoke_by_filter', { user_id: u.id });
    expect(job.status).toBe(202);
    expect((await call('GET', `/v1/sessions/${s2.id}`)).json.status).toBe('revoked');
    expect((await call('GET', `/v1/sessions/revoke_jobs/${job.json.id}`)).json.revoked).toBe(1);
    expect((await call('GET', '/v1/sessions?active=false')).json.data).toHaveLength(2);
  });

  it('runs bulk user actions with a dry run, the delete guard, and remembers deleted addresses', async () => {
    const e = makeEngine();
    const call = client(e);
    const ids = [(await call('POST', '/v1/users', { email_address: 'b1@example.com' })).json.id, (await call('POST', '/v1/users', { email_address: 'b2@example.com' })).json.id];
    expect((await call('POST', '/v1/users/bulk_actions', { action: 'ban', user_ids: ids, dry_run: true })).json).toMatchObject({ dry_run: true, matched: 2 });
    const job = await call('POST', '/v1/users/bulk_actions', { action: 'ban', user_ids: ids });
    expect(job.status).toBe(202);
    expect(job.json).toMatchObject({ status: 'completed', total: 2, succeeded: 2 });
    expect((await call('GET', `/v1/users/${ids[0]}`)).json.banned).toBe(true);
    expect((await call('POST', '/v1/users/bulk_actions', { action: 'delete', user_ids: ids })).status).toBe(400);
    expect((await call('POST', '/v1/users/bulk_actions', { action: 'delete', user_ids: ids, expected_count: 5 })).status).toBe(409);
    expect((await call('POST', '/v1/users/bulk_actions', { action: 'delete', user_ids: ids, expected_count: 2 })).status).toBe(202);
    expect((await call('GET', `/v1/users/${ids[0]}`)).status).toBe(404);
    expect((await call('GET', `/v1/users/bulk_actions/${job.json.id}`)).json.id).toBe(job.json.id);
    expect((await call('POST', '/v1/users/deleted_addresses', { addresses: ['Gone@Example.com', 'not an address'] })).json).toMatchObject({ received: 2, added: 1, invalid: 1 });
    expect((await call('POST', '/v1/users/deleted_addresses/check', { address: 'gone@example.com' })).json.remembered).toBe(true);
  });
});

describe('parity contract and emulator coverage', () => {
  it('has a parity request for every hand-written route (or an exemption with a reason)', () => {
    expect(uncoveredRoutes(makeEngine())).toEqual([]);
  });

  it('two engines agree on the full request list', async () => {
    const [a, b] = [makeEngine(), makeEngine()];
    const to = (e: Engine) => (async (url: string, init: RequestInit) => e.handle(new Request(url, init))) as unknown as typeof fetch;
    const routed = (async (url: string, init: RequestInit) => (String(url).startsWith('http://a.test') ? to(a)(url, init) : to(b)(url, init))) as unknown as typeof fetch;
    const results = await runParity({ requests: fullParityRequests, emulator: { baseUrl: 'http://a.test', secretKey: KEY }, reference: { baseUrl: 'http://b.test', secretKey: KEY }, fetchImpl: routed });
    expect(results.filter((r) => !r.ok)).toEqual([]);
    expect(results.length).toBe(fullParityRequests.length);
    expect(results.find((r) => r.id === 'oauth token')?.status.emulator).toBe(200);
    expect(results.find((r) => r.id === 'scim user create')?.status.emulator).toBe(201);
  });

  it('runParity can select feature groups', async () => {
    const e = makeEngine();
    const f = (async (url: string, init: RequestInit) => e.handle(new Request(url, init))) as unknown as typeof fetch;
    const only = await runParity({ requests: fullParityRequests, groups: ['oauth'], emulator: { baseUrl: 'http://a.test', secretKey: KEY }, reference: { baseUrl: 'http://a.test', secretKey: KEY }, fetchImpl: f });
    expect(only.some((r) => r.id === 'oauth token')).toBe(true);
    expect(only.some((r) => r.id === 'scim user create')).toBe(false);
    expect(only.length).toBeLessThan(defaultParityRequests.length + fullParityRequests.length);
  });

  it('lists per-operation coverage and annotates the document with x-atlas-emulator-coverage', () => {
    const e = makeEngine();
    const cov = coverageList(e);
    expect(Object.keys(cov.operations).length).toBe(e.index.ops.length);
    expect(cov.operations['GET /v1/users']).toBe('handler');
    // The device-key routes are in the snapshot once it is refreshed from a spec that has them; until then they are extra routes.
    expect(cov.operations['POST /v1/machines/token'] ?? (cov.extra.includes('POST /v1/machines/token') ? 'handler' : undefined)).toBe('handler');
    expect(Object.values(cov.operations)).toContain('generic');
    expect(cov.extra).toEqual(expect.arrayContaining(['POST /oauth2/token', 'GET /scim/v2/Users']));
    const doc = annotateCoverage(snapshot(), e);
    expect(doc.paths['/v1/users'].get['x-atlas-emulator-coverage']).toBe('handler');
    expect(snapshot().paths['/v1/users'].get['x-atlas-emulator-coverage']).toBeUndefined();
  });
});
