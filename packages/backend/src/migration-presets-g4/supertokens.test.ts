import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, jwtVerify } from 'jose';
import { describe, expect, it } from 'vitest';
import { PresetVariableError, cookieNameMatches, getMigrationBridgePreset, resolveMigrationBridgePreset } from '../migration-presets';

/**
 * The SuperTokens preset against a session access token with SuperTokens' claim
 * shapes (v3 access token: `sub`, `sessionHandle`, `refreshTokenHash1`,
 * `parentRefreshTokenHash1`, `antiCsrfToken`, `tId`, `rsub`, `iss`, `st-role`).
 */
const VARS = { base_url: 'https://api.example.com' };

async function accessToken(over: { iss?: string; kid?: string } = {}) {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'd-1700000000000', alg: 'RS256', use: 'sig' };
  const token = await new SignJWT({
    sessionHandle: '5b5ac5a1-3a8a-4c5f-9a7e-9d1f2c3b4a5d',
    refreshTokenHash1: '8c1d1c0f6e8f',
    parentRefreshTokenHash1: null,
    antiCsrfToken: null,
    tId: 'public',
    rsub: '8d9e1f2a-aaaa-bbbb-cccc-000011112222',
    'st-role': { v: ['admin'], t: 1700000000000 },
  })
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT', kid: over.kid ?? 'd-1700000000000', version: '5' } as never)
    .setSubject('8d9e1f2a-aaaa-bbbb-cccc-000011112222')
    .setIssuer(over.iss ?? 'https://api.example.com/auth')
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(privateKey);
  return { token, jwks: createLocalJWKSet({ keys: [jwk] }) };
}

describe('supertokens bridge preset', () => {
  it('resolves the api domain, base path and key set', () => {
    const r = resolveMigrationBridgePreset('supertokens', VARS);
    expect(r).toMatchObject({
      preset: 'supertokens',
      mode: 'jwt',
      issuer: 'https://api.example.com/auth',
      keysUrl: 'https://api.example.com/auth/jwt/jwks.json',
      audience: null,
      algorithms: ['RS256'],
      claims: { subject: 'sub', sessionKey: 'sessionHandle' },
      cookies: ['sAccessToken'],
      bearer: true,
      expiredGraceSeconds: 7 * 24 * 3600,
    });
    expect(r.clearCookies).toEqual(['sAccessToken', 'sRefreshToken', 'sIdRefreshToken', 'sFrontToken']);
    expect(cookieNameMatches(r.cookies[0]!, 'sAccessToken')).toBe(true);
  });

  it('honours a custom apiBasePath', () => {
    const r = resolveMigrationBridgePreset('supertokens', { ...VARS, api_base_path: 'api/auth' });
    expect(r.issuer).toBe('https://api.example.com/api/auth');
    expect(r.keysUrl).toBe('https://api.example.com/api/auth/jwt/jwks.json');
  });

  it('verifies a v3-shaped access token and reads the user and session', async () => {
    const r = resolveMigrationBridgePreset('supertokens', VARS);
    const { token, jwks } = await accessToken();
    const { payload } = await jwtVerify(token, jwks, { issuer: r.issuer!, algorithms: r.algorithms });
    expect(payload[r.claims.subject]).toBe('8d9e1f2a-aaaa-bbbb-cccc-000011112222');
    expect(payload[r.claims.sessionKey!]).toBe('5b5ac5a1-3a8a-4c5f-9a7e-9d1f2c3b4a5d');
  });

  it('refuses another app\'s issuer', async () => {
    const r = resolveMigrationBridgePreset('supertokens', VARS);
    const { token, jwks } = await accessToken({ iss: 'https://api.other.example/auth' });
    await expect(jwtVerify(token, jwks, { issuer: r.issuer!, algorithms: r.algorithms })).rejects.toThrow();
  });

  it('needs the api domain over https', () => {
    expect(() => resolveMigrationBridgePreset('supertokens', {})).toThrow(PresetVariableError);
    expect(() => resolveMigrationBridgePreset('supertokens', { base_url: 'api.example.com' })).toThrow(/https URL/);
    expect(getMigrationBridgePreset('supertokens')?.label).toBe('SuperTokens');
  });
});
