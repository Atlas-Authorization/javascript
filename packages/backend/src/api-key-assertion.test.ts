import { describe, expect, it } from 'vitest';
import { signApiKeyAssertion } from './api-key-assertion';
import { createKeyMirror, memoryKeyMirrorStore, type MirroredApiKey } from './key-mirror';

const NOW = 1_800_000_000_000;
const pem = (label: string, der: ArrayBuffer) => `-----BEGIN ${label}-----\n${Buffer.from(der).toString('base64').match(/.{1,64}/g)!.join('\n')}\n-----END ${label}-----\n`;

async function pair(kind: 'ES256' | 'EdDSA') {
  const algo = kind === 'ES256' ? { name: 'ECDSA', namedCurve: 'P-256' } : { name: 'Ed25519' };
  const kp = (await crypto.subtle.generateKey(algo, true, ['sign', 'verify'])) as { privateKey: Parameters<typeof crypto.subtle.exportKey>[1]; publicKey: Parameters<typeof crypto.subtle.exportKey>[1] };
  return {
    privatePem: pem('PRIVATE KEY', await crypto.subtle.exportKey('pkcs8', kp.privateKey)),
    publicPem: pem('PUBLIC KEY', await crypto.subtle.exportKey('spki', kp.publicKey)),
  };
}

const row = (publicKeyPem: string, extra: Partial<MirroredApiKey> = {}): MirroredApiKey => ({
  id: 'eak_kp1',
  hash: 'kp:eak_kp1',
  prefix: 'kp',
  subject_type: 'organization',
  subject_id: 'org_1',
  name: null,
  scopes: ['calls:read', 'calls:write'],
  expires_at: null,
  revoked_at: null,
  credential: 'key_pair',
  publicKeyPem,
  audience: 'https://api.example.com',
  ...extra,
});

async function setup(kind: 'ES256' | 'EdDSA' = 'ES256', extra: Partial<MirroredApiKey> = {}) {
  const k = await pair(kind);
  const store = memoryKeyMirrorStore();
  await store.put(row(k.publicPem, extra));
  const mirror = createKeyMirror({ store, apiKeys: {} as never, now: () => NOW });
  const sign = (o: Partial<Parameters<typeof signApiKeyAssertion>[1]> = {}) =>
    signApiKeyAssertion(k.privatePem, { keyId: 'eak_kp1', audience: 'https://api.example.com', now: NOW, ...o });
  return { mirror, sign, k };
}

const decode = (part: string) => JSON.parse(Buffer.from(part, 'base64url').toString());

describe('signApiKeyAssertion', () => {
  it('signs ES256 with a raw 64-byte signature and the documented header and claims', async () => {
    const { sign } = await setup();
    const jwt = await sign({ scope: ['calls:read'], jti: 'j1' });
    const [h, c, s] = jwt.split('.') as [string, string, string];
    expect(decode(h)).toEqual({ alg: 'ES256', kid: 'eak_kp1', typ: 'JWT' });
    expect(decode(c)).toEqual({ iss: 'eak_kp1', aud: 'https://api.example.com', iat: NOW / 1000, exp: NOW / 1000 + 300, jti: 'j1', scope: 'calls:read' });
    expect(Buffer.from(s, 'base64url')).toHaveLength(64);
  });

  it('uses EdDSA for an Ed25519 key and a random jti by default', async () => {
    const { sign } = await setup('EdDSA');
    const [a, b] = [await sign(), await sign()];
    expect(decode(a.split('.')[0]!).alg).toBe('EdDSA');
    expect(decode(a.split('.')[1]!).jti).not.toBe(decode(b.split('.')[1]!).jti);
  });

  it('rejects a key that is not PKCS#8 P-256 or Ed25519', async () => {
    await expect(signApiKeyAssertion('nope', { keyId: 'k', audience: 'a' })).rejects.toThrow(TypeError);
  });
});

describe('keyMirror.verifyAssertion', () => {
  for (const kind of ['ES256', 'EdDSA'] as const) {
    it(`accepts a good ${kind} assertion and reports jti and exp`, async () => {
      const { mirror, sign } = await setup(kind);
      const r = await mirror.verifyAssertion(await sign({ jti: 'j1' }));
      expect(r).toMatchObject({ valid: true, credential: 'key_pair', jti: 'j1', exp: NOW / 1000 + 300, effective_scopes: ['calls:read', 'calls:write'] });
    });
  }

  it('refuses a replayed jti but not an assertion without one', async () => {
    const { mirror, sign } = await setup();
    const jwt = await sign({ jti: 'once' });
    expect((await mirror.verifyAssertion(jwt)).valid).toBe(true);
    expect(await mirror.verifyAssertion(jwt)).toEqual({ valid: false, code: 'assertion_replayed' });
  });

  it('uses the store claimAssertionJti when it has one', async () => {
    const k = await pair('ES256');
    const store = { ...memoryKeyMirrorStore(), claimAssertionJti: async () => false };
    await store.put(row(k.publicPem));
    const mirror = createKeyMirror({ store, apiKeys: {} as never, now: () => NOW });
    const jwt = await signApiKeyAssertion(k.privatePem, { keyId: 'eak_kp1', audience: 'https://api.example.com', now: NOW });
    expect(await mirror.verifyAssertion(jwt)).toEqual({ valid: false, code: 'assertion_replayed' });
  });

  it('narrows by scope and refuses a scope the key lacks', async () => {
    const { mirror, sign } = await setup();
    expect(await mirror.verifyAssertion(await sign({ scope: 'calls:read' }))).toMatchObject({ valid: true, effective_scopes: ['calls:read'] });
    expect(await mirror.verifyAssertion(await sign({ scope: 'admin' }))).toEqual({ valid: false, code: 'scope_not_granted', missing_scopes: ['admin'] });
    expect(await mirror.verifyAssertion(await sign({ scope: 'calls:read' }), { requiredScopes: ['calls:write'] })).toMatchObject({ valid: false, code: 'insufficient_scope' });
  });

  it('refuses wrong audience, expiry, future iat, too-long lifetime', async () => {
    const { mirror, sign } = await setup();
    expect(await mirror.verifyAssertion(await sign({ audience: 'other' }))).toEqual({ valid: false, code: 'wrong_audience' });
    expect(await mirror.verifyAssertion(await sign({ now: NOW - 400_000 }))).toEqual({ valid: false, code: 'assertion_expired' });
    expect(await mirror.verifyAssertion(await sign({ now: NOW + 120_000 }))).toEqual({ valid: false, code: 'assertion_not_yet_valid' });
    expect(await mirror.verifyAssertion(await sign({ ttlSeconds: 7200 }))).toEqual({ valid: false, code: 'assertion_lifetime_too_long' });
  });

  it('honours the key max_token_lifetime_seconds', async () => {
    const { mirror, sign } = await setup('ES256', { max_token_lifetime_seconds: 60 });
    expect(await mirror.verifyAssertion(await sign({ ttlSeconds: 120 }))).toEqual({ valid: false, code: 'assertion_lifetime_too_long' });
  });

  it('refuses a bad signature, a tampered payload, none, an alg that does not match the key, and iss != kid', async () => {
    const { mirror, sign } = await setup();
    const [h, c, s] = (await sign()).split('.') as [string, string, string];
    const claims = decode(c);
    const re = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    expect(await mirror.verifyAssertion(`${h}.${re({ ...claims, scope: 'x' })}.${s}`)).toEqual({ valid: false, code: 'invalid_assertion' });
    expect(await mirror.verifyAssertion(`${re({ alg: 'none', kid: 'eak_kp1' })}.${c}.`)).toEqual({ valid: false, code: 'invalid_assertion' });
    expect(await mirror.verifyAssertion(`${re({ alg: 'EdDSA', kid: 'eak_kp1', typ: 'JWT' })}.${c}.${s}`)).toEqual({ valid: false, code: 'invalid_assertion' });
    expect(await mirror.verifyAssertion('not-a-jwt')).toEqual({ valid: false, code: 'invalid_assertion' });
    const other = await pair('ES256');
    const forged = await signApiKeyAssertion(other.privatePem, { keyId: 'eak_kp1', audience: 'https://api.example.com', now: NOW });
    expect(await mirror.verifyAssertion(forged)).toEqual({ valid: false, code: 'invalid_assertion' });
  });

  it('answers a bare valid:false for an unknown kid and for a revoked or expired key', async () => {
    const { mirror, sign, k } = await setup();
    expect(await mirror.verifyAssertion(await sign({ keyId: 'eak_nope' }))).toEqual({ valid: false });
    const store = memoryKeyMirrorStore();
    await store.put(row(k.publicPem, { revoked_at: 1 }));
    const m2 = createKeyMirror({ store, apiKeys: {} as never, now: () => NOW });
    expect(await m2.verifyAssertion(await sign())).toEqual({ valid: false });
    await store.put(row(k.publicPem, { expires_at: NOW - 1 }));
    expect(await m2.verifyAssertion(await sign())).toEqual({ valid: false });
  });

  it('refuses a secret-credential row and enforces the IP allowlist', async () => {
    const { mirror, sign, k } = await setup('ES256', { allowed_ips: ['10.0.0.0/8'] });
    expect(await mirror.verifyAssertion(await sign())).toEqual({ valid: false, code: 'client_ip_required' });
    expect(await mirror.verifyAssertion(await sign({ jti: 'a' }), { clientIp: '192.168.0.1' })).toEqual({ valid: false, code: 'ip_not_allowed' });
    expect((await mirror.verifyAssertion(await sign({ jti: 'b' }), { clientIp: '10.1.2.3' })).valid).toBe(true);
    const store = memoryKeyMirrorStore();
    await store.put(row(k.publicPem, { credential: 'secret' }));
    const m2 = createKeyMirror({ store, apiKeys: {} as never, now: () => NOW });
    expect(await m2.verifyAssertion(await sign())).toEqual({ valid: false, code: 'invalid_assertion' });
  });
});
