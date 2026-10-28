import { describe, expect, it } from 'vitest';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, jwtVerify } from 'jose';
import { cookieNameMatches, getMigrationBridgePreset, resolveMigrationBridgePreset } from '../migration-presets';

/** A session JWT shaped like Hanko's (backend/session: sub, session_id, email object). */
async function token(iss: string) {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'hanko-key-1', alg: 'RS256' };
  const jwt = await new SignJWT({
    session_id: 'd8d6dc27-fcf9-4a5c-bb50-a7a03067d936',
    email: { address: 'john.doe@example.com', is_primary: true, is_verified: true },
    username: 'jdoe',
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'hanko-key-1', typ: 'JWT' })
    .setSubject('b5dd5267-b462-48be-b70d-bcd6f1bbe7a5')
    .setIssuer(iss)
    .setAudience('example.com')
    .setIssuedAt()
    .setExpirationTime('12h')
    .sign(privateKey);
  return { jwt, keys: createLocalJWKSet({ keys: [jwk] }) };
}

describe('hanko bridge presets', () => {
  it('are registered as jwt presets', () => {
    expect(getMigrationBridgePreset('hanko')?.mode).toBe('jwt');
    expect(getMigrationBridgePreset('hanko_jwt')?.mode).toBe('jwt');
  });

  it('hanko: issuer is the API URL, keys come from /.well-known/jwks.json, the cookie is hanko', async () => {
    const r = resolveMigrationBridgePreset('hanko', { base_url: 'https://f4c1.hanko.io/' });
    expect(r.issuer).toBe('https://f4c1.hanko.io');
    expect(r.keysUrl).toBe('https://f4c1.hanko.io/.well-known/jwks.json');
    expect(r.cookies.some((c) => cookieNameMatches(c, 'hanko'))).toBe(true);
    expect(r.claims).toMatchObject({ subject: 'sub', sessionKey: 'session_id' });
    const { jwt, keys } = await token('https://f4c1.hanko.io');
    const { payload } = await jwtVerify(jwt, keys, { issuer: r.issuer!, algorithms: r.algorithms });
    expect(payload[r.claims.subject]).toBe('b5dd5267-b462-48be-b70d-bcd6f1bbe7a5');
    expect(payload[r.claims.sessionKey!]).toBe('d8d6dc27-fcf9-4a5c-bb50-a7a03067d936');
  });

  it('hanko_jwt: a custom session.issuer with keys from the API URL', async () => {
    const r = resolveMigrationBridgePreset('hanko_jwt', { base_url: 'https://hanko.example.com', issuer: 'https://example.com' });
    expect(r.issuer).toBe('https://example.com');
    expect(r.keysUrl).toBe('https://hanko.example.com/.well-known/jwks.json');
    const { jwt, keys } = await token('https://example.com');
    await expect(jwtVerify(jwt, keys, { issuer: r.issuer!, algorithms: r.algorithms })).resolves.toBeTruthy();
    await expect(jwtVerify(jwt, keys, { issuer: 'https://other.example', algorithms: r.algorithms })).rejects.toThrow();
  });

  it('refuses an http API URL and a missing variable', () => {
    expect(() => resolveMigrationBridgePreset('hanko', { base_url: 'http://hanko.local' })).toThrow(/base_url/);
    expect(() => resolveMigrationBridgePreset('hanko_jwt', { base_url: 'https://hanko.example.com' })).toThrow(/issuer/);
  });
});
