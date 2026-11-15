/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from 'vitest';
import { client, makeEngine } from './test-support';
import type { Engine, EmulatorOptions } from './engine';

const events = (e: Engine, type: string) => e.webhooks.events.filter((x) => x.type === type);
const soap = (inner: string) => `<?xml version="1.0"?><soap-env:Envelope xmlns:soap-env="http://schemas.xmlsoap.org/soap/envelope/"><soap-env:Body>${inner}</soap-env:Body></soap-env:Envelope>`;
const resolveXml = (issuer: string, artifact: string, id = '_req1') => soap(`<samlp:ArtifactResolve xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${id}" Version="2.0" IssueInstant="2026-01-01T00:00:00Z"><saml:Issuer>${issuer}</saml:Issuer><samlp:Artifact>${artifact}</samlp:Artifact></samlp:ArtifactResolve>`);
const sendXml = async (e: Engine, path: string, body: string) => {
  const res = await e.handle(new Request(`http://emulator.test${path}`, { method: 'POST', headers: { 'content-type': 'text/xml; charset=utf-8' }, body }));
  return { status: res.status, text: await res.text(), headers: res.headers };
};
const form = async (e: Engine, path: string, fields: Record<string, string>, method = 'POST') => {
  const qs = new URLSearchParams(fields).toString();
  const res = await e.handle(method === 'GET' ? new Request(`http://emulator.test${path}?${qs}`) : new Request(`http://emulator.test${path}`, { method, headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: qs }));
  const text = await res.text();
  return { status: res.status, json: text ? (() => { try { return JSON.parse(text); } catch { return text; } })() : null, headers: res.headers };
};
const getUrl = async (e: Engine, url: string) => {
  const res = await e.handle(new Request(url));
  const text = await res.text();
  return { status: res.status, json: text ? (() => { try { return JSON.parse(text); } catch { return text; } })() : null, headers: res.headers };
};

const samlSetup = async (opts: Partial<EmulatorOptions> = {}) => {
  const e = makeEngine(opts);
  const call = client(e);
  const conn = (await call('POST', '/__emulator/saml/sp/connections', { name: 'Corp', idp: 'emulator' })).json;
  const begin = async () => (await call('POST', `/__emulator/saml/sp/connections/${conn.id}/start`, { redirect_url: 'https://app.example.com/done' })).json;
  const authenticate = async (body: Record<string, unknown>) => (await call('POST', '/__emulator/saml/idp/authenticate', { sp_entity_id: conn.sp_entity_id, ...body })).json;
  return { e, call, conn, begin, authenticate };
};

describe('SAML artifact binding: the service provider side against the emulator identity provider', () => {
  it('signs a user in through the artifact, claims it once, and hands back a ticket for a session', async () => {
    const { e, call, begin, authenticate, conn } = await samlSetup();
    const user = (await call('POST', '/v1/users', { email_address: 'sam@idp.test', first_name: 'Sam' })).json;
    expect(conn).toMatchObject({ object: 'saml_connection', acs_url: expect.stringContaining('/v1/sso/saml/acs') });
    const attempt = await begin();
    const auth = await authenticate({ user_id: user.id, in_response_to: attempt.request_id, relay_state: attempt.relay_state });
    expect(auth).toMatchObject({ object: 'saml_artifact_binding', relay_state: attempt.relay_state });
    // the artifact is 44 bytes: type 4, endpoint index, source id, message handle
    expect(Buffer.from(auth.saml_art, 'base64')).toHaveLength(44);
    expect(Buffer.from(auth.saml_art, 'base64').readUInt16BE(0)).toBe(4);
    const res = await getUrl(e, auth.redirect_url);
    expect(res.status).toBe(302);
    const back = new URL(res.headers.get('location')!);
    expect(back.origin + back.pathname).toBe('https://app.example.com/done');
    const done = (await call('GET', `/__emulator/saml/attempts/${attempt.id}`)).json;
    expect(done).toMatchObject({ status: 'complete', user_id: user.id, created_user: false, artifact_claimed: true });
    expect(back.searchParams.get('__atlas_attempt')).toBe(attempt.id);
    const ticket = back.searchParams.get('__atlas_ticket')!;
    const session = await call('POST', `/__emulator/saml/attempts/${attempt.id}/redeem`, { ticket });
    expect(session.status).toBe(200);
    expect(session.json.jwt).toBeTruthy();
    expect((await e.tokens.verifyAny(session.json.jwt)).ok).toBe(true);
    expect((await call('POST', `/__emulator/saml/attempts/${attempt.id}/redeem`, { ticket })).status).toBe(400);
    // the same artifact again: the attempt is finished, so the browser gets the generic "unknown link"
    const again = await getUrl(e, auth.redirect_url);
    expect(again.status).toBe(400);
    expect(again.json.errors[0]).toMatchObject({ code: 'VALIDATION_FAILED', param: 'RelayState', message: 'Unknown or expired sign-in link.' });
    expect((await call('GET', '/__emulator/compliance/audit?action=sso.saml.artifact_resolve')).json.data[0].metadata).toMatchObject({ outcome: 'ok' });
  });

  it('creates the user on first sign-in unless sign-up is off', async () => {
    const { e, call, begin, authenticate, conn } = await samlSetup();
    const attempt = await begin();
    const auth = await authenticate({ email: 'new.person@idp.test', in_response_to: attempt.request_id, relay_state: attempt.relay_state, attributes: { first_name: 'Nia', last_name: 'Newman' } });
    expect((await getUrl(e, auth.redirect_url)).status).toBe(302);
    const done = (await call('GET', `/__emulator/saml/attempts/${attempt.id}`)).json;
    expect(done.created_user).toBe(true);
    const created = e.db.users.get(done.user_id)!;
    expect(created).toMatchObject({ first_name: 'Nia', last_name: 'Newman' });
    expect((created.emails as any[])[0].email_address).toBe('new.person@idp.test');
    // sign-up off: the same assertion for another stranger fails closed
    const closed = (await call('POST', '/__emulator/saml/sp/connections', { name: 'Closed', idp: 'emulator', allow_sign_up: false })).json;
    const a2 = (await call('POST', `/__emulator/saml/sp/connections/${closed.id}/start`, { redirect_url: 'https://app.example.com/done' })).json;
    const auth2 = (await call('POST', '/__emulator/saml/idp/authenticate', { sp_entity_id: closed.sp_entity_id, email: 'stranger@idp.test', in_response_to: a2.request_id, relay_state: a2.relay_state })).json;
    expect((await getUrl(e, auth2.redirect_url)).status).toBe(400);
    expect((await call('GET', `/__emulator/saml/attempts/${a2.id}`)).json).toMatchObject({ status: 'failed', failure_reason: 'sign_up_disabled' });
    expect(conn.id).not.toBe(closed.id);
  });

  it('refuses a response for another request, and tells the browser nothing about why', async () => {
    const { e, call, begin, authenticate } = await samlSetup();
    const user = (await call('POST', '/v1/users', { email_address: 'x@idp.test' })).json;
    const attempt = await begin();
    const auth = await authenticate({ user_id: user.id, in_response_to: '_someone_elses_request', relay_state: attempt.relay_state });
    const res = await getUrl(e, auth.redirect_url);
    expect(res.status).toBe(400);
    expect(res.json.errors[0]).toMatchObject({ message: 'Could not verify that SAML sign-in.', param: 'SAMLart' });
    expect(JSON.stringify(res.json)).not.toContain('in_response_to');
    expect((await call('GET', `/__emulator/saml/attempts/${attempt.id}`)).json).toMatchObject({ status: 'failed', failure_reason: 'in_response_to_mismatch' });
    const audit = (await call('GET', '/__emulator/compliance/audit?action=sso.saml.artifact_resolve')).json.data;
    expect(audit[0].metadata).toMatchObject({ outcome: 'failed', reason: 'in_response_to_mismatch' });
    expect(e.db.users.all()).toHaveLength(1);
  });

  it('an artifact is useless once spent, once expired, in the wrong source, or without a sign-in behind it', async () => {
    const { e, call, begin, authenticate } = await samlSetup();
    const user = (await call('POST', '/v1/users', { email_address: 'y@idp.test' })).json;
    // expired: a minute passes before the browser comes back
    let attempt = await begin();
    let auth = await authenticate({ user_id: user.id, in_response_to: attempt.request_id, relay_state: attempt.relay_state });
    await call('POST', '/__emulator/time/advance', { ms: 61_000 });
    expect((await getUrl(e, auth.redirect_url)).status).toBe(400);
    expect((await call('GET', `/__emulator/saml/attempts/${attempt.id}`)).json.failure_reason).toBe('no_response');
    // a made-up artifact of the right shape
    attempt = await begin();
    const bogus = Buffer.from(auth.saml_art, 'base64');
    bogus.fill(7, 24);
    expect((await form(e, '/v1/sso/saml/acs', { SAMLart: bogus.toString('base64'), RelayState: attempt.relay_state }, 'GET')).status).toBe(400);
    expect((await call('GET', `/__emulator/saml/attempts/${attempt.id}`)).json.failure_reason).toBe('no_response');
    // malformed: wrong length
    attempt = await begin();
    expect((await form(e, '/v1/sso/saml/acs', { SAMLart: 'AAQAAA==', RelayState: attempt.relay_state }, 'GET')).status).toBe(400);
    expect((await call('GET', `/__emulator/saml/attempts/${attempt.id}`)).json.failure_reason).toBe('malformed_artifact');
    // no artifact reaches the IdP twice: a second attempt claiming an artifact that the IdP already gave away fails
    attempt = await begin();
    auth = await authenticate({ user_id: user.id, in_response_to: attempt.request_id, relay_state: attempt.relay_state });
    expect((await getUrl(e, auth.redirect_url)).status).toBe(302);
    const attempt2 = await begin();
    const replay = await form(e, '/v1/sso/saml/acs', { SAMLart: auth.saml_art, RelayState: attempt2.relay_state }, 'GET');
    expect(replay.status).toBe(400);
    expect((await call('GET', `/__emulator/saml/attempts/${attempt2.id}`)).json.failure_reason).toBe('no_response');
  });

  it('validates the ACS request: one of SAMLResponse or SAMLart, a known RelayState, no unsolicited artifact', async () => {
    const { e } = await samlSetup();
    expect((await form(e, '/v1/sso/saml/acs', {})).json.errors[0]).toMatchObject({ param: 'SAMLResponse', message: 'Missing SAMLResponse.' });
    expect((await form(e, '/v1/sso/saml/acs', { SAMLResponse: 'eA==', SAMLart: 'AAQAAA==' })).json.errors[0].param).toBe('SAMLart');
    expect((await form(e, '/v1/sso/saml/acs', { SAMLart: 'AAQAAA==', RelayState: 'unknown' }, 'GET')).json.errors[0]).toMatchObject({ param: 'RelayState' });
    expect((await form(e, '/v1/sso/saml/acs', { SAMLart: 'AAQAAA==' }, 'GET')).status).toBe(400);
    // a SAMLResponse is never read from a URL
    expect((await form(e, '/v1/sso/saml/acs', { SAMLResponse: 'eA==' }, 'GET')).json.errors[0].message).toBe('Missing SAMLResponse.');
  });

  it('the POST binding works the same way, refuses a replayed assertion, and an IdP-initiated sign-in needs a known IdP', async () => {
    const { e, call, begin, authenticate } = await samlSetup();
    const user = (await call('POST', '/v1/users', { email_address: 'post@idp.test' })).json;
    const attempt = await begin();
    const auth = await authenticate({ user_id: user.id, in_response_to: attempt.request_id, relay_state: attempt.relay_state, binding: 'post' });
    expect(auth.object).toBe('saml_post_binding');
    const ok = await form(e, '/v1/sso/saml/acs', { SAMLResponse: auth.saml_response, RelayState: attempt.relay_state });
    expect(ok.status).toBe(302);
    const second = await begin();
    const replay = await form(e, '/v1/sso/saml/acs', { SAMLResponse: auth.saml_response, RelayState: second.relay_state });
    expect(replay.status).toBe(400);
    expect((await call('GET', `/__emulator/saml/attempts/${second.id}`)).json.failure_reason).toBe('in_response_to_mismatch');
    // IdP-initiated: no RelayState, no InResponseTo
    const idp = await authenticate({ user_id: user.id, binding: 'post' });
    const initiated = await form(e, '/v1/sso/saml/acs', { SAMLResponse: idp.saml_response });
    expect(initiated.status).toBe(302);
    expect(new URL(initiated.headers.get('location')!).searchParams.get('__atlas_ticket')).toMatch(/^tkt_/);
    expect((await form(e, '/v1/sso/saml/acs', { SAMLResponse: idp.saml_response })).status).toBe(400); // assertion replay
    expect((await form(e, '/v1/sso/saml/acs', { SAMLResponse: btoa('<Response><Issuer>https://nobody</Issuer></Response>') })).status).toBe(400);
  });

  it('SP metadata lists the artifact consumer only when the connection resolves artifacts', async () => {
    const { e, conn, call } = await samlSetup();
    const md = await getUrl(e, `http://emulator.test/v1/sso/saml/${conn.id}/metadata`);
    expect(md.json).toContain('HTTP-Artifact');
    expect(md.json).toContain(`entityID="${conn.sp_entity_id}"`);
    const plain = (await call('POST', '/__emulator/saml/sp/connections', { name: 'Post only', idp_entity_id: 'https://idp.example.org/saml' })).json;
    expect((await getUrl(e, `http://emulator.test/v1/sso/saml/${plain.id}/metadata`)).json).not.toContain('HTTP-Artifact');
    expect((await getUrl(e, 'http://emulator.test/v1/sso/saml/samlc_missing/metadata')).status).toBe(404);
    expect((await call('POST', '/__emulator/saml/sp/connections', { name: 'x', idp_entity_id: 'https://i', artifact_resolution_url: 'http://insecure.example.org/a' })).status).toBe(400);
  });
});

describe('SAML artifact binding: the identity provider side', () => {
  const idpSetup = async () => {
    const e = makeEngine();
    const call = client(e);
    const sp = (await call('POST', '/__emulator/saml/idp/service_providers', { entity_id: 'https://app.example.com/sp', acs_url: 'https://app.example.com/acs' })).json;
    const other = (await call('POST', '/__emulator/saml/idp/service_providers', { entity_id: 'https://other.example.com/sp', acs_url: 'https://other.example.com/acs' })).json;
    const user = (await call('POST', '/v1/users', { email_address: 'idp.user@example.com' })).json;
    const issue = async (entity = 'https://app.example.com/sp', extra: Record<string, unknown> = {}) => (await call('POST', '/__emulator/saml/idp/authenticate', { sp_entity_id: entity, user_id: user.id, relay_state: 'rs1', ...extra })).json;
    return { e, call, sp, other, user, issue };
  };

  it('publishes metadata with the resolution service and answers an ArtifactResolve once', async () => {
    const { e, issue } = await idpSetup();
    const md = await getUrl(e, 'http://emulator.test/v1/saml/idp/metadata');
    expect(md.json).toContain('ArtifactResolutionService');
    expect(md.json).toContain('/v1/saml/idp/artifact');
    const art = await issue('https://app.example.com/sp', { in_response_to: '_authn1' });
    expect(art.redirect_url).toContain('https://app.example.com/acs?SAMLart=');
    const first = await sendXml(e, '/v1/saml/idp/artifact', resolveXml('https://app.example.com/sp', art.saml_art, '_resolve1'));
    expect(first.status).toBe(200);
    expect(first.headers.get('content-type')).toContain('text/xml');
    expect(first.text).toContain('InResponseTo="_resolve1"');
    expect(first.text).toContain('urn:oasis:names:tc:SAML:2.0:status:Success');
    expect(first.text).toContain('<samlp:Response');
    expect(first.text).toContain('InResponseTo="_authn1"');
    expect(first.text).toContain('idp.user@example.com');
    expect(first.text).toContain('<saml:Audience>https://app.example.com/sp</saml:Audience>');
    const second = await sendXml(e, '/v1/saml/idp/artifact', resolveXml('https://app.example.com/sp', art.saml_art, '_resolve2'));
    expect(second.status).toBe(200);
    expect(second.text).toContain('InResponseTo="_resolve2"');
    expect(second.text).not.toContain('<samlp:Response');
  });

  it('is bound to the app it was meant for, and refuses what it cannot read', async () => {
    const { e, issue } = await idpSetup();
    const art = await issue();
    // another registered app asking for it gets nothing, and the artifact is spent
    const stolen = await sendXml(e, '/v1/saml/idp/artifact', resolveXml('https://other.example.com/sp', art.saml_art));
    expect(stolen.status).toBe(200);
    expect(stolen.text).not.toContain('<samlp:Response');
    const owner = await sendXml(e, '/v1/saml/idp/artifact', resolveXml('https://app.example.com/sp', art.saml_art));
    expect(owner.text).not.toContain('<samlp:Response');
    expect((await sendXml(e, '/v1/saml/idp/artifact', resolveXml('https://unknown.example.com/sp', art.saml_art))).status).toBe(403);
    expect((await sendXml(e, '/v1/saml/idp/artifact', 'not xml')).status).toBe(400);
    expect((await sendXml(e, '/v1/saml/idp/artifact', '<!DOCTYPE x [<!ENTITY a "b">]>' + resolveXml('https://app.example.com/sp', art.saml_art))).status).toBe(400);
    expect((await sendXml(e, '/v1/saml/idp/artifact', soap('<samlp:Other xmlns:samlp="urn:x"/>'))).status).toBe(400);
    const fault = await sendXml(e, '/v1/saml/idp/artifact', resolveXml('https://unknown.example.com/sp', art.saml_art));
    expect(fault.text).toContain('Unknown requester.');
    // an app that does not use the artifact binding is refused at the helper and at the service
    const call = client(e);
    await call('POST', '/__emulator/saml/idp/service_providers', { entity_id: 'https://post.example.com/sp', acs_url: 'https://post.example.com/acs', artifact_binding: false });
    expect((await call('POST', '/__emulator/saml/idp/authenticate', { sp_entity_id: 'https://post.example.com/sp', email: 'a@b.test' })).status).toBe(400);
    expect((await sendXml(e, '/v1/saml/idp/artifact', resolveXml('https://post.example.com/sp', art.saml_art))).status).toBe(403);
    expect((await call('POST', '/__emulator/saml/idp/service_providers', { entity_id: 'https://app.example.com/sp', acs_url: 'https://app.example.com/acs' })).status).toBe(409);
  });

  it('an artifact for one source is not an artifact for another', async () => {
    const { e, issue } = await idpSetup();
    const art = await issue();
    const raw = Buffer.from(art.saml_art, 'base64');
    raw[10]! ^= 0xff; // the source id
    const res = await sendXml(e, '/v1/saml/idp/artifact', resolveXml('https://app.example.com/sp', raw.toString('base64')));
    expect(res.text).not.toContain('<samlp:Response');
    const wrongType = Buffer.from(art.saml_art, 'base64');
    wrongType[1] = 5;
    expect((await sendXml(e, '/v1/saml/idp/artifact', resolveXml('https://app.example.com/sp', wrongType.toString('base64')))).text).not.toContain('<samlp:Response');
  });
});

describe('SAML artifact binding: an external identity provider over the back channel', () => {
  const IDP = 'https://idp.example.org/saml';
  const art = Buffer.concat([Buffer.from([0, 4, 0, 0]), Buffer.alloc(20, 1), Buffer.alloc(20, 2)]).toString('base64');
  const iso = (ms: number) => new Date(ms).toISOString();
  /** The Response the identity provider would send for a sign-in (`over` bends one thing at a time). */
  const responseXml = (conn: any, requestId: string, over: Record<string, string> = {}) => {
    const now = Date.now();
    return `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_resp${Math.random().toString(36).slice(2)}" Version="2.0" IssueInstant="${iso(now)}" Destination="${over.destination ?? conn.acs_url}" InResponseTo="${requestId}"><saml:Issuer>${IDP}</saml:Issuer><samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status><saml:Assertion ID="_as${Math.random().toString(36).slice(2)}" Version="2.0" IssueInstant="${iso(now)}"><saml:Issuer>${over.issuer ?? IDP}</saml:Issuer><saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">ext@idp.test</saml:NameID><saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData NotOnOrAfter="${iso(now + 300_000)}" Recipient="${over.recipient ?? conn.acs_url}" InResponseTo="${requestId}"/></saml:SubjectConfirmation></saml:Subject><saml:Conditions NotBefore="${iso(now - 1000)}" NotOnOrAfter="${over.notOnOrAfter ?? iso(now + 300_000)}"><saml:AudienceRestriction><saml:Audience>${over.audience ?? conn.sp_entity_id}</saml:Audience></saml:AudienceRestriction></saml:Conditions></saml:Assertion></samlp:Response>`;
  };
  const artifactResponse = (id: string, inner: string, over: { issuer?: string; inResponseTo?: string; status?: string } = {}) =>
    soap(`<samlp:ArtifactResponse xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_ar1" Version="2.0" InResponseTo="${over.inResponseTo ?? id}"><saml:Issuer>${over.issuer ?? IDP}</saml:Issuer><samlp:Status><samlp:StatusCode Value="${over.status ?? 'urn:oasis:names:tc:SAML:2.0:status:Success'}"/></samlp:Status>${inner}</samlp:ArtifactResponse>`);

  type Respond = (ctx: { id: string; conn: any; requestId: string }) => { status?: number; xml: string };
  /** Run one sign-in against a scripted identity provider reached through the engine's fetch. */
  const run = async (respond: Respond) => {
    const ctx: { conn: any; requestId: string } = { conn: null, requestId: '' };
    const calls: Array<{ url: string; contentType: string }> = [];
    const fetchImpl = (async (url: string, init: any) => {
      calls.push({ url, contentType: init.headers['content-type'] });
      const id = /ID="([^"]+)"/.exec(String(init.body))![1]!;
      const r = respond({ id, conn: ctx.conn, requestId: ctx.requestId });
      return new Response(r.xml, { status: r.status ?? 200, headers: { 'content-type': 'text/xml' } });
    }) as unknown as typeof fetch;
    const e = makeEngine({ fetch: fetchImpl });
    const call = client(e);
    ctx.conn = (await call('POST', '/__emulator/saml/sp/connections', { name: 'External', idp_entity_id: IDP, artifact_resolution_url: 'https://idp.example.org/artifact' })).json;
    const attempt = (await call('POST', `/__emulator/saml/sp/connections/${ctx.conn.id}/start`, { redirect_url: 'https://app.example.com/done' })).json;
    ctx.requestId = attempt.request_id;
    const res = await form(e, '/v1/sso/saml/acs', { SAMLart: art, RelayState: attempt.relay_state }, 'GET');
    const state = (await call('GET', `/__emulator/saml/attempts/${attempt.id}`)).json;
    return { res, state, calls, e };
  };

  it('resolves over the identity provider URL and signs in when every check passes', async () => {
    const { res, state, calls, e } = await run(({ id, conn, requestId }) => ({ xml: artifactResponse(id, responseXml(conn, requestId)) }));
    expect(calls).toEqual([{ url: 'https://idp.example.org/artifact', contentType: 'text/xml; charset=utf-8' }]);
    expect(res.status).toBe(302);
    expect(state).toMatchObject({ status: 'complete', created_user: true });
    expect(e.db.users.all()).toHaveLength(1);
  });

  it('fails closed on every way the answer can be wrong (the reason goes to the log, never the browser)', async () => {
    const cases: Array<[string, Respond]> = [
      ['http_status', () => ({ status: 502, xml: '' })],
      ['malformed', () => ({ xml: 'not xml' })],
      ['in_response_to_mismatch', ({ id }) => ({ xml: artifactResponse(id, '', { inResponseTo: '_other' }) })],
      ['issuer_mismatch', ({ id }) => ({ xml: artifactResponse(id, '', { issuer: 'https://evil.example.org' }) })],
      ['status_not_success', ({ id }) => ({ xml: artifactResponse(id, '', { status: 'urn:oasis:names:tc:SAML:2.0:status:Responder' }) })],
      ['no_response', ({ id }) => ({ xml: artifactResponse(id, '') })],
    ];
    for (const [reason, respond] of cases) {
      const { res, state } = await run(respond);
      expect(res.status, reason).toBe(400);
      expect(res.json.errors[0].message, reason).toBe('Could not verify that SAML sign-in.');
      expect(state.failure_reason, reason).toBe(reason);
    }
  });

  it('checks the Response inside: audience, recipient, destination, issuer, validity window', async () => {
    const cases: Array<[string, Record<string, string>]> = [
      ['audience_mismatch', { audience: 'https://someone.else/sp' }],
      ['recipient_mismatch', { recipient: 'https://evil.example.org/acs' }],
      ['destination_mismatch', { destination: 'https://evil.example.org/acs' }],
      ['issuer_mismatch', { issuer: 'https://evil.example.org' }],
      ['expired', { notOnOrAfter: new Date(Date.now() - 3_600_000).toISOString() }],
    ];
    for (const [reason, over] of cases) {
      const { res, state, e } = await run(({ id, conn, requestId }) => ({ xml: artifactResponse(id, responseXml(conn, requestId, over)) }));
      expect(res.status, reason).toBe(400);
      expect(state.failure_reason, reason).toBe(reason);
      expect(e.db.users.all(), reason).toHaveLength(0);
    }
  });
});

describe('configuration snapshots', () => {
  const setup = () => {
    const e = makeEngine();
    const call = client(e);
    e.singletons.set('/v1/instance/security', { mode: 'strict', api_key: 'sk_live_abcdefghijklmnop', nested: { webhook_secret: 'whsec_abcdefghijklmnop', keep: 1 } });
    return { e, call };
  };

  it('saves the configuration without a single secret, and lists, reads and deletes snapshots', async () => {
    const { e, call } = setup();
    const made = await call('POST', '/v1/instance/config_snapshots', { label: 'Before the change' });
    expect(made.status).toBe(201);
    expect(made.json).toMatchObject({ object: 'config_snapshot', version: 1, label: 'Before the change', source: 'manual' });
    expect(made.json.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(made.json.redacted_paths).toEqual(expect.arrayContaining(['settings./v1/instance/security.api_key', 'settings./v1/instance/security.nested.webhook_secret']));
    const full = (await call('GET', `/v1/instance/config_snapshots/${made.json.id}`)).json;
    expect(JSON.stringify(full)).not.toContain('sk_live_');
    expect(JSON.stringify(full)).not.toContain('whsec_');
    expect(full.auth_config.settings['/v1/instance/security']).toEqual({ mode: 'strict', nested: { keep: 1 } });
    expect((await call('POST', '/v1/instance/config_snapshots', { label: '' })).json.errors[0].param).toBe('label');
    expect((await call('POST', '/v1/instance/config_snapshots', { label: 'x'.repeat(121) })).status).toBe(400);
    await call('POST', '/v1/instance/config_snapshots', {});
    const list = (await call('GET', '/v1/instance/config_snapshots?limit=1')).json;
    expect(list).toMatchObject({ has_more: true });
    expect(list.data[0].version).toBe(2);
    expect(list.data[0].auth_config).toBeUndefined();
    expect((await call('GET', '/v1/instance/config_snapshots?source=weird')).status).toBe(400);
    expect((await call('GET', '/v1/instance/config_snapshots?source=manual')).json.data).toHaveLength(2);
    expect((await call('DELETE', `/v1/instance/config_snapshots/${made.json.id}`)).status).toBe(204);
    expect((await call('GET', `/v1/instance/config_snapshots/${made.json.id}`)).status).toBe(404);
    expect((await call('DELETE', `/v1/instance/config_snapshots/${made.json.id}`)).status).toBe(404);
    expect((await call('GET', '/v1/instance/config_snapshots')).json.data).toHaveLength(1);
    expect(e.singletons.get('/v1/instance/security')!.api_key).toBe('sk_live_abcdefghijklmnop');
    expect(events(e, 'config_snapshot.restored')).toHaveLength(0);
  });

  it('diffs two snapshots or one against now', async () => {
    const { call } = setup();
    const a = (await call('POST', '/v1/instance/config_snapshots', { label: 'a' })).json;
    expect((await call('GET', `/v1/instance/config_snapshots/diff?from=${a.id}`)).json).toMatchObject({ object: 'config_snapshot_diff', from: a.id, to: 'current', unchanged: true, changes: [] });
    await call('PUT', '/__emulator/compliance/config', { compliance: { cookieConsent: { enabled: true, policyVersion: 'v9' } }, localization: { requireReview: true } });
    const b = (await call('POST', '/v1/instance/config_snapshots', { label: 'b' })).json;
    const d = (await call('GET', `/v1/instance/config_snapshots/diff?from=${a.id}&to=${b.id}`)).json;
    expect(d.unchanged).toBe(false);
    expect(d.changes).toEqual(expect.arrayContaining([{ path: 'compliance.cookieConsent.enabled', before: false, after: true }, { path: 'compliance.cookieConsent.policyVersion', before: null, after: 'v9' }, { path: 'localization.requireReview', before: false, after: true }]));
    const now = (await call('GET', `/v1/instance/config_snapshots/diff?from=${a.id}&to=current`)).json;
    expect(now.changes).toHaveLength(d.changes.length);
    expect((await call('GET', '/v1/instance/config_snapshots/diff')).json.errors[0].param).toBe('from');
    expect((await call('GET', '/v1/instance/config_snapshots/diff?from=cfgs_missing')).status).toBe(404);
  });

  it('restores a snapshot: previews first, saves what it replaces, keeps today\'s secrets, and refuses a stale preview', async () => {
    const { e, call } = setup();
    const before = (await call('POST', '/v1/instance/config_snapshots', { label: 'good' })).json;
    await call('PUT', '/__emulator/compliance/config', { compliance: { cookieConsent: { enabled: true }, minors: { enabled: true } } });
    e.singletons.set('/v1/instance/security', { mode: 'lax', api_key: 'sk_live_rotated_value_123', extra: true });
    e.singletons.set('/v1/instance/hosted_pages', { theme: 'dark' });
    const restore = (body: Record<string, unknown>) => call('POST', `/v1/instance/config_snapshots/${before.id}/restore`, body);
    expect((await restore({ dry_run: 'yes' })).json.errors[0].param).toBe('dry_run');
    expect((await restore({ expected_sha256: 5 })).status).toBe(400);
    const preview = (await restore({ dry_run: true })).json;
    expect(preview).toMatchObject({ object: 'config_snapshot_restore', dry_run: true, applied: false, snapshot_id: before.id });
    expect(preview.changes.map((c: any) => c.path)).toEqual(expect.arrayContaining(['compliance.cookieConsent.enabled', 'compliance.minors.enabled', 'settings./v1/instance/security.mode']));
    expect(e.singletons.get('/v1/instance/security')!.mode).toBe('lax');
    // something changed after the preview: the restore is refused until it is previewed again
    await call('PUT', '/__emulator/compliance/config', { compliance: { cookieConsent: { policyVersion: 'v3' } } });
    expect((await restore({ expected_sha256: preview.current_sha256 })).status).toBe(409);
    const fresh = (await restore({ dry_run: true })).json;
    const done = await restore({ expected_sha256: fresh.current_sha256 });
    expect(done.json).toMatchObject({ applied: true, dry_run: false });
    const cfg = (await call('GET', '/__emulator/compliance/config')).json;
    expect(cfg.compliance.cookieConsent).toMatchObject({ enabled: false, policyVersion: null });
    expect(cfg.compliance.minors.enabled).toBe(false);
    expect(e.singletons.get('/v1/instance/security')).toEqual({ mode: 'strict', api_key: 'sk_live_rotated_value_123', nested: { keep: 1 } });
    expect(e.singletons.has('/v1/instance/hosted_pages')).toBe(false);
    // the state it replaced was saved first, so the restore can be undone the same way
    const pre = (await call('GET', '/v1/instance/config_snapshots?source=pre_restore')).json.data;
    expect(pre).toHaveLength(1);
    expect(pre[0].label).toBe(`Before restoring version ${before.version}`);
    const undo = (await call('POST', `/v1/instance/config_snapshots/${pre[0].id}/restore`, {})).json;
    expect(undo.applied).toBe(true);
    expect((await call('GET', '/__emulator/compliance/config')).json.compliance.cookieConsent.enabled).toBe(true);
    expect(events(e, 'config_snapshot.restored')).toHaveLength(2);
    expect((await call('GET', '/__emulator/compliance/audit?action=config_snapshot.restored')).json.data).toHaveLength(2);
    // restoring what is already in place changes nothing and writes no pre_restore snapshot
    const same = (await call('POST', '/v1/instance/config_snapshots', {})).json;
    const noop = (await call('POST', `/v1/instance/config_snapshots/${same.id}/restore`, {})).json;
    expect(noop).toMatchObject({ applied: true, changes: [] });
    expect((await call('GET', '/v1/instance/config_snapshots?source=pre_restore')).json.data).toHaveLength(2);
  });

  it('takes automatic snapshots at write time and from the worker pass, skipping unchanged state', async () => {
    const { call } = setup();
    expect((await call('POST', '/__emulator/config_snapshots/capture')).json.created).toBe(true);
    expect((await call('POST', '/__emulator/config_snapshots/capture')).json.created).toBe(false);
    await call('PUT', '/__emulator/compliance/config', { compliance: { dataRegion: 'eu' } });
    expect((await call('GET', '/v1/instance/config_snapshots?source=auto')).json.data).toHaveLength(2);
    await call('PUT', '/__emulator/compliance/config', { compliance: { dataRegion: 'eu' } });
    expect((await call('GET', '/v1/instance/config_snapshots?source=auto')).json.data).toHaveLength(2);
    expect((await call('GET', '/__emulator/compliance/audit?action=config_snapshot.created')).json.data).toHaveLength(0);
  });
});

describe('environment clones and previews', () => {
  const base = '/v1/platform/apps/app_demo/instances/ins_emulator/clones';
  const world = async () => {
    const e = makeEngine();
    const call = client(e);
    const ada = (await call('POST', '/v1/users', { email_address: 'ada@acme.test', first_name: 'Ada', username: 'ada', private_metadata: { ssn: '123-45-6789' }, public_metadata: { plan: 'pro' } })).json;
    const bob = (await call('POST', '/v1/users', { email_address: 'bob@acme.test', private_metadata: { note: 'vip' } })).json;
    const org = (await call('POST', '/v1/organizations', { name: 'Acme', private_metadata: { tier: 'secret-tier' } })).json;
    await call('POST', `/v1/organizations/${org.id}/memberships`, { user_id: ada.id, role: 'org:admin' });
    await call('POST', `/v1/organizations/${org.id}/memberships`, { user_id: bob.id, role: 'org:member' });
    e.singletons.set('/v1/instance/security', { mode: 'strict', signing_secret: 'whsec_abcdefghijklmnop' });
    return { e, call, ada, bob, org };
  };

  it('validates the request like the real route', async () => {
    const { call } = await world();
    expect((await call('POST', '/v1/platform/apps/app_demo/instances/ins_other/clones', { mode: 'clone', name: 'qa' })).status).toBe(404);
    const fail = async (body: Record<string, unknown>, param: string) => expect((await call('POST', base, body)).json.errors[0].param, JSON.stringify(body)).toBe(param);
    await fail({ mode: 'copy' }, 'mode');
    await fail({ mode: 'preview' }, 'ref');
    await fail({ mode: 'preview', ref: 'pr 1' }, 'ref');
    await fail({ mode: 'preview', ref: 'pr-1', name: 'x' }, 'name');
    await fail({ mode: 'clone', name: 'Bad Name' }, 'name');
    await fail({ mode: 'clone', name: 'preview-1' }, 'name');
    await fail({ mode: 'clone', name: 'qa', include: ['secrets'] }, 'include[0]');
    await fail({ mode: 'clone', name: 'qa', include: ['memberships'] }, 'include');
    await fail({ mode: 'clone', name: 'qa', ttl_hours: 5 }, 'ttl_hours');
    await fail({ mode: 'preview', ref: 'pr-1', ttl_hours: 0 }, 'ttl_hours');
    await fail({ mode: 'clone', name: 'qa', mask_emails: 'yes' }, 'mask_emails');
    await fail({ mode: 'clone', name: 'qa', secret_key_preset: 'root' }, 'secret_key_preset');
    await fail({ mode: 'clone', name: 'qa', allowed_origins: ['http://insecure.example.com'] }, 'allowed_origins');
    await fail({ mode: 'clone', name: 'qa', surprise: 1 }, 'surprise');
  });

  it('copies what was asked for and never the secrets, private metadata or real emails', async () => {
    const { e, call } = await world();
    const made = await call('POST', base, { mode: 'clone', name: 'qa-env', include: ['config', 'roles', 'organizations', 'users', 'memberships'], allowed_origins: ['https://qa.example.com/ignored/path'] });
    expect(made.status).toBe(201);
    expect(made.json).toMatchObject({ object: 'instance_clone', kind: 'clone', name: 'qa-env', status: 'completed', environment: 'development', source_instance_id: 'ins_emulator', mask_emails: true, allowed_origins: ['https://qa.example.com'], counts: { config: 1, roles: 0, organizations: 1, users: 2, memberships: 2 } });
    expect(made.json.secret).toMatch(/^sk_test_/);
    expect(made.json.secret_key_scopes).toContain('users:read');
    expect(made.json.publishable_key).toMatch(/^pk_test_/);
    expect(made.json.note).toContain('only a hash is stored');
    expect(made.json.instance_id).not.toBe('ins_emulator');
    // the secret is shown once
    const got = (await call('GET', `${base}/${made.json.id}`)).json;
    expect(got.secret).toBeUndefined();
    expect(JSON.stringify((await call('GET', base)).json)).not.toContain(made.json.secret);
    const data = (await call('GET', `/__emulator/clones/${made.json.id}/data`)).json;
    const dump = JSON.stringify(data);
    for (const leaked of ['ada@acme.test', 'bob@acme.test', '123-45-6789', 'secret-tier', 'whsec_', 'vip', made.json.secret]) expect(dump, leaked).not.toContain(leaked);
    expect(data.users).toHaveLength(2);
    expect(data.users[0].email_addresses[0].email).toMatch(/^user-[0-9a-f]{16}@example\.com$/);
    expect(data.users.every((u: any) => u.username === null && u.private_metadata && Object.keys(u.private_metadata).length === 0 && u.has_password === false)).toBe(true);
    expect(data.users.find((u: any) => u.first_name === 'Ada').public_metadata).toEqual({ plan: 'pro' });
    expect(data.organizations[0].private_metadata).toBeUndefined();
    expect(data.memberships).toHaveLength(2);
    expect(data.config.settings['/v1/instance/security']).toEqual({ mode: 'strict' });
    expect(events(e, 'instance_clone.created')).toHaveLength(1);
    expect((await call('GET', '/__emulator/compliance/audit?action=app.instance_cloned')).json.data).toHaveLength(1);
    // a name is one environment
    expect((await call('POST', base, { mode: 'clone', name: 'qa-env' })).status).toBe(409);
    // unmasked emails only when asked
    const kept = (await call('POST', base, { mode: 'clone', name: 'keep-env', include: ['users'], mask_emails: false })).json;
    const keptData = (await call('GET', `/__emulator/clones/${kept.id}/data`)).json;
    expect(keptData.users.map((u: any) => u.email_addresses[0].email).sort()).toEqual(['ada@acme.test', 'bob@acme.test']);
    expect(JSON.stringify(keptData)).not.toContain('123-45-6789');
    // the default is configuration and roles only
    const light = (await call('POST', base, { mode: 'clone', name: 'light' })).json;
    expect(light.include).toEqual(['config', 'roles']);
    expect((await call('GET', `/__emulator/clones/${light.id}/data`)).json.users).toBeUndefined();
  });

  it('a preview is one per ref, expires on its own, and can be refreshed', async () => {
    const { e, call } = await world();
    const p = await call('POST', base, { mode: 'preview', ref: 'pr-12', ttl_hours: 2 });
    expect(p.status).toBe(201);
    expect(p.json).toMatchObject({ kind: 'preview', ref: 'pr-12', name: 'preview-pr-12' });
    expect(p.json.expires_at - e.clock.now()).toBeGreaterThan(1.9 * 3_600_000);
    const again = await call('POST', base, { mode: 'preview', ref: 'pr-12' });
    expect(again.status).toBe(200);
    expect(again.json).toMatchObject({ id: p.json.id, replayed: true });
    expect(again.json.secret).toBeUndefined();
    expect((await call('POST', base, { mode: 'clone', name: 'other', ref: 'pr-12' })).status).toBe(409);
    expect((await call('GET', `${base}?kind=clone`)).json.data).toHaveLength(0);
    expect((await call('GET', `${base}?kind=weird`)).status).toBe(400);
    // refresh re-applies the configuration and restarts the clock
    await call('PUT', '/__emulator/compliance/config', { compliance: { dataRegion: 'eu' } });
    await call('POST', '/__emulator/time/advance', { ms: 3_600_000 });
    const refreshed = (await call('POST', base, { mode: 'preview', ref: 'pr-12', ttl_hours: 5, refresh: true })).json;
    expect(refreshed.expires_at - e.clock.now()).toBeGreaterThan(4.9 * 3_600_000);
    expect((await call('GET', `/__emulator/clones/${p.json.id}/data`)).json.config.compliance.dataRegion).toBe('eu');
    // the worker pass deletes it once its time is up
    await call('POST', '/__emulator/time/advance', { ms: 6 * 3_600_000 });
    const sweep = (await call('POST', '/__emulator/clones/sweep')).json;
    expect(sweep.expired).toEqual([p.json.id]);
    expect(events(e, 'instance_clone.expired')).toHaveLength(1);
    const gone = (await call('GET', `${base}/${p.json.id}`)).json;
    expect(gone).toMatchObject({ status: 'deleted' });
    expect(gone.deleted_at).toBeTruthy();
    expect((await call('GET', `/__emulator/clones/${p.json.id}/data`)).json.users).toBeUndefined();
    // the ref is free again
    expect((await call('POST', base, { mode: 'preview', ref: 'pr-12' })).status).toBe(201);
  });

  it('deleting removes the clone and its data', async () => {
    const { e, call } = await world();
    const c = (await call('POST', base, { mode: 'clone', name: 'temp', include: ['users'] })).json;
    const del = await call('DELETE', `${base}/${c.id}`);
    expect(del.json).toMatchObject({ status: 'deleted' });
    expect(events(e, 'instance_clone.deleted')).toHaveLength(1);
    expect((await call('DELETE', `${base}/${c.id}`)).status).toBe(404);
    expect((await call('GET', `${base}/clone_missing`)).status).toBe(404);
    expect((await call('GET', `/__emulator/clones/${c.id}/data`)).json.users).toBeUndefined();
    expect((await call('POST', base, { mode: 'clone', name: 'temp' })).status).toBe(201); // the name is free again
  });

  it('copies a big section in batches and reports progress; a copy that goes quiet fails', async () => {
    const { e, call } = await world();
    for (let i = 0; i < 2100; i++) e.db.users.insert({ emails: [{ id: `idn_${i}`, email_address: `bulk${i}@acme.test`, verified: true }], created_at: e.clock.now() } as any);
    const made = await call('POST', base, { mode: 'clone', name: 'big', include: ['users'] });
    expect(made.status).toBe(202);
    expect(made.json).toMatchObject({ status: 'copying', progress: { sections: { users: { total: 2102, copied: 0 } } } });
    expect(made.json.secret).toMatch(/^sk_test_/);
    expect((await call('GET', `${base}/${made.json.id}`)).json.progress.sections.users).toEqual({ total: 2102, copied: 1000 });
    expect((await call('GET', `${base}/${made.json.id}`)).json.progress.sections.users.copied).toBe(2000);
    const finished = (await call('GET', `${base}/${made.json.id}`)).json;
    expect(finished).toMatchObject({ status: 'completed', counts: { users: 2102 } });
    expect(finished.progress.sections.users.copied).toBe(2102);
    // advance runs the rest at once
    const second = (await call('POST', base, { mode: 'clone', name: 'big-two', include: ['users'] })).json;
    expect((await call('POST', `/__emulator/clones/${second.id}/advance`)).json.status).toBe('completed');
    // a copy nobody moves for 15 minutes fails and says what to do
    const third = (await call('POST', base, { mode: 'clone', name: 'big-three', include: ['users'] })).json;
    await call('POST', '/__emulator/time/advance', { ms: 16 * 60_000 });
    expect((await call('POST', '/__emulator/clones/sweep')).json.failed).toEqual([third.id]);
    const failed = (await call('GET', `${base}/${third.id}`)).json;
    expect(failed).toMatchObject({ status: 'failed', instance_id: null });
    expect(failed.errors[0]).toMatchObject({ code: 'copy_interrupted' });
  });
});
