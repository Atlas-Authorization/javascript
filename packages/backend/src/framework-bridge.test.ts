import { createCipheriv, createHmac, hkdfSync, pbkdf2Sync, randomBytes } from 'node:crypto';
import { EncryptJWT, jwtVerify } from 'jose';
import { describe, expect, it } from 'vitest';
import {
  FRAMEWORK_BRIDGE_PRESETS,
  authJsExtractor,
  bridgeAssertionIssuer,
  deviseExtractor,
  djangoSignedCookieExtractor,
  expressSessionExtractor,
  ironSessionExtractor,
  signBridgeAssertion,
} from './framework-bridge';
import { createMigrationBridge } from './migration-bridge';
import { resolveMigrationBridgePreset } from './migration-presets';

const BRIDGE_SECRET = 'bridge-secret-0123456789abcdefghijklmnopqrstuvwxyz';
const headers = {};

async function verifyAssertion(token: string, source: string) {
  const { payload } = await jwtVerify(token, new TextEncoder().encode(BRIDGE_SECRET), {
    issuer: bridgeAssertionIssuer(source),
    algorithms: ['HS256'],
  });
  return payload;
}

describe('framework bridge presets', () => {
  it('every preset resolves with its defaults or a cookie name', () => {
    for (const id of FRAMEWORK_BRIDGE_PRESETS) {
      const r = resolveMigrationBridgePreset(id, { cookie_name: '_shop_session' });
      expect(r.cookies.length, id).toBeGreaterThan(0);
      if (r.mode === 'jwt') {
        expect(r.algorithms).toEqual(['HS256']);
        expect(r.issuer).toMatch(/^urn:atlas:bridge:/);
        expect(r.claims.sessionKey).toBe('jti');
      }
    }
    expect(resolveMigrationBridgePreset('lucia').cookies).toEqual(['auth_session']);
    expect(resolveMigrationBridgePreset('passport').cookies).toEqual(['connect.sid']);
    expect(resolveMigrationBridgePreset('django').cookies).toEqual(['sessionid']);
    expect(resolveMigrationBridgePreset('authjs').clearCookies).toContain('__Secure-authjs.session-token*');
    expect(() => resolveMigrationBridgePreset('devise')).toThrow(/cookie_name/);
  });
});

describe('bridge assertions', () => {
  it('are short-lived HS256 JWTs carrying the old session id as jti', async () => {
    const now = new Date();
    const token = await signBridgeAssertion({ source: 'devise', sub: '17', sessionKey: 'sid-1', email: 'a@b.co', mfa: true }, BRIDGE_SECRET, now);
    const claims = await verifyAssertion(token, 'devise');
    expect(claims).toMatchObject({ sub: '17', jti: 'sid-1', email: 'a@b.co', amr: ['pwd', 'mfa'] });
    expect(claims.exp! - claims.iat!).toBe(120);
  });

  it('refuse a weak bridge secret', async () => {
    await expect(signBridgeAssertion({ source: 'x', sub: '1', sessionKey: 'k' }, 'short')).rejects.toThrow(/32 characters/);
  });
});

describe('extractors', () => {
  it('Auth.js: database tokens pass through, JWT sessions become assertions', async () => {
    const secret = 'auth-secret-0123456789abcdef0123456789';
    const extract = authJsExtractor({ secret, bridgeSecret: BRIDGE_SECRET });
    expect(await extract({ cookies: { 'authjs.session-token': '5c1d3a1e-8f6b-4e8e-9d7c-2b1f4a0e9c33' }, headers })).toBe(
      '5c1d3a1e-8f6b-4e8e-9d7c-2b1f4a0e9c33',
    );
    const salt = '__Secure-authjs.session-token';
    const key = new Uint8Array(hkdfSync('sha256', secret, salt, `Auth.js Generated Encryption Key (${salt})`, 64));
    const jwe = await new EncryptJWT({ sub: 'clu1ada', email: 'ada@example.com', name: 'Ada' })
      .setProtectedHeader({ alg: 'dir', enc: 'A256CBC-HS512' })
      .setIssuedAt()
      .setExpirationTime('1h')
      .setJti('auth-jti-1')
      .encrypt(key);
    const assertion = await extract({ cookies: { [salt]: jwe }, headers });
    expect(await verifyAssertion(assertion!, 'authjs')).toMatchObject({ sub: 'clu1ada', jti: 'auth-jti-1', email: 'ada@example.com' });
    expect(await extract({ cookies: {}, headers })).toBeUndefined();
  });

  it('express-session: the id out of a signed cookie', async () => {
    const cookie = encodeURIComponent('s:hello.DGDUkGlIkCzPz+C0B064FNgHdEjox7ch8tOBGslZ5QI');
    expect(await expressSessionExtractor({ secrets: 'tobiiscool' })({ cookies: { 'connect.sid': cookie }, headers })).toBe('hello');
    expect(await expressSessionExtractor({ secrets: 'wrong' })({ cookies: { 'connect.sid': cookie }, headers })).toBeUndefined();
  });

  it('iron-session: unseal and assert the user id', async () => {
    const password = 'complex_password_at_least_32_characters_long';
    const encSalt = randomBytes(32).toString('hex');
    const iv = randomBytes(16);
    const c = createCipheriv('aes-256-cbc', pbkdf2Sync(password, encSalt, 1, 32, 'sha1'), iv);
    const ct = Buffer.concat([c.update(JSON.stringify({ user: { id: 'u_42', email: 'u@example.com' } })), c.final()]);
    const base = ['Fe26.2', '1', encSalt, iv.toString('base64url'), ct.toString('base64url'), String(Date.now() + 3600_000)].join('*');
    const hmacSalt = randomBytes(32).toString('hex');
    const mac = createHmac('sha256', pbkdf2Sync(password, hmacSalt, 1, 32, 'sha1')).update(base).digest('base64url');
    const extract = ironSessionExtractor({ cookieName: 'app_session', password, bridgeSecret: BRIDGE_SECRET });
    const assertion = await extract({ cookies: { app_session: `${base}*${hmacSalt}*${mac}~2` }, headers });
    expect(await verifyAssertion(assertion!, 'iron_session')).toMatchObject({ sub: 'u_42', email: 'u@example.com' });
  });

  it('Devise: decrypt the Rails cookie and assert the Warden user', async () => {
    const secretKeyBase = 'f'.repeat(128);
    const key = pbkdf2Sync(secretKeyBase, 'authenticated encrypted cookie', 1000, 32, 'sha256');
    const session = { session_id: 'abc123', 'warden.user.user.key': [[17], '$2a$12$K5tRZ1o6aF1k3Q1vXk0cJ.'] };
    const envelope = { _rails: { message: Buffer.from(JSON.stringify(session)).toString('base64'), exp: null, pur: 'cookie._shop_session' } };
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([c.update(JSON.stringify(envelope)), c.final()]);
    const cookie = encodeURIComponent(`${ct.toString('base64')}--${iv.toString('base64')}--${c.getAuthTag().toString('base64')}`);
    const extract = deviseExtractor({ cookieName: '_shop_session', secretKeyBase, bridgeSecret: BRIDGE_SECRET });
    const assertion = await extract({ cookies: { _shop_session: cookie }, headers });
    expect(await verifyAssertion(assertion!, 'devise')).toMatchObject({ sub: '17', jti: 'abc123' });
  });

  it('Django signed cookies: verify with SECRET_KEY and assert _auth_user_id', async () => {
    // Python port of django.core.signing.dumps (SHA-1 signer, uncompressed), SECRET_KEY "old-key".
    const cookie = 'eyJfYXV0aF91c2VyX2lkIjo3fQ:1xLFCq:5-7fXjnvolIqcQqzyGn3DN_7rMw';
    const extract = djangoSignedCookieExtractor({ secretKey: 'old-key', bridgeSecret: BRIDGE_SECRET, maxAgeSeconds: 10 * 365 * 86400 });
    const assertion = await extract({ cookies: { sessionid: cookie }, headers });
    expect((await verifyAssertion(assertion!, 'django')).sub).toBe('7');
    expect(await djangoSignedCookieExtractor({ secretKey: 'nope', bridgeSecret: BRIDGE_SECRET })({ cookies: { sessionid: cookie }, headers })).toBeUndefined();
  });
});

describe('end to end through createMigrationBridge', () => {
  it('sends the extracted id to the source exchange and clears the old cookie', async () => {
    const calls: Array<{ url: string; body: { token: string } }> = [];
    const fetchImpl = (async (url: string, init: { body: string }) => {
      calls.push({ url, body: JSON.parse(init.body) as { token: string } });
      return new Response(
        JSON.stringify({ object: 'session_tokens', jwt: 'atlas.jwt', refresh_token: 'rt', session_id: 'sess_1', user_id: 'user_1', expires_in: 60 }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;
    const bridge = createMigrationBridge({
      source: 'passport',
      fapiOrigin: 'https://clerk.example.com',
      publishableKey: 'pk_test_x',
      secretKey: 'sk_test_x',
      bapiBaseUrl: 'https://api.example.com',
      extractToken: expressSessionExtractor({ secrets: 'tobiiscool' }),
      fetchImpl,
    });
    const decision = await bridge({ headers: { cookie: `connect.sid=${encodeURIComponent('s:hello.DGDUkGlIkCzPz+C0B064FNgHdEjox7ch8tOBGslZ5QI')}` } });
    expect(calls[0]).toEqual({ url: 'https://api.example.com/v1/migrations/passport/exchange', body: { token: 'hello' } });
    expect(decision.action).toBe('signed_in');
    if (decision.action === 'signed_in') expect(decision.cookies.map((c) => c.name)).toContain('connect.sid');
  });
});
