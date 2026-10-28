import { describe, expect, it } from 'vitest';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, jwtVerify } from 'jose';
import { getMigrationBridgePreset, resolveMigrationBridgePreset } from '../migration-presets';

/** An ID token shaped like authentik's (authentik/providers/oauth2/id_token.py). */
async function token(alg: 'RS256' | 'ES256' = 'RS256') {
  const { publicKey, privateKey } = await generateKeyPair(alg);
  const jwk = { ...(await exportJWK(publicKey)), kid: '6a1e2b3c4d5e6f708192a3b4c5d6e7f8', alg };
  const jwt = await new SignJWT({
    sub: '3d8f0b6c1e7a4f5d9b2c8a1e6f0d4c7b9a5e3f1d2c8b7a6e5f4d3c2b1a09f8e7',
    auth_time: 1_790_000_000,
    acr: 'goauthentik.io/providers/oauth2/default',
    amr: ['pwd', 'mfa'],
    sid: 'f1e2d3c4b5a6978877665544332211009f8e7d6c5b4a39281706f5e4d3c2b1a0',
    email: 'ada@example.com',
    email_verified: true,
    name: 'Ada Lovelace',
    given_name: 'Ada Lovelace',
    preferred_username: 'ada',
    groups: ['Engineering'],
  })
    .setProtectedHeader({ alg, kid: jwk.kid, typ: 'JWT' })
    .setIssuer('https://auth.example.com/application/o/grafana/')
    .setAudience('grafana')
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(privateKey);
  return { jwt, keys: createLocalJWKSet({ keys: [jwk] }) };
}

const VARS = { issuer: 'https://auth.example.com/application/o/grafana', client_id: 'grafana' };

describe('authentik bridge preset', () => {
  it('is registered under the vendor id as a jwt preset', () => {
    expect(getMigrationBridgePreset('authentik')?.mode).toBe('jwt');
  });

  it('keeps the issuer slash authentik puts in iss and finds the keys under it', () => {
    const r = resolveMigrationBridgePreset('authentik', { ...VARS, issuer: 'https://auth.example.com/application/o/grafana/' });
    expect(r.issuer).toBe('https://auth.example.com/application/o/grafana/');
    expect(r.keysUrl).toBe('https://auth.example.com/application/o/grafana/jwks/');
    expect(r.audience).toEqual(['grafana']);
    expect(r.claims).toMatchObject({ subject: 'sub', sessionKey: 'sid', email: 'email' });
    expect(r.cookies).toEqual([]);
    expect(r.bearer).toBe(true);
  });

  it.each(['RS256', 'ES256'] as const)('accepts a %s provider token', async (alg) => {
    const { jwt, keys } = await token(alg);
    const r = resolveMigrationBridgePreset('authentik', VARS);
    const { payload } = await jwtVerify(jwt, keys, { issuer: r.issuer!, audience: r.audience!, algorithms: r.algorithms });
    expect(payload[r.claims.subject]).toMatch(/^[0-9a-f]{64}$/);
    expect(payload[r.claims.sessionKey!]).toBeTruthy();
  });

  it('refuses a token from another provider or signed with the client secret', async () => {
    const { jwt, keys } = await token();
    const r = resolveMigrationBridgePreset('authentik', { ...VARS, issuer: 'https://auth.example.com/application/o/other' });
    await expect(jwtVerify(jwt, keys, { issuer: r.issuer!, audience: r.audience!, algorithms: r.algorithms })).rejects.toThrow();
    expect(r.algorithms).not.toContain('HS256');
  });

  it('needs both variables', () => {
    expect(() => resolveMigrationBridgePreset('authentik', { issuer: VARS.issuer })).toThrow(/client_id/);
    expect(() => resolveMigrationBridgePreset('authentik', { client_id: 'x' })).toThrow(/issuer/);
  });
});
