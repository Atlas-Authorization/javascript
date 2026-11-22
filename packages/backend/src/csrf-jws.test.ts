import { describe, expect, it } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { checkCsrfJws, verifyCsrfJws } from './csrf-jws';

const issuer = 'https://auth.example.com';

async function setup() {
  const { publicKey, privateKey } = await generateKeyPair('ES256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'ES256', use: 'sig' };
  const mint = (over: { sid?: string; aud?: string; typ?: string; token_use?: string; iss?: string; exp?: string } = {}) =>
    new SignJWT({ sid: over.sid ?? 'sess_1', token_use: over.token_use ?? 'csrf' })
      .setProtectedHeader({ alg: 'ES256', kid: 'k1', typ: over.typ ?? 'csrf+jwt' })
      .setIssuer(over.iss ?? issuer)
      .setAudience(over.aud ?? 'atlas:csrf')
      .setIssuedAt()
      .setExpirationTime(over.exp ?? '1m')
      .sign(privateKey);
  return { jwks: { keys: [jwk] }, mint };
}

const req = (token: string | null, cookie: string | null) =>
  ({
    headers: {
      get: (name: string) =>
        name === 'cookie' ? (cookie === null ? null : `__atlas_csrf=${cookie}`) : name === 'x-atlas-csrf' ? token : null,
    },
  }) as never;

describe('checkCsrfJws', () => {
  it('accepts a token signed for this session', async () => {
    const { jwks, mint } = await setup();
    expect(await checkCsrfJws(await mint(), { sid: 'sess_1', issuer, jwks })).toBe(true);
  });

  it('refuses another session, wrong type, wrong audience, wrong issuer, expired and garbage', async () => {
    const { jwks, mint } = await setup();
    const o = { sid: 'sess_1', issuer, jwks };
    expect(await checkCsrfJws(await mint({ sid: 'sess_2' }), o)).toBe(false);
    expect(await checkCsrfJws(await mint({ typ: 'JWT' }), o)).toBe(false);
    expect(await checkCsrfJws(await mint({ aud: 'ins_1' }), o)).toBe(false);
    expect(await checkCsrfJws(await mint({ token_use: 'session' }), o)).toBe(false);
    expect(await checkCsrfJws(await mint({ iss: 'https://evil.example.com' }), o)).toBe(false);
    expect(await checkCsrfJws(await mint({ exp: '-1m' }), o)).toBe(false);
    expect(await checkCsrfJws('nope', o)).toBe(false);
    expect(await checkCsrfJws(null, o)).toBe(false);
  });
});

describe('verifyCsrfJws', () => {
  it('needs the header to equal the cookie', async () => {
    const { jwks, mint } = await setup();
    const token = await mint();
    const o = { sid: 'sess_1', issuer, jwks };
    expect(await verifyCsrfJws(req(token, token), o)).toBe(true);
    expect(await verifyCsrfJws(req(token, null), o)).toBe(false);
    expect(await verifyCsrfJws(req(token, await mint()), o)).toBe(false);
    expect(await verifyCsrfJws(req(null, token), o)).toBe(false);
  });
});
