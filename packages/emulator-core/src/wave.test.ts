/* eslint-disable @typescript-eslint/no-explicit-any */
import { createHash, generateKeyPairSync, sign as nodeSign, type KeyObject } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { pkceChallenge } from './crypto-util';
import { KEY, client, makeEngine } from './test-support';
import type { Engine } from './engine';

const CB = 'https://app.example/callback';
const b64 = (v: string | Buffer): string => Buffer.from(v).toString('base64url');
const ec = () => {
  const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return { ...pair, jwk: pair.publicKey.export({ format: 'jwk' }) as Record<string, string> };
};
const es256 = (key: KeyObject, header: Record<string, unknown>, payload: Record<string, unknown>): string => {
  const input = `${b64(JSON.stringify(header))}.${b64(JSON.stringify(payload))}`;
  return `${input}.${b64(nodeSign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' }))}`;
};
const now = () => Math.floor(Date.now() / 1000);
const dpop = (k: ReturnType<typeof ec>, htu: string, extra: Record<string, unknown> = {}) => es256(k.privateKey, { typ: 'dpop+jwt', alg: 'ES256', jwk: k.jwk }, { jti: Math.random().toString(36).slice(2), htm: 'POST', htu, iat: now(), ...extra });
const form = (e: Engine) => async (path: string, fields: Record<string, string>, headers: Record<string, string> = {}) => {
  const res = await e.handle(new Request(`http://emulator.test${path}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams(fields).toString(), redirect: 'manual' }));
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null, headers: res.headers };
};
const get = async (e: Engine, path: string, headers: Record<string, string> = {}) => {
  const res = await e.handle(new Request(`http://emulator.test${path}`, { headers }));
  return { status: res.status, location: res.headers.get('location'), text: await res.text(), headers: res.headers };
};
const userWithSession = async (e: Engine, email: string) => {
  const call = client(e);
  const u = (await call('POST', '/v1/users', { email_address: email, password: 'Correct-horse-9-battery' })).json;
  const s = (await call('POST', '/v1/sessions', { user_id: u.id })).json;
  return { call, user: u, session: s, as: { authorization: `Bearer ${s.jwt}` } };
};

describe('machine federation and token binding', () => {
  const setup = async () => {
    const e = makeEngine();
    const call = client(e);
    const anon = client(e, null);
    const issuer = ec();
    const m = (await call('POST', '/v1/machines', { name: 'ci' })).json;
    const policy = await call('POST', '/v1/machine_trust_policies', { machine_id: m.id, name: 'gha', kind: 'github_actions', audience: 'https://atlas.example', subject_pattern: 'repo:acme/app:*', jwks: { keys: [{ ...issuer.jwk, kid: 'k1', alg: 'ES256' }] } });
    const token = (over: Record<string, unknown> = {}) => es256(issuer.privateKey, { alg: 'ES256', kid: 'k1' }, { iss: 'https://token.actions.githubusercontent.com', aud: 'https://atlas.example', sub: 'repo:acme/app:ref:refs/heads/main', iat: now(), exp: now() + 300, ...over });
    return { e, call, anon, m, policy, token };
  };

  it('exchanges a verified GitHub token for a short machine token and refuses everything else with one answer', async () => {
    const { e, call, anon, m, policy, token } = await setup();
    expect(policy.status).toBe(201);
    const ok = await anon('POST', '/v1/machines/federate', { machine_id: m.id, token: token() });
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({ object: 'machine_token', token_type: 'Bearer', machine_id: m.id });
    const claims = (await e.tokens.verifyAny(ok.json.token)) as any;
    expect(claims.claims).toMatchObject({ sub: m.id, token_use: 'm2m', fed: { kind: 'github_actions', sub: 'repo:acme/app:ref:refs/heads/main' } });
    expect((await call('POST', '/v1/m2m_tokens/verify', { token: ok.json.token })).json.valid).toBe(true);
    const refused = [token({ aud: 'https://other' }), token({ sub: 'repo:evil/app:ref:x' }), token({ exp: now() - 600 }), token({ iss: 'https://elsewhere.example' }), 'not.a.jwt'];
    for (const t of refused) {
      const r = await anon('POST', '/v1/machines/federate', { machine_id: m.id, token: t });
      expect(r.status).toBe(403);
    }
    expect((await anon('POST', '/v1/machines/federate', { machine_id: 'mch_missing', token: token() })).status).toBe(403);
    // the dry run says why, and spends nothing
    const test = (await call('POST', `/v1/machine_trust_policies/${policy.json.id}/test`, { token: token({ sub: 'repo:evil/app:x' }) })).json;
    expect(test).toMatchObject({ accepted: false, reasons: ['subject_mismatch'] });
    expect((await call('POST', '/v1/machine_trust_policies', { machine_id: m.id, name: 'wild', kind: 'github_actions', audience: 'a', subject_pattern: '*' })).status).toBe(400);
  });

  it('binds the token to a DPoP key when the machine asks for it, and refuses a replayed or missing proof', async () => {
    const { anon, call, m, token } = await setup();
    await call('PATCH', `/v1/machines/${m.id}`, { token_binding: 'dpop' });
    expect((await call('GET', `/v1/machines/${m.id}`)).json.token_binding).toBe('dpop');
    expect((await anon('POST', '/v1/machines/federate', { machine_id: m.id, token: token() })).status).toBe(400);
    const key = ec();
    const url = 'http://emulator.test/v1/machines/federate';
    const proof = dpop(key, url);
    const ok = await anon('POST', '/v1/machines/federate', { machine_id: m.id, token: token() }, { DPoP: proof });
    expect(ok.status).toBe(200);
    expect(ok.json.token_type).toBe('DPoP');
    const v = (await call('POST', '/v1/m2m_tokens/verify', { token: ok.json.token })).json;
    expect(v.cnf.jkt).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await anon('POST', '/v1/machines/federate', { machine_id: m.id, token: token() }, { DPoP: proof })).status).toBe(400);
    expect((await anon('POST', '/v1/machines/federate', { machine_id: m.id, token: token() }, { DPoP: dpop(key, 'http://emulator.test/other') })).status).toBe(400);
  });

  it('binds to a client certificate thumbprint (mTLS) from the forwarded header', async () => {
    const { anon, call, m, token } = await setup();
    await call('PATCH', `/v1/machines/${m.id}`, { token_binding: 'mtls' });
    expect((await anon('POST', '/v1/machines/federate', { machine_id: m.id, token: token() })).status).toBe(400);
    const fp = createHash('sha256').update('cert-der').digest('hex');
    const ok = await anon('POST', '/v1/machines/federate', { machine_id: m.id, token: token() }, { 'x-client-cert-sha256': fp });
    expect(ok.status).toBe(200);
    expect((await call('POST', '/v1/m2m_tokens/verify', { token: ok.json.token })).json.cnf['x5t#S256']).toBe(Buffer.from(fp, 'hex').toString('base64url'));
  });

  it('checks an AWS proof strictly and asks the injected STS for the identity', async () => {
    const sts = (async () => new Response('<GetCallerIdentityResponse><GetCallerIdentityResult><Arn>arn:aws:sts::123456789012:assumed-role/deployer/sess</Arn><Account>123456789012</Account></GetCallerIdentityResult></GetCallerIdentityResponse>')) as unknown as typeof fetch;
    const e = makeEngine({ fetch: sts });
    const [call, anon] = [client(e), client(e, null)];
    const m = (await call('POST', '/v1/machines', { name: 'lambda' })).json;
    await call('POST', '/v1/machine_trust_policies', { machine_id: m.id, name: 'aws', kind: 'aws', audience: 'atlas-prod', subject_pattern: 'arn:aws:iam::123456789012:role/deployer' });
    const proof = (over: Record<string, unknown> = {}) => ({ method: 'POST', url: 'https://sts.amazonaws.com/', body: 'Action=GetCallerIdentity&Version=2011-06-15', headers: { authorization: 'AWS4-HMAC-SHA256 Credential=A/20260101/us-east-1/sts/aws4_request, SignedHeaders=host;x-amz-date;x-atlas-audience, Signature=abc', 'x-amz-date': '20260101T000000Z', 'x-atlas-audience': 'atlas-prod' }, ...over });
    expect((await anon('POST', '/v1/machines/federate', { machine_id: m.id, aws: proof() })).status).toBe(200);
    expect((await anon('POST', '/v1/machines/federate', { machine_id: m.id, aws: proof() })).status).toBe(403); // a signed request is single use
    expect((await anon('POST', '/v1/machines/federate', { machine_id: m.id, aws: proof({ url: 'https://evil.example/' }) })).status).toBe(403);
    expect((await anon('POST', '/v1/machines/federate', { machine_id: m.id, aws: proof({ headers: { authorization: 'x', 'x-amz-date': 'y', 'x-atlas-audience': 'other' } }) })).status).toBe(403);
  });
});

describe('OAuth: consent, PAR, device authorization, CIBA, DPoP', () => {
  const setup = async (extra: Record<string, unknown> = {}) => {
    const e = makeEngine();
    const call = client(e);
    const { user, session, as } = await userWithSession(e, 'ada@example.com');
    const c = (await call('POST', '/v1/oauth_clients', { name: 'Third party', redirect_uris: [CB], grant_types: ['authorization_code', 'refresh_token', 'client_credentials', 'urn:ietf:params:oauth:grant-type:device_code', 'urn:openid:params:grant-type:ciba'], token_endpoint_auth_method: 'client_secret_post', ...extra })).json;
    const creds = { client_id: c.client_id, client_secret: c.client_secret };
    return { e, call, user, session, as, c, creds, post: form(e) };
  };

  it('pushes the request, stops at the consent screen, remembers the grant and issues tokens only after approval', async () => {
    const { e, user, c, creds, post } = await setup({ require_consent: true });
    const verifier = 'v'.repeat(48);
    const par = await post('/oauth2/par', { ...creds, redirect_uri: CB, response_type: 'code', scope: 'openid profile', code_challenge: await pkceChallenge(verifier), code_challenge_method: 'S256', login_hint: user.id, state: 's1' });
    expect(par.status).toBe(201);
    expect(par.json.request_uri).toMatch(/^urn:ietf:params:oauth:request_uri:/);
    const stop = await get(e, `/oauth2/authorize?client_id=${c.client_id}&request_uri=${encodeURIComponent(par.json.request_uri)}`);
    expect(stop.status).toBe(302);
    const token = new URL(stop.location!).searchParams.get('consent_token')!;
    expect(JSON.parse((await get(e, `/oauth2/authorize/consent?consent_token=${token}`)).text)).toMatchObject({ object: 'oauth_consent_screen', requested_scope: ['openid', 'profile'] });
    // a request_uri is single use
    expect((await get(e, `/oauth2/authorize?client_id=${c.client_id}&request_uri=${encodeURIComponent(par.json.request_uri)}`)).status).toBe(400);
    const done = await post('/oauth2/authorize/consent', { consent_token: token, decision: 'approve' });
    expect(done.status).toBe(302);
    const back = new URL(done.headers.get('location')!);
    expect(back.searchParams.get('state')).toBe('s1');
    const tokens = await post('/oauth2/token', { ...creds, grant_type: 'authorization_code', code: back.searchParams.get('code')!, redirect_uri: CB, code_verifier: verifier });
    expect(tokens.status).toBe(200);
    // remembered: the same scopes go straight through next time, unless the client forces prompt=consent
    const again = await get(e, `/oauth2/authorize?${new URLSearchParams({ client_id: c.client_id, redirect_uri: CB, response_type: 'code', scope: 'openid', login_hint: user.id, code_challenge: await pkceChallenge(verifier), code_challenge_method: 'S256' })}`);
    expect(new URL(again.location!).searchParams.get('code')).toBeTruthy();
    const forced = await get(e, `/oauth2/authorize?${new URLSearchParams({ client_id: c.client_id, redirect_uri: CB, response_type: 'code', scope: 'openid', login_hint: user.id, prompt: 'consent', code_challenge: await pkceChallenge(verifier), code_challenge_method: 'S256' })}`);
    expect(new URL(forced.location!).pathname).toBe('/oauth2/authorize/consent');
  });

  it('lets the customer\'s own consent page accept (narrowing scope, openid kept) or reject through the challenge', async () => {
    const { e, call, user, c, creds } = await setup({ require_consent: true });
    const start = async () => {
      const res = await get(e, `/oauth2/authorize?${new URLSearchParams({ client_id: c.client_id, redirect_uri: CB, response_type: 'code', scope: 'openid profile email', login_hint: user.id, prompt: 'consent', code_challenge: await pkceChallenge('x'.repeat(50)), code_challenge_method: 'S256' })}`);
      return new URL(res.location!).searchParams.get('consent_token')!;
    };
    void creds;
    const ch = await start();
    expect((await call('GET', `/v1/oauth_consent_requests?consent_challenge=${ch}`)).json).toMatchObject({ object: 'oauth_consent_request', subject: user.id, requested_scope: ['openid', 'profile', 'email'] });
    expect((await call('PUT', `/v1/oauth_consent_requests/accept?consent_challenge=${ch}`, { grant_scope: ['profile'] })).status).toBe(400);
    const ok = await call('PUT', `/v1/oauth_consent_requests/accept?consent_challenge=${ch}`, { grant_scope: ['openid', 'email'] });
    expect(ok.json.object).toBe('oauth_consent_redirect');
    expect(new URL(ok.json.redirect_to).searchParams.get('code')).toBeTruthy();
    expect((await call('GET', `/v1/oauth_consent_requests?consent_challenge=${ch}`)).status).toBe(404); // answered once
    const ch2 = await start();
    const no = await call('PUT', `/v1/oauth_consent_requests/reject?consent_challenge=${ch2}`, { error: 'access_denied' });
    expect(new URL(no.json.redirect_to).searchParams.get('error')).toBe('access_denied');
  });

  it('runs the device grant: pending, slow_down, approve, then tokens once; deny and expiry end it', async () => {
    const { e, user, creds, post } = await setup();
    const dev = (await post('/oauth2/device_authorization', { ...creds, scope: 'openid' })).json;
    expect(dev).toMatchObject({ interval: 5, expires_in: 600 });
    expect(dev.user_code).toMatch(/^[A-Z]{4}-[A-Z]{4}$/);
    const poll = () => post('/oauth2/token', { ...creds, grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: dev.device_code });
    expect((await poll()).json.error).toBe('authorization_pending');
    expect((await poll()).json.error).toBe('slow_down');
    e.clock.advance(30_000);
    expect((await poll()).json.error).toBe('authorization_pending');
    expect((await get(e, `/oauth2/device?user_code=${dev.user_code.toLowerCase()}`)).status).toBe(200);
    expect((await post('/oauth2/device/verify', { user_code: dev.user_code, decision: 'approve', user_id: user.id })).status).toBe(200);
    const ok = await poll();
    expect(ok.status).toBe(200);
    expect(ok.json.access_token).toBeTruthy();
    expect((await poll()).json.error).toBe('invalid_grant');
    const d2 = (await post('/oauth2/device_authorization', { ...creds })).json;
    await post('/oauth2/device/verify', { user_code: d2.user_code, decision: 'deny' });
    expect((await post('/oauth2/token', { ...creds, grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: d2.device_code })).json.error).toBe('access_denied');
    const d3 = (await post('/oauth2/device_authorization', { ...creds })).json;
    e.clock.advance(601_000);
    expect((await post('/oauth2/token', { ...creds, grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: d3.device_code })).json.error).toBe('expired_token');
  });

  it('runs CIBA by poll: unknown user, pending, the user answers from their session, tokens', async () => {
    const { e, user, as, creds, post } = await setup();
    expect((await post('/oauth2/backchannel_authentication', { ...creds, login_hint: 'nobody@example.com' })).json.error).toBe('unknown_user_id');
    const req = (await post('/oauth2/backchannel_authentication', { ...creds, login_hint: user.id, scope: 'openid', binding_message: 'Approve 42' })).json;
    expect(req.auth_req_id).toBeTruthy();
    const poll = () => post('/oauth2/token', { ...creds, grant_type: 'urn:openid:params:grant-type:ciba', auth_req_id: req.auth_req_id });
    expect((await poll()).json.error).toBe('authorization_pending');
    const pending = JSON.parse((await get(e, '/v1/client/me/backchannel_requests', as)).text);
    expect(pending.data[0]).toMatchObject({ binding_message: 'Approve 42', client_name: 'Third party' });
    const answer = await e.handle(new Request(`http://emulator.test/v1/client/me/backchannel_requests/${pending.data[0].id}`, { method: 'POST', headers: { ...as, 'content-type': 'application/json' }, body: JSON.stringify({ decision: 'approve' }) }));
    expect(answer.status).toBe(200);
    e.clock.advance(10_000);
    expect((await poll()).json.access_token).toBeTruthy();
  });

  it('binds access tokens to a DPoP key, shows cnf on introspection and requires the proof at userinfo', async () => {
    const { e, user, c, creds, post } = await setup({ dpop_bound_access_tokens: true });
    const key = ec();
    const url = 'http://emulator.test/oauth2/token';
    expect((await post('/oauth2/token', { ...creds, grant_type: 'client_credentials' })).json.error).toBe('invalid_dpop_proof');
    const ok = await post('/oauth2/token', { ...creds, grant_type: 'client_credentials' }, { DPoP: dpop(key, url) });
    expect(ok.json.token_type).toBe('DPoP');
    const intro = (await post('/oauth2/introspect', { ...creds, token: ok.json.access_token })).json;
    expect(intro).toMatchObject({ active: true, token_type: 'DPoP' });
    expect(intro.cnf.jkt).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // an authorization-code token with openid: userinfo needs the DPoP scheme and an ath-bound proof from the same key
    const verifier = 'p'.repeat(50);
    const code = new URL((await get(e, `/oauth2/authorize?${new URLSearchParams({ client_id: c.client_id, redirect_uri: CB, response_type: 'code', scope: 'openid', login_hint: user.id, code_challenge: await pkceChallenge(verifier), code_challenge_method: 'S256' })}`)).location!).searchParams.get('code')!;
    const tok = (await post('/oauth2/token', { ...creds, grant_type: 'authorization_code', code, redirect_uri: CB, code_verifier: verifier }, { DPoP: dpop(key, url) })).json;
    const ui = 'http://emulator.test/oauth2/userinfo';
    const call = (headers: Record<string, string>) => e.handle(new Request(ui, { headers }));
    expect((await call({ authorization: `Bearer ${tok.access_token}` })).status).toBe(401);
    const ath = createHash('sha256').update(tok.access_token).digest('base64url');
    const proof = es256(key.privateKey, { typ: 'dpop+jwt', alg: 'ES256', jwk: key.jwk }, { jti: 'ui-1', htm: 'GET', htu: ui, iat: now(), ath });
    expect((await call({ authorization: `DPoP ${tok.access_token}`, DPoP: proof })).status).toBe(200);
    // the refresh token is bound to the same key
    const refresh = (headers: Record<string, string>) => post('/oauth2/token', { ...creds, grant_type: 'refresh_token', refresh_token: tok.refresh_token }, headers);
    expect((await refresh({ DPoP: dpop(ec(), url) })).json.error).toBe('invalid_dpop_proof');
    expect((await refresh({ DPoP: dpop(key, url) })).status).toBe(200);
  });
});

describe('approvals v2', () => {
  it('matches the number for the subject, collects signed approvals from an org role, and spends a receipt once', async () => {
    const e = makeEngine();
    const { call, user, as } = await userWithSession(e, 'subject@example.com');
    const create = await call('POST', '/v1/approval_requests', { user_id: user.id, description: 'Wire 100', reference: 'r1', binding: 'wire-1' });
    expect(create.status).toBe(201);
    expect(create.json).toMatchObject({ status: 'pending', approvers: { mode: 'subject', required: 1 }, require_signature: false });
    const decide = (id: string, body: unknown, headers = as) => e.handle(new Request(`http://emulator.test/v1/client/me/approvals/${id}/decision`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) }));
    expect((await decide(create.json.id, { decision: 'approve', number: '00' })).status).toBe(400);
    expect((await decide(create.json.id, { decision: 'approve', number: create.json.match_number })).status).toBe(200);
    const got = (await call('GET', `/v1/approval_requests/${create.json.id}`)).json;
    expect(got).toMatchObject({ status: 'approved', approvals_received: 1 });
    expect(got.receipt).toBeTruthy();
    expect((await call('POST', `/v1/approval_requests/${create.json.id}/consume`, { binding: 'wrong' })).status).toBe(400);
    expect((await call('POST', `/v1/approval_requests/${create.json.id}/consume`, { binding: 'wire-1' })).status).toBe(200);
    expect((await call('POST', `/v1/approval_requests/${create.json.id}/consume`, { binding: 'wire-1' })).status).toBe(409);

    // two org admins must sign the digest with device keys
    const org = (await call('POST', '/v1/organizations', { name: 'Treasury' })).json;
    const [a1, a2] = [await userWithSession(e, 'a1@example.com'), await userWithSession(e, 'a2@example.com')];
    for (const a of [a1, a2]) await call('POST', `/v1/organizations/${org.id}/memberships`, { user_id: a.user.id, role: 'org:admin' });
    const signed = (await call('POST', '/v1/approval_requests', { user_id: user.id, description: 'Release funds', approvers: { organization_id: org.id, role: 'org:admin', required: 2 } })).json;
    expect(signed).toMatchObject({ require_signature: true, approvers: { mode: 'org_role', required: 2 } });
    const sign = async (a: Awaited<ReturnType<typeof userWithSession>>, decision: string, tamper = false) => {
      const key = ec();
      const reg = await e.handle(new Request('http://emulator.test/v1/client/me/approval_keys', { method: 'POST', headers: { ...a.as, 'content-type': 'application/json' }, body: JSON.stringify({ public_jwk: key.jwk }) }));
      const keyId = JSON.parse(await reg.text()).id;
      const jws = es256(key.privateKey, { typ: 'atlas-approval-decision+jws', alg: 'ES256' }, { approval_id: signed.id, digest: tamper ? 'other' : signed.digest, decision, iat: now() });
      return decide(signed.id, { decision, signature: { type: 'device_key', key_id: keyId, jws } }, a.as);
    };
    expect((await sign(a1, 'approve', true)).status).toBe(400);
    expect((await sign(a1, 'approve')).status).toBe(200);
    expect((await call('GET', `/v1/approval_requests/${signed.id}`)).json.status).toBe('pending');
    expect((await sign(a2, 'approve')).status).toBe(200);
    expect((await call('GET', `/v1/approval_requests/${signed.id}`)).json.status).toBe('approved');
    // an outsider cannot see it, expiry is honoured, cancel only works while pending
    expect((await decide(signed.id, { decision: 'approve' }, as)).status).toBe(404);
    const short = (await call('POST', '/v1/approval_requests', { user_id: user.id, description: 'Expires', ttl_seconds: 60 })).json;
    e.clock.advance(61_000);
    expect((await call('GET', `/v1/approval_requests/${short.id}`)).json.status).toBe('expired');
    expect((await call('POST', `/v1/approval_requests/${short.id}/cancel`)).status).toBe(409);
  });
});

describe('step-up policies and receipts', () => {
  it('allows only a recent enough, strong enough session and signs a receipt for the allow', async () => {
    const e = makeEngine();
    const { call, user, session } = await userWithSession(e, 'su@example.com');
    // a long-lived session token: the test moves the clock past the default one-minute lifetime
    const token = (await e.tokens.mintSession({ userId: user.id, sessionId: session.id, ttlSeconds: 3600 })).jwt;
    expect((await call('POST', '/v1/step_up/policies', { name: 'wire', phishing_resistant: true, allowed_methods: ['totp'] })).status).toBe(400);
    const p = await call('POST', '/v1/step_up/policies', { name: 'wire', max_age_seconds: 300, phishing_resistant: true, receipt_ttl_seconds: 60 });
    expect(p.status).toBe(201);
    expect((await call('POST', '/v1/step_up/policies', { name: 'wire' })).status).toBe(400);
    const assert = async () => (await call('POST', '/v1/step_up/assert', { token, policy: 'wire', audience: 'payments' })).json;
    expect(await assert()).toMatchObject({ allowed: false, reason: 'phishing_resistant_required', step_up: { policy: 'wire' } });
    const anon = client(e, null);
    await anon('POST', `/__emulator/sessions/${session.id}/authenticate`, { method: 'passkey' });
    const ok = await assert();
    expect(ok).toMatchObject({ allowed: true, policy: 'wire', amr: expect.arrayContaining(['hwk']) });
    const receipt = (await e.tokens.verifyAny(ok.receipt)) as any;
    expect(receipt.claims).toMatchObject({ token_use: 'step_up_receipt', policy: 'wire', aud: 'payments', sid: session.id });
    e.clock.advance(400_000);
    expect(await assert()).toMatchObject({ allowed: false, reason: 'max_age_exceeded' });
    expect((await call('POST', '/v1/step_up/assert', { token, policy: 'missing' })).status).toBe(404);
    await call('PATCH', `/v1/step_up/policies/${p.json.id}`, { enabled: false });
    expect((await call('POST', '/v1/step_up/assert', { token, policy: 'wire' })).status).toBe(409);
  });
});

describe('messaging', () => {
  it('writes the ledger, refuses suppressed recipients, fails over and suppresses on a bounce', async () => {
    const e = makeEngine();
    const call = client(e);
    e.messages.send({ channel: 'email', to: 'Ada@Example.com', subject: 'hello', meta: { template: 'welcome' } });
    const list = (await call('GET', '/v1/messages?channel=email')).json;
    expect(list.data[0]).toMatchObject({ status: 'delivered', template: 'welcome', provider: 'emulator' });
    expect(list.data[0].recipient_masked).toBe('a**@example.com');
    expect(list.data[0].timeline.map((t: any) => t.status)).toEqual(['queued', 'sent', 'delivered']);

    const s = await call('POST', '/v1/suppressions', { address: 'ada@example.com', reason: 'manual' });
    expect(s.status).toBe(201);
    const before = e.messages.messages.length;
    e.messages.send({ channel: 'email', to: 'ada@example.com', subject: 'again' });
    expect(e.messages.messages.length).toBe(before);
    expect((await call('GET', '/v1/messages?status=suppressed')).json.data).toHaveLength(1);
    await call('DELETE', `/v1/suppressions/${s.json.data[0].id}`);
    e.messages.send({ channel: 'email', to: 'ada@example.com', subject: 'back' });
    expect(e.messages.messages.length).toBe(before + 1);

    // failover: the primary fails once, the fallback delivers; with failover off the message fails
    const fb = (await call('POST', '/v1/messaging_providers/email/fallbacks', { transport: 'sendgrid', from_address: 'f@example.com' })).json;
    const anon = client(e, null);
    await anon('POST', '/__emulator/messaging/faults', { provider_id: 'primary', channel: 'email', times: 1 });
    e.messages.send({ channel: 'email', to: 'bo@example.com', subject: 'x' });
    const viaFallback = (await call('GET', '/v1/messages?recipient=bo@example.com')).json.data[0];
    expect(viaFallback).toMatchObject({ status: 'delivered', provider: 'sendgrid' });
    expect(viaFallback.attempts.map((a: any) => a.status)).toEqual(['failed', 'sent']);
    await call('PUT', '/v1/messaging/settings', { failover_enabled: false });
    await anon('POST', '/__emulator/messaging/faults', { provider_id: 'primary', times: 1 });
    e.messages.send({ channel: 'email', to: 'cy@example.com', subject: 'y' });
    expect((await call('GET', '/v1/messages?recipient=cy@example.com')).json.data[0].status).toBe('failed');
    expect(fb.id).toBeTruthy();

    // a hard bounce callback suppresses the address and says so with an event
    const msg = (await call('GET', '/v1/messages?recipient=bo@example.com')).json.data[0];
    await anon('POST', '/__emulator/messaging/feedback', { message_id: msg.id, event: 'bounced' });
    expect((await call('GET', '/v1/suppressions?address=bo@example.com')).json.data[0]).toMatchObject({ reason: 'hard_bounce', source: 'provider', message_id: msg.id });
    expect(e.webhooks.events.some((ev) => ev.type === 'message_suppression.created')).toBe(true);
    expect((await call('PUT', '/v1/messaging/country_routes', { country: 'DE', provider_id: 'nope' })).status).toBe(400);
  });
});

describe('billing: invoices, usage, consume, trials', () => {
  it('refunds an invoice partially with an idempotent key and never past what was paid', async () => {
    const e = makeEngine();
    const call = client(e);
    const anon = client(e, null);
    const u = (await call('POST', '/v1/users', { email_address: 'pay@example.com' })).json;
    const inv = (await anon('POST', '/__emulator/billing/invoices', { subject_type: 'user', subject_id: u.id, amount_paid: 1000 })).json;
    expect((await call('POST', `/v1/billing/invoices/${inv.id}/refund`, {})).status).toBe(400); // key required
    const r1 = await call('POST', `/v1/billing/invoices/${inv.id}/refund`, { amount: 400, idempotency_key: 'a' });
    expect(r1.status).toBe(201);
    expect((await call('POST', `/v1/billing/invoices/${inv.id}/refund`, { amount: 400, idempotency_key: 'a' })).json.id).toBe(r1.json.id);
    expect((await call('POST', `/v1/billing/invoices/${inv.id}/refund`, { amount: 700, idempotency_key: 'b' })).status).toBe(400);
    expect((await call('POST', `/v1/billing/invoices/${inv.id}/refund`, { idempotency_key: 'c' })).json.amount).toBe(600);
    expect((await call('POST', `/v1/billing/invoices/${inv.id}/refund`, { idempotency_key: 'd' })).status).toBe(409);
    expect((await call('GET', `/v1/billing/invoices/${inv.id}`)).json).toMatchObject({ amount_refunded: 1000, refunds: expect.any(Array) });
    expect(e.webhooks.events.filter((x) => x.type === 'billing_refund.created')).toHaveLength(2);
  });

  it('keeps one usage ledger: reports, batch with per-event results, read-back, consume against the plan limit, refund', async () => {
    const e = makeEngine();
    const call = client(e);
    const u = (await call('POST', '/v1/users', { email_address: 'use@example.com' })).json;
    const plan = (await call('POST', '/v1/billing/plans', { name: 'Pro', slug: 'pro', limits: { seats: 2 } })).json;
    const sub = await call('POST', '/v1/billing/subscriptions/import', { subject_type: 'user', subject_id: u.id, plan_id: plan.id });
    expect(sub.status).toBe(200);
    const batch = (await call('POST', '/v1/billing/usage/batch', { events: [{ subject_type: 'user', subject_id: u.id, feature: 'api', quantity: 3, idempotency_key: 'e1' }, { subject_type: 'user', subject_id: u.id, feature: 'api', quantity: 3, idempotency_key: 'e1' }, { subject_type: 'user', subject_id: 'missing', feature: 'api', quantity: 1 }] })).json;
    expect(batch).toMatchObject({ recorded: 1, duplicates: 1, failed: 1 });
    expect((await call('GET', `/v1/billing/usage?subject_type=user&subject_id=${u.id}&period=current&events=true`)).json).toMatchObject({ total: 3, by_feature: { api: 3 } });
    const consume = (key: string, quantity = 1) => call('POST', '/v1/entitlements/consume', { subject_type: 'user', subject_id: u.id, feature: 'seats', key, quantity });
    expect((await consume('k1')).json).toMatchObject({ allowed: true, remaining: 1 });
    expect((await consume('k1')).json.duplicate).toBe(true);
    expect((await consume('k2')).json).toMatchObject({ allowed: true, remaining: 0 });
    expect((await consume('k3')).json).toMatchObject({ allowed: false, reason: 'limit_reached' });
    expect(e.webhooks.events.filter((x) => x.type === 'entitlement.limit_reached')).toHaveLength(1);
    const refund = await call('POST', '/v1/entitlements/consume/refund', { subject_type: 'user', subject_id: u.id, feature: 'seats', key: 'k2' });
    expect(refund.json.refunded).toBe(1);
    expect((await call('POST', '/v1/entitlements/consume/refund', { subject_type: 'user', subject_id: u.id, feature: 'seats', key: 'k2' })).status).toBe(409);
    expect((await consume('k4')).json.allowed).toBe(true);
  });

  it('extends a trial by days, idempotently, up to a year in total', async () => {
    const e = makeEngine();
    const call = client(e);
    const u = (await call('POST', '/v1/users', { email_address: 'trial@example.com' })).json;
    const sub = (await call('POST', '/v1/billing/subscriptions/import', { subject_type: 'user', subject_id: u.id, plan_id: 'p', trial_days: 14 })).json;
    const ext = await call('POST', `/v1/billing/subscriptions/${sub.id}/extend_trial`, { days: 7, idempotency_key: 'x' });
    expect(ext.json.trial_end - sub.trial_end).toBe(7 * 86_400_000);
    expect((await call('POST', `/v1/billing/subscriptions/${sub.id}/extend_trial`, { days: 7, idempotency_key: 'x' })).json.trial_end).toBe(ext.json.trial_end);
    expect((await call('POST', `/v1/billing/subscriptions/${sub.id}/extend_trial`, { days: 365 })).status).toBe(400);
    expect(e.webhooks.events.filter((x) => x.type === 'billing_trial.extended')).toHaveLength(1);
  });
});

describe('governance: legal hold, export and import, sessions export, authz', () => {
  it('blocks deletion while a hold is active, and bulk delete skips the held user', async () => {
    const e = makeEngine();
    const call = client(e);
    const u = (await call('POST', '/v1/users', { email_address: 'held@example.com' })).json;
    const hold = await call('POST', `/v1/users/${u.id}/legal_hold`, { reason: 'investigation', case_ref: 'C-1' });
    expect(hold.status).toBe(201);
    expect((await call('POST', `/v1/users/${u.id}/legal_hold`, { reason: 'again' })).status).toBe(200);
    const del = await call('DELETE', `/v1/users/${u.id}`);
    expect(del.status).toBe(409);
    expect(del.json.errors[0].code).toBe('LEGAL_HOLD');
    expect((await call('GET', '/v1/legal_holds')).json.data).toHaveLength(1);
    await call('POST', `/v1/users/${u.id}/legal_hold/release`, { reason: 'closed' });
    expect((await call('GET', `/v1/users/${u.id}/legal_hold`)).json).toMatchObject({ on_hold: false });
    expect((await call('DELETE', `/v1/users/${u.id}`)).status).toBe(200);
  });

  it('exports a signed bundle without private metadata, serves it through a revocable link, and imports it into a fresh instance', async () => {
    const a = makeEngine();
    const ca = client(a);
    const u = (await ca('POST', '/v1/users', { email_address: 'move@example.com', first_name: 'Mo', private_metadata: { secret: 'x' }, public_metadata: { plan: 'pro' } })).json;
    const org = (await ca('POST', '/v1/organizations', { name: 'Move Co' })).json;
    await ca('POST', `/v1/organizations/${org.id}/memberships`, { user_id: u.id, role: 'org:admin' });
    const job = (await ca('POST', '/v1/instance/exports', {})).json;
    expect(job).toMatchObject({ status: 'completed', counts: { users: 1, organizations: 1, memberships: 1 } });
    const bundle = await a.handle(new Request(`http://emulator.test/v1/instance/exports/${job.id}/bundle`, { headers: { authorization: `Bearer ${KEY}` } }));
    const text = await bundle.text();
    expect(text).not.toContain('"secret"');
    expect(bundle.headers.get('x-atlas-bundle-sha256')).toBe(createHash('sha256').update(text).digest('hex'));
    const link = (await ca('POST', `/v1/instance/exports/${job.id}/download_url`)).json.url as string;
    expect((await get(a, new URL(link).pathname + new URL(link).search)).status).toBe(200);
    await ca('POST', `/v1/instance/exports/${job.id}/revoke_links`);
    expect((await get(a, new URL(link).pathname + new URL(link).search)).status).toBe(404);

    const b = makeEngine();
    const cb = client(b);
    expect((await cb('POST', '/v1/instance/imports', { bundle: text, bundle_sha256: 'tampered' })).status).toBe(400);
    // a signature is checked against the exporting instance's own keys: valid there, refused for an altered bundle
    expect((await ca('POST', '/v1/instance/imports', { bundle: `${text} `, signature: job.signature, dry_run: true })).status).toBe(400);
    expect((await ca('POST', '/v1/instance/imports', { bundle: text, signature: job.signature, dry_run: true })).status).toBe(202);
    const dry = (await cb('POST', '/v1/instance/imports', { bundle: text, dry_run: true })).json;
    expect(dry.counts.users.created).toBe(1);
    expect(b.db.users.size).toBe(0);
    const done = (await cb('POST', '/v1/instance/imports', { bundle: text })).json;
    expect(done.counts).toMatchObject({ users: { created: 1 }, organizations: { created: 1 }, memberships: { created: 1 } });
    expect((await cb('GET', `/v1/users/${u.id}`)).json).toMatchObject({ first_name: 'Mo', public_metadata: { plan: 'pro' } });
    expect((await cb('POST', '/v1/instance/imports', { bundle: text })).json.counts.users).toMatchObject({ created: 0, skipped: 1 });
  });

  it('exports sessions as CSV with the same filters as the list, neutralising spreadsheet formulas', async () => {
    const e = makeEngine();
    const call = client(e);
    const u = (await call('POST', '/v1/users', { email_address: 'csv@example.com' })).json;
    const s = (await call('POST', '/v1/sessions', { user_id: u.id })).json;
    e.db.sessions.get(s.id)!.country = '=HYPERLINK("x")';
    const res = await get(e, `/v1/sessions/export?user_id=${u.id}`, { authorization: `Bearer ${KEY}` });
    expect(res.headers.get('content-type')).toContain('text/csv');
    const rows = res.text.trim().split('\n');
    expect(rows[0]).toContain('user_id');
    expect(rows).toHaveLength(2);
    expect(rows[1]).toContain(`'=HYPERLINK`);
    expect((await get(e, '/v1/sessions/export?user_id=user_other', { authorization: `Bearer ${KEY}` })).text.trim().split('\n')).toHaveLength(1);
  });

  it('explains a role decision, logs rbac checks, and replays them under a candidate role edit', async () => {
    const e = makeEngine();
    const call = client(e);
    const u = (await call('POST', '/v1/users', { email_address: 'rbac@example.com' })).json;
    const org = (await call('POST', '/v1/organizations', { name: 'R' })).json;
    await call('POST', `/v1/organizations/${org.id}/memberships`, { user_id: u.id, role: 'org:member' });
    const ex = (await call('POST', '/v1/authz/explain', { subject: { id: u.id }, permission: 'billing:manage', organization_id: org.id })).json;
    expect(ex).toMatchObject({ decision: 'deny', layers: { rbac: { status: 'evaluated' }, abac: { status: 'skipped' } } });
    for (let i = 0; i < 3; i++) await call('POST', '/v1/authz/rbac/check', { subject: { id: u.id }, permission: 'billing:manage', organization_id: org.id });
    const run = (await call('POST', '/v1/authz/what_if', { candidate: { rbac: { roles: [{ type: 'org_role', key: 'org:member', add_permissions: ['billing:manage'] }] } } })).json;
    expect(run).toMatchObject({ evaluated: 3, changed: 3, flipped_to_allow: 3, flipped_to_deny: 0 });
    expect((await call('GET', `/v1/authz/what_if/${run.id}`)).json.samples).toHaveLength(3);
    expect((await call('POST', '/v1/authz/what_if', { candidate: {} })).status).toBe(400);
    expect((await call('DELETE', `/v1/authz/what_if/${run.id}`)).json.deleted).toBe(true);
  });

  it('syncs memberships into a store as managed tuples, repairs drift, feeds events and purges only what it wrote', async () => {
    const e = makeEngine();
    const call = client(e);
    const u = (await call('POST', '/v1/users', { email_address: 'fga@example.com' })).json;
    const org = (await call('POST', '/v1/organizations', { name: 'F' })).json;
    await call('POST', `/v1/organizations/${org.id}/memberships`, { user_id: u.id, role: 'org:admin' });
    const store = (await call('POST', '/v1/fga/stores', { name: 'main' })).json;
    expect((await call('PUT', '/v1/fga/sync', { enabled: true })).status).toBe(400);
    const on = (await call('PUT', '/v1/fga/sync', { enabled: true, store_id: store.id })).json;
    expect(on).toMatchObject({ enabled: true, managed_tuples: 2 }); // member + admin
    await call('DELETE', `/v1/organizations/${org.id}/memberships/${u.id}`);
    expect((await call('POST', '/v1/fga/sync/backfill', {})).json.tuples_deleted).toBe(0); // without repair nothing is removed
    expect((await call('POST', '/v1/fga/sync/backfill', { repair: true })).json.tuples_deleted).toBe(2);
    const feed = (await call('GET', '/v1/authz/events?after=0')).json;
    expect(feed.data.map((x: any) => x.kind)).toEqual(expect.arrayContaining(['tuple_written', 'tuple_deleted', 'sync_run']));
    expect((await call('GET', `/v1/authz/events?after=${feed.next_after}&wait_ms=30`)).json.data).toEqual([]);
    expect((await call('POST', '/v1/fga/sync/purge', { confirm: true })).status).toBe(409); // sync is still on
    await call('PUT', '/v1/fga/sync', { enabled: false });
    expect((await call('POST', '/v1/fga/sync/purge', { confirm: true })).json).toMatchObject({ object: 'fga.sync_purge', deleted: 0 });
    expect((await call('GET', '/v1/fga/sync/runs')).json.data.length).toBeGreaterThanOrEqual(3);
  });
});

describe('hooks: endpoint filters, headers and caps, dead letters, action versions, workflow runs, app events', () => {
  it('delivers only matching events with static headers, caps the rate and never shows header values', async () => {
    const sent: Array<{ url: string; headers: Record<string, string>; type: string }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => (sent.push({ url, headers: init.headers as any, type: JSON.parse(String(init.body)).type }), new Response('ok'))) as unknown as typeof fetch;
    const e = makeEngine({ fetch: fetchImpl });
    const call = client(e);
    const ep = (await call('POST', '/v1/webhook_endpoints', { url: 'https://example.com/h', enabled_events: ['*'], filters: { organization_ids: ['org_a'], metadata: [{ path: 'public_metadata.plan', in: ['pro', 'team'] }] }, headers: { 'X-Api-Key': 'k-123' } })).json;
    expect(ep).toMatchObject({ header_names: ['x-api-key'], filters: { organization_ids: ['org_a'] }, max_rps: null });
    expect(JSON.stringify(ep)).not.toContain('k-123');
    e.webhooks.emit('organization.updated', { object: 'organization', id: 'org_a', public_metadata: { plan: 'pro' } });
    e.webhooks.emit('organization.updated', { object: 'organization', id: 'org_a', public_metadata: { plan: 'free' } });
    e.webhooks.emit('organization.updated', { object: 'organization', id: 'org_b', public_metadata: { plan: 'pro' } });
    await e.flush();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.headers['x-api-key']).toBe('k-123');
    expect((await call('PATCH', `/v1/webhook_endpoints/${ep.id}`, { filters: { metadata: [{ path: 'private_metadata.x', exists: true }] } })).status).toBe(400);
    expect((await call('PATCH', `/v1/webhook_endpoints/${ep.id}`, { filters: null, headers: null, max_rps: 5 })).json).toMatchObject({ filters: null, header_names: [], max_rps: 5 });
    expect((await call('PATCH', `/v1/webhook_endpoints/${ep.id}`, { max_rps: 0 })).status).toBe(400);
  });

  it('pulls exhausted deliveries from the dead-letter queue, acknowledges and requeues them', async () => {
    const e = makeEngine({ fetch: (async () => new Response('no', { status: 500 })) as unknown as typeof fetch });
    const call = client(e);
    const ep = (await call('POST', '/v1/webhook_endpoints', { url: 'https://example.com/h', enabled_events: ['user.created'] })).json;
    await call('POST', '/v1/users', { email_address: 'dlq@example.com' });
    await e.flush();
    const dlq = (await call('GET', `/v1/webhook_endpoints/${ep.id}/dlq`)).json;
    expect(dlq.data).toHaveLength(1);
    expect(dlq.data[0]).toMatchObject({ event_type: 'user.created', last_status: 500 });
    expect((await call('POST', `/v1/webhook_endpoints/${ep.id}/dlq/ack`, { delivery_ids: [] })).status).toBe(400);
    const requeue = (await call('POST', `/v1/webhook_endpoints/${ep.id}/dlq/requeue`, { delivery_ids: [dlq.data[0].delivery_id, 'whdl_unknown'] })).json;
    expect(requeue).toMatchObject({ requeued: 1, not_found: 1 });
    // it failed again: a new dead letter; acknowledging clears it
    const again = (await call('GET', `/v1/webhook_endpoints/${ep.id}/dlq`)).json.data;
    expect(again).toHaveLength(1);
    expect((await call('POST', `/v1/webhook_endpoints/${ep.id}/dlq/ack`, { delivery_ids: [again[0].delivery_id] })).json.acknowledged).toBe(1);
    expect((await call('GET', `/v1/webhook_endpoints/${ep.id}/dlq`)).json.data).toEqual([]);
  });

  it('versions an action, stages a rollout by share, promotes, aborts and rolls back; direct edits are refused while staged', async () => {
    const e = makeEngine();
    const call = client(e);
    const anon = client(e, null);
    const a = (await call('POST', '/v1/actions', { name: 'a', trigger: 'before_user_create', code: 'v1' })).json;
    const v1 = (await call('POST', `/v1/actions/${a.id}/versions`, {})).json;
    expect(v1).toMatchObject({ version: 1, live: true });
    const v2 = (await call('POST', `/v1/actions/${a.id}/versions`, { code: 'v2', note: 'new' })).json;
    expect(v2).toMatchObject({ version: 2, live: false, code: 'v2' });
    expect((await call('PATCH', `/v1/actions/${a.id}/rollout`, { percent: 30 })).json).toMatchObject({ live_version: 1, staged: { version: 2, percent: 30 } });
    expect((await call('PATCH', `/v1/actions/${a.id}`, { code: 'edit' })).status).toBe(409);
    const picks = new Set<number>();
    for (let i = 0; i < 40; i++) picks.add((await anon('POST', `/__emulator/actions/${a.id}/resolve`, { user_id: `user_${i}` })).json.version);
    expect([...picks].sort()).toEqual([1, 2]);
    expect((await anon('POST', `/__emulator/actions/${a.id}/resolve`, { user_id: 'user_7' })).json).toEqual((await anon('POST', `/__emulator/actions/${a.id}/resolve`, { user_id: 'user_7' })).json); // stable per user
    expect((await call('PATCH', `/v1/actions/${a.id}/rollout`, { percent: 0 })).json.staged).toBeNull();
    await call('PATCH', `/v1/actions/${a.id}/rollout`, { percent: 100 });
    expect((await call('GET', `/v1/actions/${a.id}/versions`)).json.data[0]).toMatchObject({ version: 2, live: true });
    expect((await call('POST', `/v1/actions/${a.id}/rollback`, {})).json.live_version).toBe(1);
    expect((await call('PATCH', `/v1/actions/${a.id}`, { egress_allowlist: ['bad host'] })).status).toBe(400);
    expect((await call('PATCH', `/v1/actions/${a.id}`, { egress_allowlist: ['*.example.com'] })).status).toBe(200);
  });

  it('cancels a waiting workflow run and retries a failed one from a step, keeping variables', async () => {
    const e = makeEngine();
    const call = client(e);
    const w = (await call('POST', '/v1/workflows', { name: 'w', enabled: true, trigger: { type: 'manual' }, steps: [{ id: 'a', type: 'set_variable', name: 'x', value: 1 }, { id: 'gate', type: 'approval' }, { id: 'z', type: 'set_variable', name: 'y', value: 2 }] })).json;
    const run = (await call('POST', `/v1/workflows/${w.id}/run`, {})).json;
    expect(run).toMatchObject({ status: 'waiting_approval', vars: { x: 1 } });
    expect((await call('POST', `/v1/workflows/${w.id}/runs/${run.id}/retry`, {})).status).toBe(409);
    const cancelled = (await call('POST', `/v1/workflows/${w.id}/runs/${run.id}/cancel`)).json;
    expect(cancelled.status).toBe('cancelled');
    expect((await call('POST', `/v1/workflows/${w.id}/runs/${run.id}/cancel`)).status).toBe(409);
    expect(e.webhooks.events.some((x) => x.type === 'workflow.run_cancelled')).toBe(true);
    expect((await call('POST', `/v1/workflows/${w.id}/runs/${run.id}/retry`, { from_step: 'z' })).status).toBe(400); // after the stop point
    const retried = (await call('POST', `/v1/workflows/${w.id}/runs/${run.id}/retry`, { from_step: 'a' })).json;
    expect(retried.status).toBe('waiting_approval');
    const done = (await call('POST', `/v1/workflows/${w.id}/runs/${run.id}/resume`)).json;
    expect(done).toMatchObject({ status: 'succeeded', vars: { x: 1, y: 2 } });
    const failing = (await call('POST', `/v1/workflows/${w.id}/run`, { input: { fail_step: 'z' } })).json;
    expect(failing.status).toBe('waiting_approval');
    const resumed = (await call('POST', `/v1/workflows/${w.id}/runs/${failing.id}/resume`)).json;
    expect(resumed).toMatchObject({ status: 'failed', error: 'Step z failed.' });
    expect((await call('POST', `/v1/workflows/${w.id}/runs/${failing.id}/retry`, { from_step: 'gate' })).json.status).toBe('waiting_approval');
  });

  it('broadcasts an app event to every organization with an active endpoint, once per organization per key', async () => {
    const e = makeEngine();
    const call = client(e);
    const orgs = [] as string[];
    for (const n of ['A', 'B', 'C']) orgs.push((await call('POST', '/v1/organizations', { name: n })).json.id);
    for (const id of orgs.slice(0, 2)) await call('POST', `/v1/organizations/${id}/app_webhook_endpoints`, { url: `https://example.com/${id}`, enabled_events: ['*'] });
    const first = (await call('POST', '/v1/app_events', { type: 'announce', organization_id: '*', data: { v: 1 }, idempotency_key: 'k' })).json;
    expect(first).toMatchObject({ object: 'app_event_broadcast', count: 2, created: 2 });
    expect((await call('POST', '/v1/app_events', { type: 'announce', organization_id: '*', data: { v: 1 }, idempotency_key: 'k' })).json).toMatchObject({ count: 2, created: 0 });
    expect((await call('POST', '/v1/app_events', { type: 'announce', organization_id: orgs[2], data: {} })).status).toBe(201);
    expect((await call('GET', `/v1/app_events?organization_id=${orgs[0]}`)).json.data).toHaveLength(1);
    expect((await call('POST', '/v1/app_events', { type: 'announce', organization_id: 'org_missing', data: {} })).status).toBe(404);
  });
});

describe('platform: write budget, deprecations, page templates, journeys', () => {
  it('counts writes, announces the first overrun once, and enforce mode answers 429 write_budget', async () => {
    const e = makeEngine();
    const call = client(e);
    expect((await call('PUT', '/v1/instance/write_budget', { writes_per_minute: 3 })).status).toBe(200);
    for (let i = 0; i < 4; i++) await call('POST', '/v1/organizations', { name: `o${i}` });
    const observed = (await call('GET', '/v1/instance/write_budget')).json;
    expect(observed).toMatchObject({ mode: 'observe', exceeded_in_window: ['writes'] });
    expect(e.webhooks.events.filter((x) => x.type === 'write_budget.exceeded')).toHaveLength(1);
    await call('PUT', '/v1/instance/write_budget', { mode: 'enforce' });
    const refused = await call('POST', '/v1/organizations', { name: 'over' });
    expect(refused.status).toBe(429);
    expect(refused.json.errors[0].meta.reason).toBe('write_budget');
    expect((await call('GET', '/v1/organizations')).status).toBe(200); // reads are never counted
    e.clock.advance(61_000);
    expect((await call('POST', '/v1/organizations', { name: 'again' })).status).toBe(200);
    expect((await call('PUT', '/v1/instance/write_budget', { writes_per_minute: 0 })).status).toBe(400);
    expect((await call('DELETE', '/v1/instance/write_budget')).json.mode).toBe('observe');
  });

  it('lists deprecations from the document and records the first use of a deprecated route', async () => {
    const doc: any = JSON.parse(JSON.stringify(makeEngine().options.openapi));
    doc.paths['/v1/users'].get.deprecated = true;
    doc.paths['/v1/users'].get['x-sunset'] = '2027-06-01T00:00:00Z';
    const e = makeEngine({ openapi: doc });
    const call = client(e);
    const before = (await call('GET', '/v1/instance/deprecations')).json;
    expect(before.data.find((d: any) => d.path === '/v1/users')).toMatchObject({ in_use: false, sunset: '2027-06-01' });
    await call('GET', '/v1/users');
    const after = (await call('GET', '/v1/instance/deprecations')).json;
    expect(after.in_use).toBe(1);
    expect((await client(e, null)('GET', '/v1/deprecations')).json.data.length).toBeGreaterThan(0);
    expect((await client(e, null)('GET', '/v1/path_mount/probe')).json).toMatchObject({ mounted: false, via: null });
  });

  it('keeps a draft and a live template per audience and checks the audience exists', async () => {
    const e = makeEngine();
    const call = client(e);
    const def = { version: 1, regions: { header: [{ type: 'heading', text: 'Bonjour' }] } };
    expect((await call('PUT', '/v1/instance/page_templates/sign-in?locale=fr', { definition: { regions: { sidebar: [] } } })).status).toBe(400);
    expect((await call('PUT', '/v1/instance/page_templates/sign-in?client_id=oac_missing', { definition: def })).status).toBe(404);
    expect((await call('PUT', '/v1/instance/page_templates/sign-in?locale=fr', { definition: def })).json).toMatchObject({ draft: { regions: { header: [{ type: 'heading' }] } }, live: null, locale: 'fr' });
    expect((await call('GET', '/v1/instance/page_templates/sign-in')).json).toMatchObject({ draft: null, locale: null });
    expect((await call('POST', '/v1/instance/page_templates/sign-in/promote?locale=fr')).json).toMatchObject({ draft: null, live: { version: 1 }, version: 1 });
    expect((await call('POST', '/v1/instance/page_templates/sign-in/preview?locale=fr')).status).toBe(409); // no draft left
    expect((await call('GET', '/v1/instance/page_templates?locale=fr')).json.data).toHaveLength(8);
    expect((await call('DELETE', '/v1/instance/page_templates/sign-in?locale=fr&status=live')).json.deleted).toBe(true);
    expect((await call('GET', '/v1/instance/page_templates/nope')).status).toBe(404);
  });

  it('tracks a journey run: drafts survive, steps complete in order, idle runs are abandoned once and reopen', async () => {
    const e = makeEngine();
    const call = client(e);
    const anon = client(e, null);
    const { user, as } = await userWithSession(e, 'jr@example.com');
    const flow = (await call('POST', '/v1/flows', { name: 'onboarding', definition: { steps: [{ id: 'profile', type: 'form', on: ['sign_up'] }, { id: 'terms', type: 'policy_acceptance', on: ['sign_up'] }, { id: 'signin_only', type: 'form' }] } })).json;
    const run = (await anon('POST', `/__emulator/journeys/${flow.id}/start`, { user_id: user.id, stage: 'sign_up' })).json;
    expect(run).toMatchObject({ status: 'in_progress', open_steps: ['profile', 'terms'] });
    await anon('POST', `/__emulator/journeys/runs/${run.id}/draft`, { step: 'profile', values: { first_name: 'A' } });
    expect((await call('GET', `/v1/users/${user.id}/journeys`)).json.data[0].drafts).toEqual({ profile: { first_name: 'A' } });
    expect(JSON.parse((await get(e, '/v1/client/me/journeys', as)).text).data).toHaveLength(1);
    expect((await call('GET', `/v1/flows/${flow.id}/runs`)).json.data[0].drafts).toBeUndefined();
    e.clock.advance(73 * 3_600_000);
    expect((await anon('POST', '/__emulator/journeys/sweep', {})).json.abandoned).toBe(1);
    expect((await anon('POST', '/__emulator/journeys/sweep', {})).json.abandoned).toBe(0);
    expect((await anon('POST', `/__emulator/journeys/${flow.id}/start`, { user_id: user.id, stage: 'sign_up' })).json).toMatchObject({ id: run.id, status: 'in_progress' });
    await anon('POST', `/__emulator/journeys/runs/${run.id}/complete_step`, { step: 'profile' });
    const done = (await anon('POST', `/__emulator/journeys/runs/${run.id}/complete_step`, { step: 'terms' })).json;
    expect(done).toMatchObject({ status: 'completed', open_steps: [], drafts: {} });
    expect(e.webhooks.events.map((x) => x.type).filter((t) => t.startsWith('journey.'))).toEqual(['journey.started', 'journey.abandoned', 'journey.step_completed', 'journey.step_completed', 'journey.completed']);
    expect((await call('DELETE', `/v1/users/${user.id}/journeys?journey_id=${flow.id}`)).json.removed).toBe(1);
  });
});

describe('connections: activity, provider events, reconnect, token exchange', () => {
  const setup = async (opts: Record<string, unknown> = {}) => {
    const e = makeEngine(opts);
    const call = client(e);
    const anon = client(e, null);
    const u = (await call('POST', '/v1/users', { email_address: 'conn@example.com' })).json;
    const c = (await call('POST', '/v1/connections', { owner: { type: 'user', id: u.id }, kind: 'oauth', provider: 'github', name: 'gh', allowed_hosts: ['api.github.com'], allowed_methods: ['GET'] })).json;
    return { e, call, anon, u, c };
  };

  it('logs relay calls without paths or bodies, and blocked calls too', async () => {
    const fetchImpl = (async () => new Response('{"ok":true}', { status: 200 })) as unknown as typeof fetch;
    const { call, c } = await setup({ fetch: fetchImpl });
    expect((await call('POST', `/v1/connections/${c.id}/relay`, { url: 'https://api.github.com/user?secret=1' })).json).toMatchObject({ status: 200 });
    expect((await call('POST', `/v1/connections/${c.id}/relay`, { url: 'https://evil.example/x' })).status).toBe(403);
    expect((await call('POST', `/v1/connections/${c.id}/relay`, { url: 'https://api.github.com/user', method: 'DELETE' })).status).toBe(403);
    const log = (await call('GET', `/v1/connections/${c.id}/activity`)).json.data;
    expect(log.map((r: any) => r.outcome).sort()).toEqual(['blocked', 'blocked', 'ok']);
    expect(JSON.stringify(log)).not.toContain('secret=1');
    expect(log.find((r: any) => r.outcome === 'ok')).toMatchObject({ kind: 'relay', method: 'GET', host: 'api.github.com', status: 200 });
    expect((await call('GET', `/v1/connections/${c.id}/activity?outcome=blocked`)).json.data).toHaveLength(2);
  });

  it('stores provider events, replays them without re-revoking, and an uninstall revokes the connection once', async () => {
    const { e, call, anon, c } = await setup();
    const ingest = (topic: string) => anon('POST', `/v1/connection_provider_events/${e.instanceId}/github`, { connection_id: c.id, topic, payload: { n: 1 } });
    expect((await anon('POST', '/v1/connection_provider_events/ins_other/github', { connection_id: c.id, topic: 'push' })).status).toBe(404);
    const push = (await ingest('push')).json;
    expect((await call('GET', `/v1/connections/${c.id}/provider_events/${push.id}`)).json.payload).toEqual({ n: 1 });
    expect((await call('GET', `/v1/connections/${c.id}/provider_events`)).json.data[0].payload).toBeUndefined();
    const un = (await ingest('app/uninstalled')).json;
    expect(un.kind).toBe('uninstall');
    expect((await call('GET', `/v1/connections/${c.id}`)).json.status).toBe('revoked');
    const revokedBefore = e.webhooks.events.filter((x) => x.type === 'connection.revoked').length;
    expect((await call('POST', `/v1/connections/${c.id}/provider_events/${un.id}/replay`)).json).toMatchObject({ replayed: true, replay_count: 1 });
    expect(e.webhooks.events.filter((x) => x.type === 'connection.revoked').length).toBe(revokedBefore);
    expect(e.webhooks.events.filter((x) => x.type === 'connection.provider_event').pop()!.payload.data).toMatchObject({ replayed: true, event_id: un.id });
    expect((await call('GET', '/v1/connection_provider_event_log?provider=github')).json.data).toHaveLength(2);
  });

  it('mints a one-time reconnect link (hash stored), sends it through the message sink, and every bad link answers the same', async () => {
    const { e, call, anon, c } = await setup();
    expect((await call('POST', `/v1/connections/${c.id}/reconnect_link`, {})).status).toBe(409); // off by default
    expect((await call('PUT', '/v1/connection_reconnect_settings', { enabled: true, return_url: 'http://insecure.example' })).status).toBe(400);
    await call('PUT', '/v1/connection_reconnect_settings', { enabled: true, link_ttl_hours: 24 });
    const link = (await call('POST', `/v1/connections/${c.id}/reconnect_link`, { send_email: true })).json;
    expect(link).toMatchObject({ object: 'connection_reconnect_link', emailed: 1 });
    expect(e.messages.messages.some((m) => m.link === link.url)).toBe(true);
    const path = new URL(link.url).pathname;
    expect((await anon('GET', path)).json).toMatchObject({ object: 'connection_reconnect_page', connection: { provider: 'github' } });
    expect((await anon('GET', path)).status).toBe(200); // looking spends nothing
    const start = await get(e, `${path}/start`);
    expect(start.status).toBe(302);
    expect(start.location).toContain('/__emulator/provider/github/authorize');
    expect((await anon('GET', path)).status).toBe(400); // used
    expect((await anon('GET', '/v1/connection_reconnect/unknown')).json.errors[0].message).toBe((await anon('GET', path)).json.errors[0].message);
  });

  it('exchanges a Shopify token only against the shop\'s own host', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => (calls.push(url), new Response(JSON.stringify({ access_token: 'shpat_new', refresh_token: 'r', expires_in: 3600 })))) as unknown as typeof fetch;
    const { e, call, u } = await setup({ fetch: fetchImpl });
    const shop = (await call('POST', '/v1/connections', { owner: { type: 'user', id: u.id }, kind: 'oauth', provider: 'shopify', name: 's', allowed_hosts: ['acme.myshopify.com'], host_params: { shop: 'acme' } })).json;
    void e;
    expect((await call('POST', `/v1/connections/${shop.id}/token/exchange`, {})).json).toMatchObject({ exchanged: true, expiring: true, has_refresh_token: true });
    expect(calls).toEqual(['https://acme.myshopify.com/admin/oauth/access_token']);
    expect((await call('POST', `/v1/connections/${shop.id}/token/exchange`, {})).status).toBe(409);
    const evil = (await call('POST', '/v1/connections', { owner: { type: 'user', id: u.id }, kind: 'oauth', provider: 'shopify', name: 'e', allowed_hosts: ['evil.example'], host_params: { shop: 'evil.example' } })).json;
    expect((await call('POST', `/v1/connections/${evil.id}/token/exchange`, {})).status).toBe(400);
    expect(calls).toHaveLength(1);
  });
});
