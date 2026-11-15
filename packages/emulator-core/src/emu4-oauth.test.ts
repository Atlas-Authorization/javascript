/* eslint-disable @typescript-eslint/no-explicit-any */
import { constants, createCipheriv, createHash, createHmac, createPublicKey, diffieHellman, generateKeyPairSync, publicEncrypt, randomBytes, randomUUID, sign as nodeSign, type KeyObject } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { pkceChallenge } from './crypto-util';
import { client, makeEngine } from './test-support';
import type { Engine } from './engine';
import { fullParityRequests, uncoveredRoutes } from './parity-routes';

const CB = 'https://app.example/callback';
const DAY = 86_400_000;
const EXCHANGE = 'urn:ietf:params:oauth:grant-type:token-exchange';
const CIBA = 'urn:openid:params:grant-type:ciba';
const ASSERTION = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';
const b64 = (v: string | Buffer): string => Buffer.from(v).toString('base64url');
const nowS = () => Math.floor(Date.now() / 1000);
const verifier = 'v'.repeat(48);

const ec = () => {
  const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return { ...pair, jwk: pair.publicKey.export({ format: 'jwk' }) as Record<string, string> };
};
const es256 = (key: KeyObject, header: Record<string, unknown>, payload: Record<string, unknown>): string => {
  const input = `${b64(JSON.stringify(header))}.${b64(JSON.stringify(payload))}`;
  return `${input}.${b64(nodeSign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' }))}`;
};
const decode = (jwt: string): { header: any; payload: any } => ({ header: JSON.parse(Buffer.from(jwt.split('.')[0]!, 'base64url').toString()), payload: JSON.parse(Buffer.from(jwt.split('.')[1]!, 'base64url').toString()) });

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
const qs = (loc: string | null) => new URL(loc!).searchParams;
const frag = (loc: string | null) => new URLSearchParams(new URL(loc!).hash.slice(1));
const anon = (e: Engine) => client(e, null);

const setup = async (clientBody: Record<string, unknown> = {}, engineOptions: Parameters<typeof makeEngine>[0] = {}) => {
  const e = makeEngine(engineOptions);
  const call = client(e);
  const post = form(e);
  const user = (await call('POST', '/v1/users', { email_address: 'ada@example.com', first_name: 'Ada', password: 'Correct-horse-9-battery' })).json;
  const c = (await call('POST', '/v1/oauth_clients', { name: 'App', redirect_uris: [CB], grant_types: ['authorization_code', 'refresh_token'], allowed_scopes: ['openid', 'email', 'profile', 'offline_access', 'read'], token_endpoint_auth_method: 'client_secret_post', ...clientBody })).json;
  const creds = { client_id: c.client_id, client_secret: c.client_secret };
  return { e, call, post, user, c, creds };
};
const login = async (s: { e: Engine; post: ReturnType<typeof form> }, c: any, userId: string, scope = 'openid offline_access', extra: Record<string, string> = {}) => {
  const a = await authz(s.e, { client_id: c.client_id, redirect_uri: c.redirect_uris?.[0] ?? CB, response_type: 'code', scope, login_hint: userId, nonce: 'n', code_challenge: await pkceChallenge(verifier), code_challenge_method: 'S256', ...extra });
  const code = qs(a.location).get('code')!;
  return s.post('/oauth2/token', { grant_type: 'authorization_code', code, redirect_uri: c.redirect_uris?.[0] ?? CB, client_id: c.client_id, client_secret: c.client_secret, code_verifier: verifier });
};
const advance = (e: Engine, ms: number) => anon(e)('POST', '/__emulator/time/advance', { ms });
const eventTypes = (e: Engine) => e.webhooks.events.map((x) => x.type);
const jwksOf = async (e: Engine): Promise<any> => (await raw(e, 'GET', '/.well-known/jwks.json')).json;
const headerOf = (jwt: string) => decode(jwt).header;

// ── signing algorithms, staged rotation and the schedule ─────────────

describe('signing algorithms and key rotation', () => {
  it('signs and verifies with every algorithm an instance may choose; the JWKS reflects it', async () => {
    const e = makeEngine();
    const call = client(e);
    const u = (await call('POST', '/v1/users', { email_address: 'a@example.com' })).json;
    for (const alg of ['ES384', 'PS256', 'EdDSA', 'ES256', 'RS256']) {
      const rot = await call('POST', '/v1/instance/signing_keys/rotate', { alg, emergency: true });
      expect(rot.status).toBe(201);
      expect(rot.json).toMatchObject({ object: 'signing_key_rotation', alg, emergency: true, previous_retires_at: null, provider: 'local' });
      const s = (await call('POST', '/v1/sessions', { user_id: u.id })).json;
      expect(headerOf(s.jwt)).toMatchObject({ alg, kid: rot.json.kid });
      expect(((await e.tokens.verifyAny(s.jwt)) as any).ok).toBe(true);
      // an emergency rotation publishes only the new key
      expect((await jwksOf(e)).keys.map((k: any) => [k.kid, k.alg])).toEqual([[rot.json.kid, alg]]);
    }
    expect((await call('POST', '/v1/instance/signing_keys/rotate', { alg: 'HS256' })).json.errors[0]).toMatchObject({ code: 'VALIDATION_FAILED', param: 'alg' });
    expect((await call('POST', '/v1/instance/signing_keys/rotate', { key: 'main' })).status).toBe(400);
  });

  it('keeps the previous key published for the grace period, refuses a second rotation inside it, then retires it', async () => {
    const e = makeEngine();
    const call = client(e);
    const u = (await call('POST', '/v1/users', { email_address: 'a@example.com' })).json;
    const before = (await call('POST', '/v1/sessions', { user_id: u.id })).json;
    const rot = (await call('POST', '/v1/instance/signing_keys/rotate', { alg: 'ES384' })).json;
    expect(rot.previous_retires_at).toBeGreaterThan(Date.now() + DAY - 60_000);
    expect((await jwksOf(e)).keys).toHaveLength(2);
    expect(((await e.tokens.verifyAny(before.jwt)) as any).ok).toBe(true);
    const again = await call('POST', '/v1/instance/signing_keys/rotate', {});
    expect(again.status).toBe(409);
    expect(again.json.errors[0].message).toContain('The previous key is still published until');
    expect((await call('POST', '/v1/instance/signing_keys/rotate', { emergency: true })).status).toBe(201);
    expect((await jwksOf(e)).keys).toHaveLength(1);
    // a short grace retires on the clock
    const g = await call('POST', '/v1/instance/signing_keys/rotate', { grace_period_seconds: 60, alg: 'PS256' });
    expect(g.status).toBe(201);
    expect((await call('GET', '/v1/instance/signing_keys')).json.data.map((k: any) => k.status)).toEqual(['current', 'previous']);
    await advance(e, 61_000);
    expect((await call('GET', '/v1/instance/signing_keys')).json.data.map((k: any) => k.status)).toEqual(['current']);
    expect(((await e.tokens.verifyAny(before.jwt)) as any).ok).toBe(false);
  });

  it('stages a key: published now, signing at activates_at, previous kept 24 hours after; cancel and the policy work', async () => {
    const e = makeEngine();
    const call = client(e);
    const u = (await call('POST', '/v1/users', { email_address: 'a@example.com' })).json;
    const first = (await call('POST', '/v1/sessions', { user_id: u.id })).json;
    const staged = await call('POST', '/v1/instance/signing_keys/rotate', { staged: true, alg: 'ES384' });
    expect(staged.status).toBe(201);
    expect(staged.json).toMatchObject({ staged: true, alg: 'ES384', emergency: false });
    expect(staged.json.activates_at).toBeGreaterThan(Date.now() + 13 * DAY);
    const keys = (await call('GET', '/v1/instance/signing_keys')).json.data;
    expect(keys.map((k: any) => k.status)).toEqual(['next', 'current']);
    expect(keys[0]).toMatchObject({ kid: staged.json.kid, activates_at: staged.json.activates_at });
    expect((await jwksOf(e)).keys.map((k: any) => k.kid)).toContain(staged.json.kid);
    // still signing with the old key
    expect(headerOf((await call('POST', '/v1/sessions', { user_id: u.id })).json.jwt).kid).toBe(first.jwt && headerOf(first.jwt).kid);
    // one staged key at a time; an ordinary rotation waits for it
    expect((await call('POST', '/v1/instance/signing_keys/rotate', { staged: true })).status).toBe(409);
    expect((await call('POST', '/v1/instance/signing_keys/rotate', {})).status).toBe(409);
    expect((await call('POST', '/v1/instance/signing_keys/rotate', { staged: true, grace_period_seconds: 10 })).status).toBe(400);
    expect((await call('POST', '/v1/instance/signing_keys/rotate', { staged: true, emergency: true })).status).toBe(400);
    expect((await call('POST', '/v1/instance/signing_keys/rotate', { staged: true, activates_at: Date.now() + 60_000 })).json.errors[0].param).toBe('activates_at');
    await advance(e, 14 * DAY + 1000);
    expect(eventTypes(e)).toContain('signing_key.staged');
    expect(eventTypes(e)).toContain('signing_key.activated');
    const after = (await call('POST', '/v1/sessions', { user_id: u.id })).json;
    expect(headerOf(after.jwt)).toMatchObject({ alg: 'ES384', kid: staged.json.kid });
    const now = (await call('GET', '/v1/instance/signing_keys')).json.data;
    expect(now.map((k: any) => k.status)).toEqual(['current', 'previous']);
    expect(now[1].retires_at).toBeGreaterThan(Date.now() + 22 * 3_600_000);
    await advance(e, DAY + 1000);
    expect((await jwksOf(e)).keys.map((k: any) => k.kid)).toEqual([staged.json.kid]);
    expect(((await e.tokens.verifyAny(first.jwt)) as any).reason).toBe('unknown_key');
    expect(((await anon(e)('GET', '/__emulator/oauth/audit?action=signing_key.activated')).json.data as any[]).length).toBe(1);

    // cancel
    const next = await call('POST', '/v1/instance/signing_keys/rotate', { staged: true, activates_at: e.clock.now() + 2 * DAY });
    expect(next.status).toBe(201);
    const gone = await call('DELETE', '/v1/instance/signing_keys/next');
    expect(gone.json).toMatchObject({ object: 'signing_key', kid: next.json.kid, status: 'next', deleted: true });
    expect((await jwksOf(e)).keys.map((k: any) => k.kid)).not.toContain(next.json.kid);
    expect((await call('DELETE', '/v1/instance/signing_keys/next')).status).toBe(404);

    // the pre-publish policy stages ordinary rotations
    expect((await call('GET', '/v1/instance/signing_key_policy')).json).toEqual({ object: 'signing_key_policy', prepublish_days: null });
    expect((await call('PATCH', '/v1/instance/signing_key_policy', { prepublish_days: 400 })).status).toBe(400);
    expect((await call('PATCH', '/v1/instance/signing_key_policy', { prepublish_days: 3 })).json.prepublish_days).toBe(3);
    const viaPolicy = (await call('POST', '/v1/instance/signing_keys/rotate', {})).json;
    expect(viaPolicy.staged).toBe(true);
    expect(viaPolicy.activates_at).toBeLessThan(e.clock.now() + 4 * DAY);
  });

  it('rotates on a schedule: stages a key prepublish_hours ahead, activates it, keeps the previous key through the grace', async () => {
    const e = makeEngine();
    const call = client(e);
    const u = (await call('POST', '/v1/users', { email_address: 'a@example.com' })).json;
    expect((await call('GET', '/v1/instance/signing_key_schedule')).json).toMatchObject({ object: 'signing_key_schedule', enabled: false, interval_days: null });
    expect((await call('PUT', '/v1/instance/signing_key_schedule', { interval_days: 0 })).json.errors[0].param).toBe('interval_days');
    expect((await call('PUT', '/v1/instance/signing_key_schedule', { interval_days: 1, prepublish_hours: 24 })).json.errors[0].message).toContain('interval_days is too short');
    expect((await call('PUT', '/v1/instance/signing_key_schedule', { interval_days: 30, alg: 'HS256' })).json.errors[0].param).toBe('alg');
    expect((await call('PUT', '/v1/instance/signing_key_schedule', { interval_days: 30, grace_period_seconds: 60 })).json.errors[0].param).toBe('grace_period_seconds');
    const put = await call('PUT', '/v1/instance/signing_key_schedule', { interval_days: 30, alg: 'EdDSA', prepublish_hours: 24 });
    expect(put.status).toBe(200);
    expect(put.json).toMatchObject({ enabled: true, interval_days: 30, alg: 'EdDSA', prepublish_hours: 24, effective_grace_seconds: 86_400, last_rotated_at: null });
    expect(put.json.next_rotation_at).toBeGreaterThan(Date.now() + 29 * DAY);
    const old = headerOf((await call('POST', '/v1/sessions', { user_id: u.id })).json.jwt);
    await advance(e, 30 * DAY + 1000);
    const sched = (await call('GET', '/v1/instance/signing_key_schedule')).json;
    expect(sched.last_rotated_at).toBeGreaterThan(0);
    expect(sched.next_rotation_at).toBeGreaterThan(Date.now() + 29 * DAY);
    const staged = e.webhooks.events.find((x) => x.type === 'signing_key.staged')!;
    expect(staged.payload.data).toMatchObject({ alg: 'EdDSA', trigger: 'schedule' });
    expect((await jwksOf(e)).keys).toHaveLength(2);
    // still the old key until the new one is due, then EdDSA signs
    expect(headerOf((await call('POST', '/v1/sessions', { user_id: u.id })).json.jwt).kid).toBe(old.kid);
    await advance(e, 24 * 3_600_000 + 1000);
    expect(headerOf((await call('POST', '/v1/sessions', { user_id: u.id })).json.jwt).alg).toBe('EdDSA');
    const rows = ((await anon(e)('GET', '/__emulator/oauth/audit')).json.data as any[]).map((r) => [r.action, r.actor_type]);
    expect(rows).toEqual(expect.arrayContaining([['signing_key_schedule.set', 'api_key'], ['signing_key.staged', 'system'], ['signing_key.activated', 'system']]));
    expect((await call('DELETE', '/v1/instance/signing_key_schedule')).json).toEqual({ object: 'signing_key_schedule', enabled: false, deleted: true });
    expect((await call('DELETE', '/v1/instance/signing_key_schedule')).status).toBe(404);
  });
});

// ── encrypted request objects ────────────────────────────────────────

const u32 = (n: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};
const lp = (b: Buffer): Buffer => Buffer.concat([u32(b.length), b]);
const concatKdf = (z: Buffer, algId: string, bits: number): Buffer => createHash('sha256').update(Buffer.concat([u32(1), z, lp(Buffer.from(algId)), lp(Buffer.alloc(0)), lp(Buffer.alloc(0)), u32(bits)])).digest().subarray(0, bits / 8);
const encryptContent = (header: Record<string, unknown>, cek: Buffer, plaintext: string): { h: string; iv: Buffer; ct: Buffer; tag: Buffer } => {
  const h = b64(JSON.stringify(header));
  if (String(header.enc).endsWith('GCM')) {
    const iv = randomBytes(12);
    const c = createCipheriv(`aes-${cek.length * 8}-gcm` as 'aes-128-gcm', cek, iv);
    c.setAAD(Buffer.from(h));
    const ct = Buffer.concat([c.update(plaintext), c.final()]);
    return { h, iv, ct, tag: c.getAuthTag() };
  }
  // A128CBC-HS256: the first half of the key is the MAC key
  const iv = randomBytes(16);
  const c = createCipheriv('aes-128-cbc', cek.subarray(16), iv);
  const ct = Buffer.concat([c.update(plaintext), c.final()]);
  const al = Buffer.alloc(8);
  al.writeUInt32BE(h.length * 8, 4);
  const tag = createHmac('sha256', cek.subarray(0, 16)).update(Buffer.concat([Buffer.from(h), iv, ct, al])).digest().subarray(0, 16);
  return { h, iv, ct, tag };
};
const KEY_BYTES: Record<string, number> = { A128GCM: 16, A256GCM: 32, 'A128CBC-HS256': 32 };
const jweRsa = (plaintext: string, jwk: any, enc: string): string => {
  const cek = randomBytes(KEY_BYTES[enc]!);
  const ek = publicEncrypt({ key: createPublicKey({ key: jwk, format: 'jwk' }), padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, cek);
  const { h, iv, ct, tag } = encryptContent({ alg: 'RSA-OAEP-256', enc, kid: jwk.kid }, cek, plaintext);
  return [h, b64(ek), b64(iv), b64(ct), b64(tag)].join('.');
};
const jweEcdh = (plaintext: string, jwk: any, enc: string): string => {
  const eph = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const epk = eph.publicKey.export({ format: 'jwk' }) as any;
  const z = diffieHellman({ privateKey: eph.privateKey, publicKey: createPublicKey({ key: jwk, format: 'jwk' }) });
  const cek = concatKdf(z, enc, KEY_BYTES[enc]! * 8);
  const { h, iv, ct, tag } = encryptContent({ alg: 'ECDH-ES', enc, kid: jwk.kid, epk: { kty: epk.kty, crv: epk.crv, x: epk.x, y: epk.y } }, cek, plaintext);
  return [h, '', b64(iv), b64(ct), b64(tag)].join('.');
};

describe('encrypted request objects', () => {
  const key = ec();
  const jwks = { keys: [{ ...key.jwk, kid: 'k1', alg: 'ES256', use: 'sig' }] };
  const signed = (e: Engine, c: any, claims: Record<string, unknown> = {}) => es256(key.privateKey, { alg: 'ES256', kid: 'k1' }, { iss: c.client_id, aud: e.issuer, client_id: c.client_id, iat: nowS(), exp: nowS() + 300, response_type: 'code', redirect_uri: CB, scope: 'openid', nonce: 'n', ...claims });

  it('publishes the encryption key once a client registers for it, and decrypts RSA-OAEP-256 and ECDH-ES requests', async () => {
    const { e, call, user } = await setup({ jwks });
    expect((await jwksOf(e)).keys.every((k: any) => k.use !== 'enc')).toBe(true);
    const rsa = (await call('POST', '/v1/oauth_clients', { name: 'Enc', redirect_uris: [CB], token_endpoint_auth_method: 'client_secret_post', jwks, request_object_encryption_alg: 'RSA-OAEP-256' })).json;
    expect(rsa).toMatchObject({ request_object_encryption_alg: 'RSA-OAEP-256', request_object_encryption_enc: 'A128CBC-HS256' });
    const ecdh = (await call('POST', '/v1/oauth_clients', { name: 'Enc2', redirect_uris: [CB], token_endpoint_auth_method: 'client_secret_post', jwks, request_object_encryption_alg: 'ECDH-ES', request_object_encryption_enc: 'A128GCM' })).json;
    const published = (await jwksOf(e)).keys.filter((k: any) => k.use === 'enc');
    expect(published.map((k: any) => k.alg).sort()).toEqual(['ECDH-ES', 'RSA-OAEP-256']);
    const rsaKey = published.find((k: any) => k.alg === 'RSA-OAEP-256');
    const ecKey = published.find((k: any) => k.alg === 'ECDH-ES');
    for (const enc of ['A256GCM', 'A128GCM', 'A128CBC-HS256']) {
      const ok = await authz(e, { client_id: rsa.client_id, login_hint: user.id, request: jweRsa(signed(e, rsa, { state: `rsa-${enc}` }), rsaKey, enc) });
      expect(ok.status).toBe(302);
      expect(qs(ok.location).get('state')).toBe(`rsa-${enc}`);
      expect(qs(ok.location).get('code')).toBeTruthy();
    }
    const viaEc = await authz(e, { client_id: ecdh.client_id, login_hint: user.id, request: jweEcdh(signed(e, ecdh, { state: 'ec' }), ecKey, 'A128GCM') });
    expect(qs(viaEc.location).get('state')).toBe('ec');
    expect(qs(viaEc.location).get('code')).toBeTruthy();
    // the nested request object is still verified: signed by someone else
    const forged = es256(ec().privateKey, { alg: 'ES256', kid: 'k1' }, { iss: rsa.client_id, aud: e.issuer, client_id: rsa.client_id, response_type: 'code', redirect_uri: CB, scope: 'openid' });
    expect((await authz(e, { client_id: rsa.client_id, login_hint: user.id, request: jweRsa(forged, rsaKey, 'A128GCM') })).json).toMatchObject({ error: 'invalid_request_object', error_description: 'The signed request object is invalid.' });
  });

  it('refuses a tampered, unreadable or unencrypted request object from a client that registered encryption', async () => {
    const { e, call, user } = await setup();
    const c = (await call('POST', '/v1/oauth_clients', { name: 'Enc', redirect_uris: [CB], token_endpoint_auth_method: 'client_secret_post', jwks, request_object_encryption_alg: 'RSA-OAEP-256' })).json;
    const rsaKey = (await jwksOf(e)).keys.find((k: any) => k.use === 'enc');
    const good = jweRsa(signed(e, c), rsaKey, 'A128GCM');
    const parts = good.split('.');
    const tamper = [...parts.slice(0, 4), `${parts[4]!.slice(0, -2)}AA`].join('.');
    expect((await authz(e, { client_id: c.client_id, login_hint: user.id, request: tamper })).json).toMatchObject({ error: 'invalid_request_object', error_description: 'The encrypted request object could not be decrypted.' });
    expect((await authz(e, { client_id: c.client_id, login_hint: user.id, request: 'a.b.c.d.e' })).json.error_description).toBe('The encrypted request object could not be decrypted.');
    // addressed to a key the emulator does not hold
    const other = (await call('POST', '/v1/oauth_clients', { name: 'Plain', redirect_uris: [CB] })).json;
    expect(other.request_object_encryption_alg).toBeUndefined();
    expect((await authz(e, { client_id: c.client_id, login_hint: user.id, request: signed(e, c) })).json).toMatchObject({ error: 'invalid_request_object', error_description: 'This client registered request object encryption; the request object must be encrypted.' });
    expect((await call('POST', '/v1/oauth_clients', { name: 'Bad', redirect_uris: [CB], request_object_encryption_alg: 'dir' })).status).toBe(400);
    expect((await call('POST', '/v1/oauth_clients', { name: 'Bad', redirect_uris: [CB], request_object_encryption_alg: 'RSA-OAEP-256', request_object_encryption_enc: 'A192GCM' })).status).toBe(400);
  });
});

// ── private_key_jwt ──────────────────────────────────────────────────

describe('private_key_jwt client authentication', () => {
  const key = ec();
  const jwks = { keys: [{ ...key.jwk, kid: 'k1', alg: 'ES256', use: 'sig' }] };
  const keyed = async (clientBody: Record<string, unknown> = {}, engineOptions: Parameters<typeof makeEngine>[0] = {}) => {
    const s = await setup({ token_endpoint_auth_method: 'private_key_jwt', grant_types: ['client_credentials', 'authorization_code'], jwks, ...clientBody }, engineOptions);
    const assertion = (claims: Record<string, unknown> = {}, signer: KeyObject = key.privateKey) => es256(signer, { alg: 'ES256', kid: 'k1' }, { iss: s.c.client_id, sub: s.c.client_id, aud: `${s.e.issuer}/oauth2/token`, jti: randomUUID(), exp: nowS() + 60, ...claims });
    const token = (extra: Record<string, string> = {}) => s.post('/oauth2/token', { grant_type: 'client_credentials', client_assertion_type: ASSERTION, client_assertion: assertion(), ...extra });
    return { ...s, assertion, token };
  };

  it('creates a keyless-secret client that authenticates with a signed assertion, once per jti', async () => {
    const { c, token, assertion, post, e } = await keyed();
    expect(c.client_secret).toBeUndefined();
    expect(c.token_endpoint_auth_method).toBe('private_key_jwt');
    // the client is found by the assertion's iss when no client_id is sent
    const ok = await token();
    expect(ok.status).toBe(200);
    expect(((await e.tokens.verifyAny(ok.json.access_token)) as any).claims.client_id).toBe(c.client_id);
    const a = assertion();
    expect((await post('/oauth2/token', { grant_type: 'client_credentials', client_assertion_type: ASSERTION, client_assertion: a })).status).toBe(200);
    const replay = await post('/oauth2/token', { grant_type: 'client_credentials', client_assertion_type: ASSERTION, client_assertion: a });
    expect(replay.status).toBe(401);
    expect(replay.json).toMatchObject({ error: 'invalid_client', error_description: 'The client assertion has already been used.' });
    // the replay guard is per jti: a fresh assertion works
    expect((await token()).status).toBe(200);
    // introspection and revocation take the same authentication
    const intro = await post('/oauth2/introspect', { token: ok.json.access_token, client_assertion_type: ASSERTION, client_assertion: assertion() });
    expect(intro.json.active).toBe(true);
    const doc = (await (await e.handle(new Request('http://x/.well-known/openid-configuration'))).json()) as any;
    expect(doc.token_endpoint_auth_methods_supported).toContain('private_key_jwt');
    expect(doc.token_endpoint_auth_signing_alg_values_supported).toContain('ES256');
  });

  it('refuses a bad assertion with the real invalid_client descriptions', async () => {
    const { assertion, post, e, creds } = await keyed();
    const send = (client_assertion: string, extra: Record<string, string> = {}) => post('/oauth2/token', { grant_type: 'client_credentials', client_assertion_type: ASSERTION, client_assertion, ...extra });
    const why = async (r: Promise<{ status: number; json: any }>) => {
      const x = await r;
      expect(x.status).toBe(401);
      expect(x.json.error).toBe('invalid_client');
      return x.json.error_description;
    };
    expect(await why(send(assertion({}, ec().privateKey)))).toBe('The client assertion signature is invalid or expired.');
    expect(await why(send(assertion({ exp: nowS() - 600 })))).toBe('The client assertion signature is invalid or expired.');
    expect(await why(send(assertion({ sub: 'someone-else' })))).toBe('The client assertion iss and sub must equal the client_id.');
    expect(await why(send(assertion({ aud: 'https://other.example/token' })))).toBe('The client assertion audience does not match this endpoint.');
    expect(await why(send(assertion({ jti: undefined })))).toBe('The client assertion must carry a jti.');
    expect(await why(send(assertion({ exp: undefined })))).toBe('The client assertion must carry an exp.');
    expect(await why(post('/oauth2/token', { grant_type: 'client_credentials', client_id: creds.client_id }))).toBe('This client must authenticate with a private_key_jwt client assertion.');
    expect(await why(send(assertion(), { client_secret: 'oacs_guess' }))).toBe('This client must authenticate with a private_key_jwt client assertion.');
    expect(await why(post('/oauth2/token', { grant_type: 'client_credentials', client_assertion_type: 'urn:other', client_assertion: assertion() }))).toBe('This client must authenticate with a private_key_jwt client assertion.');
    // an assertion naming an unknown client
    const ghost = es256(key.privateKey, { alg: 'ES256', kid: 'k1' }, { iss: 'client_nobody', sub: 'client_nobody', aud: e.issuer, jti: 'x', exp: nowS() + 60 });
    expect(await why(send(ghost))).toBe('Unknown client.');
  });

  it('reads the keys from jwks_uri, and a keyed method needs keys', async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify(jwks), { status: 200, headers: { 'content-type': 'application/json' } }));
    const s = await keyed({ jwks: undefined, jwks_uri: 'https://rp.example/jwks.json' }, { fetch: fetchSpy as unknown as typeof fetch });
    expect((await s.token()).status).toBe(200);
    expect(fetchSpy).toHaveBeenCalled();
    const call = client(s.e);
    const bare = await call('POST', '/v1/oauth_clients', { name: 'Bare', redirect_uris: [CB], token_endpoint_auth_method: 'private_key_jwt' });
    expect(bare.status).toBe(400);
    expect(bare.json.errors[0].message).toBe('private_key_jwt needs jwks or jwks_uri.');
    expect((await call('PATCH', `/v1/oauth_clients/${s.c.client_id}`, { jwks_uri: null })).status).toBe(400);
    expect((await call('POST', '/v1/oauth_clients', { name: 'Odd', redirect_uris: [CB], token_endpoint_auth_method: 'client_secret_jwt' })).status).toBe(400);
  });

  it('is accepted by dynamic registration, which then issues no secret', async () => {
    const e = makeEngine();
    await anon(e)('POST', '/__emulator/oauth/config', { dynamic_registration: true });
    const reg = (body: Record<string, unknown>) => raw(e, 'POST', '/oauth2/register', {}, { redirect_uris: [CB], ...body });
    const made = await reg({ token_endpoint_auth_method: 'private_key_jwt', jwks, client_name: 'Dyn' });
    expect(made.status).toBe(201);
    expect(made.json).toMatchObject({ token_endpoint_auth_method: 'private_key_jwt' });
    expect(made.json.client_secret).toBeUndefined();
    const a = es256(key.privateKey, { alg: 'ES256', kid: 'k1' }, { iss: made.json.client_id, sub: made.json.client_id, aud: `${e.issuer}/oauth2/token`, jti: 'j1', exp: nowS() + 60 });
    // authenticated by the assertion (not invalid_client), then refused the grant a dynamic client was not registered for
    expect((await form(e)('/oauth2/token', { grant_type: 'client_credentials', client_assertion_type: ASSERTION, client_assertion: a })).json.error).toBe('unauthorized_client');
    const none = await reg({ token_endpoint_auth_method: 'private_key_jwt' });
    expect(none.status).toBe(400);
    expect(none.json).toMatchObject({ error: 'invalid_client_metadata', error_description: 'private_key_jwt needs jwks or jwks_uri.' });
    expect((await reg({ token_endpoint_auth_method: 'tls_client_auth' })).json.error).toBe('invalid_client_metadata');
  });
});

// ── response modes ───────────────────────────────────────────────────

describe('form_post and JARM response modes', () => {
  const base = (c: any, userId: string, extra: Record<string, string> = {}) => ({ client_id: c.client_id, redirect_uri: CB, response_type: 'code', scope: 'openid', login_hint: userId, state: 's-1', nonce: 'n', code_challenge: 'x'.repeat(43), code_challenge_method: 'S256', ...extra });
  const fieldsOf = (html: string): Record<string, string> => Object.fromEntries([...html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)].map((m) => [m[1]!, m[2]!.replace(/&amp;/g, '&')]));

  it('form_post answers an auto-submitting form to the redirect URI', async () => {
    const { e, c, user } = await setup();
    const r = await authz(e, base(c, user.id, { response_mode: 'form_post' }));
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('text/html');
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(r.text).toContain(`<form method="post" action="${CB}">`);
    const f = fieldsOf(r.text);
    expect(f).toMatchObject({ state: 's-1', iss: e.issuer });
    expect(f.code).toBeTruthy();
    // errors go the same way
    const denied = await authz(e, base(c, user.id, { response_mode: 'form_post', emulator_decision: 'deny' }));
    expect(fieldsOf(denied.text)).toMatchObject({ error: 'access_denied', state: 's-1' });
    // a front-channel response in a form never reaches the URL
    const hybrid = await setup({ grant_types: ['authorization_code', 'implicit'], response_types: ['code', 'id_token'] });
    const h = await authz(hybrid.e, base(hybrid.c, hybrid.user.id, { response_type: 'id_token', response_mode: 'form_post' }));
    expect(fieldsOf(h.text).id_token).toBeTruthy();
  });

  it('JARM modes pack the response into one signed JWT (iss, aud, exp) in the client\'s algorithm', async () => {
    const { e, c, user } = await setup();
    const q = await authz(e, base(c, user.id, { response_mode: 'query.jwt' }));
    expect(q.status).toBe(302);
    expect(new URL(q.location!).hash).toBe('');
    const jwt = qs(q.location).get('response')!;
    expect(qs(q.location).get('code')).toBeNull();
    const { header, payload } = decode(jwt);
    expect(header.alg).toBe('RS256');
    expect(payload).toMatchObject({ iss: e.issuer, aud: c.client_id, state: 's-1' });
    expect(payload.code).toBeTruthy();
    expect(payload.sub).toBeUndefined();
    expect(payload.exp - payload.iat).toBe(600);
    expect(((await e.tokens.verifyAny(jwt)) as any).ok).toBe(true);
    // the default JARM mode: query for a code, fragment when tokens come back
    expect(qs((await authz(e, base(c, user.id, { response_mode: 'jwt' }))).location).get('response')).toBeTruthy();
    expect(frag((await authz(e, base(c, user.id, { response_mode: 'fragment.jwt' }))).location).get('response')).toBeTruthy();
    const post = await authz(e, base(c, user.id, { response_mode: 'form_post.jwt' }));
    expect(post.status).toBe(200);
    expect(decode(fieldsOf(post.text).response!).payload).toMatchObject({ aud: c.client_id, state: 's-1' });
    // an error is a signed response too
    const denied = await authz(e, base(c, user.id, { response_mode: 'query.jwt', emulator_decision: 'deny' }));
    expect(decode(qs(denied.location).get('response')!).payload).toMatchObject({ error: 'access_denied', state: 's-1', iss: e.issuer });
  });

  it('signs in the registered authorization_signed_response_alg and sends token responses to the fragment', async () => {
    const { e, call, user } = await setup();
    const c = (await call('POST', '/v1/oauth_clients', { name: 'Jarm', redirect_uris: [CB], grant_types: ['authorization_code', 'implicit'], response_types: ['code', 'code id_token'], token_endpoint_auth_method: 'client_secret_post', authorization_signed_response_alg: 'ES384' })).json;
    expect(c.authorization_signed_response_alg).toBe('ES384');
    const r = await authz(e, base(c, user.id, { response_mode: 'query.jwt' }));
    const jwt = qs(r.location).get('response')!;
    expect(decode(jwt).header.alg).toBe('ES384');
    // published beside the instance key, so a relying party verifies it from the JWKS
    expect((await jwksOf(e)).keys.some((k: any) => k.kid === decode(jwt).header.kid && k.alg === 'ES384')).toBe(true);
    expect(((await e.tokens.verifyAny(jwt)) as any).ok).toBe(true);
    const tokens = await authz(e, base(c, user.id, { response_type: 'code id_token', response_mode: 'query.jwt' }));
    expect(new URL(tokens.location!).search).toBe('');
    expect(decode(frag(tokens.location).get('response')!).payload.error).toBe('invalid_request');
    const ok = await authz(e, base(c, user.id, { response_type: 'code id_token', response_mode: 'jwt' }));
    expect(decode(frag(ok.location).get('response')!).payload.id_token).toBeTruthy();
    expect((await call('POST', '/v1/oauth_clients', { name: 'Bad', redirect_uris: [CB], authorization_signed_response_alg: 'HS256' })).status).toBe(400);
    const doc = (await (await e.handle(new Request('http://x/.well-known/openid-configuration'))).json()) as any;
    expect(doc.response_modes_supported).toEqual(expect.arrayContaining(['form_post', 'jwt', 'query.jwt', 'fragment.jwt', 'form_post.jwt']));
    expect(doc.authorization_signing_alg_values_supported).toContain('ES384');
  });
});

// ── retried back-channel logout and CIBA delivery ────────────────────

describe('retried deliveries', () => {
  const BCL = 'https://rp.example/bcl';
  const NOTIFY = 'https://rp.example/ciba';
  const token = 'n'.repeat(24);
  const MIN = 60_000;
  const HOUR = 3_600_000;
  const receiver = () => {
    const hits: Array<{ url: string; body: string; headers: Record<string, string> }> = [];
    const state = { status: 204 as number | 'throw', location: undefined as string | undefined };
    const spy = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      hits.push({ url: String(url), body: String(init?.body ?? ''), headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)) });
      if (state.status === 'throw') throw new Error('connection refused');
      return new Response(state.status === 204 ? null : 'nope', { status: state.status, headers: state.location ? { location: state.location } : {} });
    });
    return { hits, state, fetch: spy as unknown as typeof fetch };
  };
  const logoutSetup = async () => {
    const rx = receiver();
    const s = await setup({ post_logout_redirect_uris: ['https://app.example/bye'], backchannel_logout_uri: BCL }, { fetch: rx.fetch });
    const tok = await login(s, s.c, s.user.id);
    return { ...s, rx, tok, deliveries: async () => (await s.call('GET', `/v1/oauth_clients/${s.c.client_id}/backchannel_deliveries`)).json };
  };
  const endSession = (s: { e: Engine; tok: any }) => raw(s.e, 'GET', `/oauth2/logout?${new URLSearchParams({ id_token_hint: s.tok.json.id_token })}`);
  const jtiOf = (body: string): string => decode(decodeURIComponent(body.replace('logout_token=', ''))).payload.jti;

  it('retries a failing back-channel logout on the real schedule, with a fresh token each time, until it succeeds', async () => {
    const s = await logoutSetup();
    s.rx.state.status = 500;
    await endSession(s);
    expect(s.rx.hits).toHaveLength(1);
    let list = await s.deliveries();
    expect(list.data[0]).toMatchObject({ object: 'backchannel_logout_delivery', status: 'failed', attempt_number: 1, max_attempts: 6, http_status: 500, error: 'backchannel_http_error', test: false });
    expect(list.data[0].next_retry_at).toBe(list.data[0].attempted_at + 5_000);
    // nothing happens until the clock gets there
    await advance(s.e, 4_000);
    expect(s.rx.hits).toHaveLength(1);
    await advance(s.e, 1_000);
    expect(s.rx.hits).toHaveLength(2);
    list = await s.deliveries();
    expect(list.data[0]).toMatchObject({ attempt_number: 2, status: 'failed' });
    expect(list.data[0].next_retry_at).toBe(list.data[0].attempted_at + 5 * MIN);
    s.rx.state.status = 204;
    await advance(s.e, 5 * MIN);
    expect(s.rx.hits).toHaveLength(3);
    list = await s.deliveries();
    expect(list.data[0]).toMatchObject({ status: 'success', attempt_number: 3, http_status: 204, next_retry_at: null, error: null });
    expect(list.data[0].delivered_at).toBeGreaterThan(0);
    await advance(s.e, 24 * HOUR);
    expect(s.rx.hits).toHaveLength(3);
    expect(new Set(s.rx.hits.map((h) => jtiOf(h.body))).size).toBe(3);
    const raws = (await anon(s.e)('GET', '/__emulator/oauth/deliveries?kind=backchannel_logout')).json.data;
    expect(raws[0].attempts.map((a: any) => [a.attempt, a.http_status, a.success])).toEqual([[1, 500, false], [2, 500, false], [3, 204, true]]);
  });

  it('gives up after six attempts (5 s, 5 min, 30 min, 2 h, 5 h), does not retry a refusal or a test, and records a redirect', async () => {
    const s = await logoutSetup();
    s.rx.state.status = 503;
    await endSession(s);
    for (const wait of [5_000, 5 * MIN, 30 * MIN, 2 * HOUR, 5 * HOUR]) await advance(s.e, wait);
    expect(s.rx.hits).toHaveLength(6);
    expect((await s.deliveries()).data[0]).toMatchObject({ status: 'failed', attempt_number: 6, next_retry_at: null });
    await advance(s.e, 24 * HOUR);
    expect(s.rx.hits).toHaveLength(6);

    // an OIDC relying party that answers and refuses is final (back-channel logout section 2.5)
    const refused = await logoutSetup();
    refused.rx.state.status = 400;
    await endSession(refused);
    expect((await refused.deliveries()).data[0]).toMatchObject({ status: 'failed', attempt_number: 1, next_retry_at: null });
    await advance(refused.e, DAY);
    expect(refused.rx.hits).toHaveLength(1);

    // a redirect is not followed and says where it pointed
    const redirected = await logoutSetup();
    redirected.rx.state.status = 302;
    redirected.rx.state.location = 'https://elsewhere.example/x';
    await endSession(redirected);
    expect((await redirected.deliveries()).data[0]).toMatchObject({ error: 'backchannel_redirect_not_followed', location: 'https://elsewhere.example/x', http_status: 302 });

    // a network failure is retried
    const down = await logoutSetup();
    down.rx.state.status = 'throw';
    await endSession(down);
    expect((await down.deliveries()).data[0]).toMatchObject({ http_status: null, error: 'backchannel_network_error', attempt_number: 1 });
    down.rx.state.status = 204;
    await advance(down.e, 5_000);
    expect((await down.deliveries()).data[0]).toMatchObject({ status: 'success', attempt_number: 2 });
  });

  it('sends a test logout once (never retried), logs it, and refuses a client with no back-channel URI', async () => {
    const s = await logoutSetup();
    s.rx.state.status = 500;
    const sent = await s.call('POST', `/v1/oauth_clients/${s.c.client_id}/backchannel_logout/test`);
    expect(sent.status).toBe(200);
    expect(sent.json).toMatchObject({ object: 'backchannel_logout_test', ok: false, status: 500, error: 'backchannel_http_error', body_excerpt: 'nope' });
    const claims = decode(decodeURIComponent(s.rx.hits[0]!.body.replace('logout_token=', ''))).payload;
    expect(claims).toMatchObject({ aud: s.c.client_id, atlas_test: true });
    expect(claims.sid).toMatch(/^sid_test_/);
    await advance(s.e, DAY);
    expect(s.rx.hits).toHaveLength(1);
    expect((await s.deliveries()).data[0]).toMatchObject({ test: true, max_attempts: 1, next_retry_at: null });
    expect(((await anon(s.e)('GET', '/__emulator/oauth/audit?action=oauth_client.backchannel_logout_test_sent')).json.data as any[]).length).toBe(1);
    const plain = (await s.call('POST', '/v1/oauth_clients', { name: 'No URI', redirect_uris: [CB] })).json;
    expect((await s.call('POST', `/v1/oauth_clients/${plain.client_id}/backchannel_logout/test`)).status).toBe(409);
    expect((await s.call('POST', '/v1/oauth_clients/nope/backchannel_logout/test')).status).toBe(404);
    expect((await s.call('GET', '/v1/oauth_clients/nope/backchannel_deliveries')).status).toBe(404);
  });

  it('retries a CIBA push, and announces a push request that expired undecided', async () => {
    const rx = receiver();
    const s = await setup({ grant_types: ['authorization_code', 'refresh_token', CIBA], backchannel_token_delivery_mode: 'push', backchannel_client_notification_endpoint: NOTIFY }, { fetch: rx.fetch });
    const session = (await s.call('POST', '/v1/sessions', { user_id: s.user.id })).json;
    const answer = (id: string, decision: string) => raw(s.e, 'POST', `/v1/client/me/backchannel_requests/${id}`, { authorization: `Bearer ${session.jwt}` }, { decision });
    const start = async () => (await s.post('/oauth2/backchannel_authentication', { ...s.creds, login_hint: s.user.id, scope: 'openid', client_notification_token: token })).json;
    rx.state.status = 500;
    const a = await start();
    expect((await answer(a.auth_req_id, 'approve')).json.status).toBe('approved');
    expect(rx.hits).toHaveLength(1);
    expect(rx.hits[0]!.headers.authorization).toBe(`Bearer ${token}`);
    rx.state.status = 204;
    await advance(s.e, 5_000);
    expect(rx.hits).toHaveLength(2);
    expect(JSON.parse(rx.hits[1]!.body)).toMatchObject({ auth_req_id: a.auth_req_id, token_type: 'Bearer' });
    const raws = (await anon(s.e)('GET', '/__emulator/oauth/deliveries?kind=ciba_push')).json.data;
    expect(raws[0]).toMatchObject({ kind: 'ciba_push', status: 'success', attempt_number: 2, endpoint: NOTIFY });
    await advance(s.e, DAY);
    expect(rx.hits).toHaveLength(2);

    // never answered: the client is told it expired (once)
    const b = await start();
    await advance(s.e, 121_000);
    expect(rx.hits).toHaveLength(3);
    expect(JSON.parse(rx.hits[2]!.body)).toEqual({ auth_req_id: b.auth_req_id, error: 'expired_token', error_description: 'The authentication request expired.' });
    await advance(s.e, HOUR);
    expect(rx.hits).toHaveLength(3);
  });

  it('retries a CIBA ping the same way, and run drives the queue without moving the clock', async () => {
    const rx = receiver();
    const s = await setup({ grant_types: ['authorization_code', CIBA], backchannel_token_delivery_mode: 'ping', backchannel_client_notification_endpoint: NOTIFY }, { fetch: rx.fetch });
    const session = (await s.call('POST', '/v1/sessions', { user_id: s.user.id })).json;
    const a = (await s.post('/oauth2/backchannel_authentication', { ...s.creds, login_hint: s.user.id, client_notification_token: token })).json;
    rx.state.status = 502;
    await raw(s.e, 'POST', `/v1/client/me/backchannel_requests/${a.auth_req_id}`, { authorization: `Bearer ${session.jwt}` }, { decision: 'approve' });
    expect(JSON.parse(rx.hits[0]!.body)).toEqual({ auth_req_id: a.auth_req_id });
    expect((await anon(s.e)('POST', '/__emulator/oauth/deliveries/run')).json).toEqual({ object: 'delivery_sweep', attempted: 0 });
    s.e.clock.advance(5_000);
    rx.state.status = 204;
    expect((await anon(s.e)('POST', '/__emulator/oauth/deliveries/run')).json.attempted).toBe(1);
    expect((await anon(s.e)('GET', '/__emulator/oauth/deliveries?kind=ciba_ping')).json.data[0]).toMatchObject({ status: 'success', attempt_number: 2 });
    // the request is still pollable after a ping
    expect((await s.post('/oauth2/token', { ...s.creds, grant_type: CIBA, auth_req_id: a.auth_req_id })).json.access_token).toBeTruthy();
  });
});

// ── verified publishers ──────────────────────────────────────────────

describe('verified OAuth publishers', () => {
  const dns = (e: Engine, name: string, records: string[], error?: string) => anon(e)('POST', '/__emulator/oauth/dns', { name, records, ...(error ? { error } : {}) });
  const app = (call: ReturnType<typeof client>, host: string, extra: Record<string, unknown> = {}) => call('POST', '/v1/oauth_clients', { name: host, redirect_uris: [`https://${host}/cb`], homepage_url: `https://${host}`, subject_type: 'pairwise', token_endpoint_auth_method: 'client_secret_post', allowed_scopes: ['openid', 'email', 'profile', 'read'], ...extra });
  const verified = async (e: Engine, call: ReturnType<typeof client>, extra: Record<string, unknown> = {}) => {
    const pub = (await call('POST', '/v1/oauth_publishers', { name: 'Acme', domain: 'acme.example', ...extra })).json;
    await dns(e, pub.record_name, [pub.record_value]);
    return (await call('POST', `/v1/oauth_publishers/${pub.id}/verify`)).json;
  };

  it('proves the domain with a DNS record, and only DNS sets or clears it', async () => {
    const e = makeEngine();
    const call = client(e);
    const pub = await call('POST', '/v1/oauth_publishers', { name: ' Acme ', domain: 'ACME.example.' });
    expect(pub.status).toBe(201);
    expect(pub.json).toMatchObject({ object: 'oauth_publisher', name: 'Acme', domain: 'acme.example', verified: false, verified_at: null, record_name: '_atlas-publisher.acme.example', shared_sector: false, sector_identifier: null, skip_consent: false, client_ids: [] });
    expect(pub.json.record_value).toMatch(/^atlas-publisher-verification=/);
    expect(eventTypes(e)).toContain('oauth_publisher.updated');
    expect((await call('POST', '/v1/oauth_publishers', { name: 'Again', domain: 'acme.example' })).status).toBe(409);
    expect((await call('POST', '/v1/oauth_publishers', { name: 'Bad', domain: 'not a domain' })).json.errors[0].param).toBe('domain');
    expect((await call('POST', '/v1/oauth_publishers', { name: 'Early', domain: 'early.example', shared_sector: true })).json.errors[0].param).toBe('shared_sector');
    expect((await call('GET', `/v1/oauth_publishers/${pub.json.id}`)).json.id).toBe(pub.json.id);
    expect((await call('GET', '/v1/oauth_publishers/opub_missing')).status).toBe(404);
    expect((await call('GET', '/v1/oauth_publishers')).json.data).toHaveLength(1);
    expect((await call('PUT', `/v1/oauth_publishers/${pub.json.id}/clients/anything`, {})).json.errors[0].message).toBe("Verify the publisher's domain before attaching apps.");
    expect((await call('PATCH', `/v1/oauth_publishers/${pub.json.id}`, { shared_sector: true })).json.errors[0].message).toBe('shared_sector needs a verified domain.');

    const missing = (await call('POST', `/v1/oauth_publishers/${pub.json.id}/verify`)).json;
    expect(missing).toMatchObject({ verified: false, record_found: false });
    expect(missing.last_checked_at).toBeGreaterThan(0);
    // a record with the wrong value proves nothing; the right one (split into TXT chunks) does
    await dns(e, pub.json.record_name, ['atlas-publisher-verification=wrong']);
    expect((await call('POST', `/v1/oauth_publishers/${pub.json.id}/verify`)).json.verified).toBe(false);
    await anon(e)('POST', '/__emulator/oauth/dns', { name: pub.json.record_name, records: [[pub.json.record_value.slice(0, 10), pub.json.record_value.slice(10)]] });
    const ok = (await call('POST', `/v1/oauth_publishers/${pub.json.id}/verify`)).json;
    expect(ok).toMatchObject({ verified: true, record_found: true, sector_identifier: null });
    expect(e.webhooks.events.filter((x) => x.type === 'oauth_publisher.updated').map((x) => x.payload.data.action)).toEqual(['created', 'verified']);
    // a transient DNS failure changes nothing; a missing record (NXDOMAIN) un-verifies
    await dns(e, pub.json.record_name, [], 'SERVFAIL');
    expect((await call('POST', `/v1/oauth_publishers/${pub.json.id}/verify`)).json).toMatchObject({ verified: true, record_found: false });
    await dns(e, pub.json.record_name, [], 'ENOTFOUND');
    expect((await call('POST', `/v1/oauth_publishers/${pub.json.id}/verify`)).json.verified).toBe(false);
    const audit = ((await anon(e)('GET', '/__emulator/oauth/audit')).json.data as any[]).filter((r) => r.target_type === 'oauth_publisher').map((r) => r.action);
    expect(audit).toEqual(['oauth_publisher.created', 'oauth_publisher.verified', 'oauth_publisher.verified']);
    expect((await call('DELETE', `/v1/oauth_publishers/${pub.json.id}`)).json).toEqual({ object: 'oauth_publisher', id: pub.json.id, deleted: true });
  });

  it('attaches apps whose homepage is on the domain, one publisher per app, and moves a sector only when confirmed', async () => {
    const e = makeEngine();
    const call = client(e);
    const pub = await verified(e, call);
    const a = (await app(call, 'a.acme.example')).json;
    const b = (await app(call, 'b.acme.example')).json;
    expect(a).toMatchObject({ subject_type: 'pairwise', sector_identifier: 'a.acme.example', homepage_url: 'https://a.acme.example' });
    const elsewhere = (await app(call, 'other.example')).json;
    expect((await call('PUT', `/v1/oauth_publishers/${pub.id}/clients/${elsewhere.client_id}`, {})).json.errors[0].message).toBe("The app's homepage_url must be an https URL on acme.example.");
    expect((await call('PUT', `/v1/oauth_publishers/${pub.id}/clients/client_nope`, {})).status).toBe(404);
    const attached = await call('PUT', `/v1/oauth_publishers/${pub.id}/clients/${a.client_id}`, {});
    expect(attached.status).toBe(200);
    expect(attached.json.client_ids).toEqual([a.client_id]);
    expect((await call('PUT', `/v1/oauth_publishers/${pub.id}/clients/${a.client_id}`, {})).status).toBe(200);
    const other = await verified(e, call, { name: 'Second', domain: 'second.example' }).catch(() => null);
    expect(other === null || other.id !== pub.id).toBe(true);
    // shared sector: pairwise apps only, and a move of the sector needs confirmation
    expect((await call('PATCH', `/v1/oauth_publishers/${pub.id}`, { shared_sector: true })).json).toMatchObject({ shared_sector: true, sector_identifier: 'acme.example' });
    const plain = (await app(call, 'c.acme.example', { subject_type: 'public' })).json;
    expect((await call('PUT', `/v1/oauth_publishers/${pub.id}/clients/${plain.client_id}`, {})).json.errors[0].message).toContain('pairwise apps only');
    const blocked = await call('PUT', `/v1/oauth_publishers/${pub.id}/clients/${b.client_id}`, {});
    expect(blocked.status).toBe(409);
    expect(blocked.json.errors[0].message).toContain('moves its sector from b.acme.example to acme.example');
    expect((await call('PUT', `/v1/oauth_publishers/${pub.id}/clients/${b.client_id}`, { allow_subject_change: 'yes' })).status).toBe(400);
    const moved = await call('PUT', `/v1/oauth_publishers/${pub.id}/clients/${b.client_id}`, { allow_subject_change: true });
    expect(moved.json.client_ids.sort()).toEqual([a.client_id, b.client_id].sort());
    expect((await call('GET', `/v1/oauth_clients/${b.client_id}`)).json.sector_identifier).toBe('acme.example');
    // the apps' subject settings are the publisher's while attached
    expect((await call('PATCH', `/v1/oauth_clients/${b.client_id}`, { subject_type: 'public' })).json.errors[0].message).toContain('belongs to a publisher that shares the sector acme.example');
    // detach / delete rules
    expect((await call('PATCH', `/v1/oauth_publishers/${pub.id}`, { shared_sector: false })).status).toBe(409);
    expect((await call('DELETE', `/v1/oauth_publishers/${pub.id}`)).status).toBe(409);
    expect((await call('DELETE', `/v1/oauth_publishers/${pub.id}/clients/${elsewhere.client_id}`)).status).toBe(404);
    expect((await call('DELETE', `/v1/oauth_publishers/${pub.id}/clients/${a.client_id}`)).json.client_ids).toEqual([b.client_id]);
    expect((await call('DELETE', `/v1/oauth_publishers/${pub.id}/clients/${b.client_id}`)).json.client_ids).toEqual([]);
    expect((await call('DELETE', `/v1/oauth_publishers/${pub.id}`)).status).toBe(200);
  });

  it('gives a shared sector one pairwise subject across the publisher\'s apps, different from the user id and other sectors', async () => {
    const e = makeEngine();
    const call = client(e);
    const post = form(e);
    const user = (await call('POST', '/v1/users', { email_address: 'ada@example.com' })).json;
    const pub = await verified(e, call);
    const a = (await app(call, 'a.acme.example')).json;
    const b = (await app(call, 'b.acme.example')).json;
    const sub = async (c: any) => decode((await login({ e, post }, c, user.id, 'openid')).json.id_token).payload.sub;
    const [subA, subB] = [await sub(a), await sub(b)];
    expect(subA).not.toBe(user.id);
    expect(subA).not.toBe(subB);
    await call('PATCH', `/v1/oauth_publishers/${pub.id}`, { shared_sector: true });
    await call('PUT', `/v1/oauth_publishers/${pub.id}/clients/${a.client_id}`, { allow_subject_change: true });
    await call('PUT', `/v1/oauth_publishers/${pub.id}/clients/${b.client_id}`, { allow_subject_change: true });
    const [shared1, shared2] = [await sub(a), await sub(b)];
    expect(shared1).toBe(shared2);
    expect(shared1).not.toBe(user.id);
    expect(shared1).not.toBe(subA);
    // userinfo and introspection agree with the ID token
    const tok = (await login({ e, post }, a, user.id, 'openid email')).json;
    expect((await raw(e, 'GET', '/oauth2/userinfo', { authorization: `Bearer ${tok.access_token}` })).json.sub).toBe(shared1);
    expect((await post('/oauth2/introspect', { client_id: a.client_id, client_secret: a.client_secret, token: tok.access_token })).json.sub).toBe(shared1);
  });

  it('names the publisher on consent and asks once for openid, email and profile across its apps', async () => {
    const e = makeEngine();
    const call = client(e);
    const user = (await call('POST', '/v1/users', { email_address: 'ada@example.com' })).json;
    const pub = await verified(e, call, { skip_consent: true });
    const a = (await app(call, 'a.acme.example', { require_consent: true, subject_type: 'public' })).json;
    const b = (await app(call, 'b.acme.example', { require_consent: true, subject_type: 'public' })).json;
    const c = (await app(call, 'c.acme.example', { require_consent: true, subject_type: 'public' })).json;
    for (const x of [a, b]) await call('PUT', `/v1/oauth_publishers/${pub.id}/clients/${x.client_id}`, {});
    const ask = (client_: any, scope: string) => authz(e, { client_id: client_.client_id, redirect_uri: `https://${client_.name}/cb`, response_type: 'code', scope, login_hint: user.id, code_challenge: 'x'.repeat(43), code_challenge_method: 'S256' });
    const first = await ask(a, 'openid email');
    expect(first.location).toContain('/oauth2/authorize/consent?consent_token=');
    const screen = (await raw(e, 'GET', new URL(first.location!).pathname + new URL(first.location!).search)).json;
    expect(screen.client.published_by).toBe('Acme');
    const done = await raw(e, 'POST', '/oauth2/authorize/consent', {}, { consent_token: qs(first.location).get('consent_token'), decision: 'approve' });
    expect(qs(done.location).get('code')).toBeTruthy();
    // the sibling is covered; another scope, or an app outside the publisher, still asks
    expect(qs((await ask(b, 'openid email')).location).get('code')).toBeTruthy();
    expect((await ask(b, 'openid read')).location).toContain('consent_token=');
    expect((await ask(c, 'openid email')).location).toContain('consent_token=');
    // opting out restores the prompt
    await call('PATCH', `/v1/oauth_publishers/${pub.id}`, { skip_consent: false });
    expect((await ask(b, 'openid email')).location).toContain('consent_token=');
  });
});

// ── Google access-token exchange ─────────────────────────────────────

describe('Google access-token exchange', () => {
  const G = 'g-1.apps.googleusercontent.com';
  const TYPE = 'urn:atlas:token-type:google_access_token';
  const setupGoogle = async (cfg: Record<string, unknown> = {}) => {
    const s = await setup({ first_party: true, grant_types: ['authorization_code'] });
    await anon(s.e)('POST', '/__emulator/oauth/google_exchange', { enabled: true, client_ids: [G], atlas_client_ids: [s.c.client_id], ...cfg });
    const google = async (extra: Record<string, unknown> = {}) => ((await anon(s.e)('POST', '/__emulator/google/tokens', { aud: G, sub: '1001', email: 'ada@example.com', given_name: 'Ada', ...extra })).json.access_token as string);
    const exchange = (subject_token: string, extra: Record<string, string> = {}) => s.post('/oauth2/token', { ...s.creds, grant_type: EXCHANGE, subject_token, subject_token_type: TYPE, requested_token_type: 'urn:atlas:token-type:session', ...extra });
    return { ...s, google, exchange };
  };

  it('trades a Google token for an Atlas session with a refresh token', async () => {
    const { e, user, google, exchange, call } = await setupGoogle();
    const r = await exchange(await google());
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ issued_token_type: 'urn:atlas:token-type:session', token_type: 'Bearer' });
    expect(r.json.expires_in).toBeGreaterThan(0);
    const claims = ((await e.tokens.verifyAny(r.json.access_token)) as any).claims;
    expect(claims).toMatchObject({ sub: user.id, sid: r.json.session_id });
    expect((await call('GET', `/v1/sessions/${r.json.session_id}`)).json.status).toBe('active');
    const refreshed = await raw(e, 'POST', `/v1/client/sessions/${r.json.session_id}/tokens`, {}, { refresh_token: r.json.refresh_token });
    expect(refreshed.status).toBe(200);
    expect(refreshed.json.jwt).toBeTruthy();
    // the same Google account is recognised by its subject afterwards, even with another email
    const again = await exchange(await google({ email: 'ada.new@example.com' }));
    expect(((await e.tokens.verifyAny(again.json.access_token)) as any).claims.sub).toBe(user.id);
  });

  it('refuses every way Google or the instance does not vouch for the token, with one generic invalid_grant', async () => {
    const { e, post, creds, google, exchange, call, c } = await setupGoogle({ hosted_domains: ['example.com'] });
    const grant = async (token: string, extra: Record<string, string> = {}) => {
      const r = await exchange(token, extra);
      expect(r.status).toBe(400);
      expect(r.json).toMatchObject({ error: 'invalid_grant', error_description: 'The Google access token was not accepted.' });
    };
    await grant(await google({ aud: 'someone-elses-app' }));
    await grant(await google({ azp: 'someone-elses-app' }));
    await grant(await google({ email_verified: false }));
    await grant(await google({ scope: 'calendar' }));
    await grant(await google({ hd: 'other.com' }));
    await grant(await google({ sub: 'bad sub!' }));
    await grant('ya29.never-registered-token-0000');
    await grant('short');
    const old = await google({ hd: 'example.com' });
    await advance(e, 3_601_000);
    await grant(old);
    // the instance gates
    const live = await google({ hd: 'example.com' });
    expect((await exchange(live, { actor_token: 'x' })).json.error).toBe('invalid_request');
    expect((await exchange(live, { requested_token_type: 'urn:ietf:params:oauth:token-type:access_token' })).json.error).toBe('invalid_request');
    const third = (await call('POST', '/v1/oauth_clients', { name: 'Third party', redirect_uris: [CB], token_endpoint_auth_method: 'client_secret_post' })).json;
    expect((await post('/oauth2/token', { client_id: third.client_id, client_secret: third.client_secret, grant_type: EXCHANGE, subject_token: live, subject_token_type: TYPE })).json.error).toBe('unauthorized_client');
    const first = (await call('POST', '/v1/oauth_clients', { name: 'First, unlisted', redirect_uris: [CB], first_party: true, token_endpoint_auth_method: 'client_secret_post' })).json;
    expect((await post('/oauth2/token', { client_id: first.client_id, client_secret: first.client_secret, grant_type: EXCHANGE, subject_token: live, subject_token_type: TYPE })).status).toBe(403);
    await anon(e)('POST', '/__emulator/oauth/google_exchange', { enabled: false });
    expect((await exchange(live)).json).toMatchObject({ error: 'invalid_request', error_description: 'The Google token exchange is not enabled for this instance.' });
    await anon(e)('POST', '/__emulator/oauth/google_exchange', { enabled: true, client_ids: [] });
    await grant(live);
    expect(creds.client_id).toBe(c.client_id);
  });

  it('creates an account only when sign-up is allowed, and never signs in a banned one', async () => {
    const { e, call, google, exchange, user } = await setupGoogle();
    const stranger = await google({ sub: '2002', email: 'new@example.com', given_name: 'New', family_name: 'Person' });
    const denied = await exchange(stranger);
    expect(denied.status).toBe(403);
    expect(denied.json).toMatchObject({ error: 'access_denied', error_description: 'No Atlas account matches this Google account.' });
    await anon(e)('POST', '/__emulator/oauth/google_exchange', { allow_sign_up: true });
    const made = await exchange(await google({ sub: '2002', email: 'new@example.com', given_name: 'New', family_name: 'Person' }));
    expect(made.status).toBe(200);
    const created = ((await call('GET', '/v1/users?email_address=new@example.com')).json.data as any[])[0];
    expect(created).toMatchObject({ first_name: 'New', last_name: 'Person' });
    expect(((await e.tokens.verifyAny(made.json.access_token)) as any).claims.sub).toBe(created.id);
    expect(eventTypes(e)).toContain('user.created');
    await call('POST', `/v1/users/${user.id}/ban`);
    const banned = await exchange(await google());
    expect(banned.status).toBe(403);
    expect(banned.json.error_description).toBe('This account cannot sign in.');
    // a new Google account with sign-up off is refused (a fresh instance has no account for it)
    const fresh = await setupGoogle();
    expect((await fresh.exchange(await fresh.google({ sub: '3003', email: 'nobody@example.com' }))).json.error).toBe('access_denied');
  });
});

// ── registration extensions ──────────────────────────────────────────

describe('dynamic registration: software statements and pairwise subjects', () => {
  const pub = ec();
  const jwks = { keys: [{ ...pub.jwk, kid: 'p1', alg: 'ES256', use: 'sig' }] };
  const statement = (claims: Record<string, unknown> = {}, signer: KeyObject = pub.privateKey, header: Record<string, unknown> = {}) => es256(signer, { alg: 'ES256', kid: 'p1', ...header }, { iss: 'https://publisher.example', iat: nowS(), exp: nowS() + 600, client_name: 'From the statement', ...claims });
  const reg = (e: Engine, body: Record<string, unknown>) => raw(e, 'POST', '/oauth2/register', {}, { redirect_uris: [CB], ...body });

  it('takes the claims of a statement signed by an approved publisher over the request\'s', async () => {
    const e = makeEngine();
    await anon(e)('POST', '/__emulator/oauth/config', { dynamic_registration: true });
    expect((await anon(e)('POST', '/__emulator/oauth/dcr', { software_statement_issuers: [{ issuer: 'https://publisher.example', jwks }], require_software_statement: true })).json).toMatchObject({ require_software_statement: true });
    expect((await reg(e, { client_name: 'No statement' })).json).toMatchObject({ error: 'invalid_software_statement', error_description: 'A software statement is required to register here.' });
    const ok = await reg(e, { client_name: 'Request name', software_statement: statement() });
    expect(ok.status).toBe(201);
    expect(ok.json.client_name).toBe('From the statement');
    expect((await reg(e, { software_statement: statement({}, ec().privateKey) })).json).toMatchObject({ error: 'invalid_software_statement', error_description: 'The software statement signature or claims are invalid.' });
    expect((await reg(e, { software_statement: statement({ exp: nowS() - 600 }) })).json.error).toBe('invalid_software_statement');
    expect((await reg(e, { software_statement: statement({ iss: 'https://stranger.example' }) })).json).toMatchObject({ error: 'unapproved_software_statement', error_description: 'The software statement publisher is not approved on this server.' });
    expect((await reg(e, { software_statement: 'not.a.jwt.at.all' })).json).toMatchObject({ error: 'invalid_software_statement', error_description: 'The software statement is not a JWT.' });
    // the registered claims never leak into the client
    expect(ok.json.iss).toBeUndefined();
  });

  it('registers pairwise clients: a sector from the redirect host, or a sector document that lists every redirect URI', async () => {
    const doc = ['https://a.example/cb', 'https://b.example/cb'];
    const fetchSpy = vi.fn(async (url: string | URL | Request) => (String(url) === 'https://sector.example/uris.json' ? new Response(JSON.stringify(doc), { status: 200 }) : new Response('no', { status: 404 })));
    const e = makeEngine({ fetch: fetchSpy as unknown as typeof fetch });
    await anon(e)('POST', '/__emulator/oauth/config', { dynamic_registration: true });
    const one = await reg(e, { subject_type: 'pairwise', redirect_uris: ['https://a.example/cb'] });
    expect(one.status).toBe(201);
    expect(one.json.subject_type).toBe('pairwise');
    expect((await reg(e, { subject_type: 'pairwise', redirect_uris: ['https://a.example/cb', 'https://b.example/cb'] })).json).toMatchObject({ error: 'invalid_client_metadata', error_description: 'A pairwise client whose redirect_uris span more than one host must register a sector_identifier_uri.' });
    const shared = await reg(e, { subject_type: 'pairwise', redirect_uris: doc, sector_identifier_uri: 'https://sector.example/uris.json' });
    expect(shared.status).toBe(201);
    expect(shared.json).toMatchObject({ subject_type: 'pairwise', sector_identifier_uri: 'https://sector.example/uris.json' });
    expect((await reg(e, { subject_type: 'pairwise', redirect_uris: ['https://c.example/cb'], sector_identifier_uri: 'https://sector.example/uris.json' })).json.error_description).toContain('does not list every redirect_uri (missing: https://c.example/cb)');
    expect((await reg(e, { subject_type: 'pairwise', redirect_uris: doc, sector_identifier_uri: 'https://gone.example/x.json' })).json.error_description).toContain('answered 404');
    expect((await reg(e, { subject_type: 'weird' })).json.error_description).toBe('subject_type must be public or pairwise.');
    expect((await reg(e, { subject_type: 'pairwise', redirect_uris: ['https://a.example/cb'], sector_identifier_uri: 'http://sector.example/x' })).json.error_description).toContain('must be an https URL');
    // moving a pairwise client to another host would change every user's subject: refused
    const url = `/oauth2/register/${one.json.client_id}`;
    const move = await raw(e, 'PUT', url, { authorization: `Bearer ${one.json.registration_access_token}` }, { redirect_uris: ['https://elsewhere.example/cb'] });
    expect(move.status).toBe(400);
    expect(move.json.error_description).toContain("would move the client's sector from a.example to elsewhere.example");
  });
});

describe('parity coverage of the round-four oauth routes', () => {
  it('has a parity request for every hand-written route this module adds', () => {
    expect(uncoveredRoutes(makeEngine(), fullParityRequests).filter((r) => /signing_key|oauth_publisher|backchannel_(deliveries|logout)/.test(r))).toEqual([]);
  });
});
