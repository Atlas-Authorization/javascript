import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, jwtVerify } from 'jose';
import { describe, expect, it } from 'vitest';
import { PresetVariableError, getMigrationBridgePreset, resolveMigrationBridgePreset } from '../migration-presets';

/**
 * The Logto preset against a token with Logto's claim shapes: an ES384 ID token
 * from `{endpoint}/oidc`, audience = the application id, `sid`, `at_hash`.
 */
const VARS = { base_url: 'https://auth.example.com/', client_id: 'k3xm9p2wq7abc' };

async function idToken(claims: Record<string, unknown> = {}, over: { iss?: string; aud?: string } = {}) {
  const { publicKey, privateKey } = await generateKeyPair('ES384');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'logto-key-1', alg: 'ES384', use: 'sig' };
  const token = await new SignJWT({
    name: 'Ada Lovelace',
    picture: 'https://cdn.example/ada.png',
    username: 'ada',
    role_names: ['admin'],
    email: 'Ada@Example.com',
    email_verified: true,
    at_hash: 'x1y2z3',
    sid: 'sess_8f2c',
    ...claims,
  })
    .setProtectedHeader({ alg: 'ES384', kid: 'logto-key-1' })
    .setSubject('u1ada')
    .setIssuer(over.iss ?? 'https://auth.example.com/oidc')
    .setAudience(over.aud ?? VARS.client_id)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(privateKey);
  return { token, jwks: createLocalJWKSet({ keys: [jwk] }) };
}

describe('logto bridge preset', () => {
  it('resolves the tenant issuer, key set and audience', () => {
    const r = resolveMigrationBridgePreset('logto', VARS);
    expect(r).toMatchObject({
      preset: 'logto',
      mode: 'jwt',
      issuer: 'https://auth.example.com/oidc',
      keysUrl: 'https://auth.example.com/oidc/jwks',
      audience: ['k3xm9p2wq7abc'],
      claims: { subject: 'sub', email: 'email', emailVerified: 'email_verified', name: 'name', sessionKey: 'sid' },
      bearer: true,
    });
    expect(r.algorithms).toContain('ES384');
    expect(r.algorithms).not.toContain('none');
    expect(r.cookies).toEqual([]);
  });

  it('verifies a token shaped like Logto\'s ID token and reads the claims the preset names', async () => {
    const r = resolveMigrationBridgePreset('logto', VARS);
    const { token, jwks } = await idToken();
    const { payload } = await jwtVerify(token, jwks, { issuer: r.issuer!, audience: r.audience!, algorithms: r.algorithms });
    expect(payload[r.claims.subject]).toBe('u1ada');
    expect(payload[r.claims.email!]).toBe('Ada@Example.com');
    expect(payload[r.claims.emailVerified!]).toBe(true);
    expect(payload[r.claims.name!]).toBe('Ada Lovelace');
    expect(payload[r.claims.sessionKey!]).toBe('sess_8f2c');
  });

  it('refuses another tenant\'s issuer, another application\'s audience and a Cloud tenant mix-up', async () => {
    const r = resolveMigrationBridgePreset('logto', VARS);
    const options = { issuer: r.issuer!, audience: r.audience!, algorithms: r.algorithms };
    for (const over of [{ iss: 'https://other.logto.app/oidc' }, { aud: 'someone-elses-app' }, { iss: 'https://auth.example.com' }]) {
      const { token, jwks } = await idToken({}, over);
      await expect(jwtVerify(token, jwks, options)).rejects.toThrow();
    }
  });

  it('fills a Logto Cloud endpoint and needs both variables', () => {
    expect(resolveMigrationBridgePreset('logto', { base_url: 'https://abc123.logto.app', client_id: 'app' }).keysUrl).toBe('https://abc123.logto.app/oidc/jwks');
    expect(() => resolveMigrationBridgePreset('logto', { base_url: 'https://auth.example.com' })).toThrow(PresetVariableError);
    expect(() => resolveMigrationBridgePreset('logto', { base_url: 'auth.example.com', client_id: 'a' })).toThrow(/https URL/);
  });

  it('is the preset the logto source profile names', () => {
    expect(getMigrationBridgePreset('logto')?.label).toBe('Logto');
  });
});
