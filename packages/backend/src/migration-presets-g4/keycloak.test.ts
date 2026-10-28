import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, jwtVerify } from 'jose';
import { describe, expect, it } from 'vitest';
import { getMigrationBridgePreset, resolveMigrationBridgePreset } from '../migration-presets';

/** A Keycloak access token with the claims Keycloak 24+ writes (realm_access, azp, sid, acr, scope, preferred_username). */
async function token(iss: string) {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'kc1', alg: 'RS256', use: 'sig' };
  const jwt = await new SignJWT({
    typ: 'Bearer',
    azp: 'acme-web',
    sid: '5c2bd0f9-1f0f-4b0b-a1b0-0a4f2c8e1b11',
    acr: '1',
    realm_access: { roles: ['default-roles-acme', 'admin'] },
    scope: 'openid email profile',
    email_verified: true,
    name: 'Jane Doe',
    preferred_username: 'jane',
    email: 'jane@acme.example',
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'kc1', typ: 'JWT' })
    .setSubject('b1f2c3d4-0000-4000-8000-00000000jane')
    .setJti('onrtac:1')
    .setIssuer(iss)
    .setAudience('account')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey);
  return { jwt, keys: createLocalJWKSet({ keys: [jwk] }) };
}

describe('keycloak bridge preset', () => {
  it('resolves the realm issuer and JWKS URL and accepts a Keycloak access token', async () => {
    const r = resolveMigrationBridgePreset('keycloak', { base_url: 'https://sso.example.com', realm: 'acme' });
    expect(r.issuer).toBe('https://sso.example.com/realms/acme');
    expect(r.keysUrl).toBe('https://sso.example.com/realms/acme/protocol/openid-connect/certs');
    const { jwt, keys } = await token(r.issuer!);
    const { payload } = await jwtVerify(jwt, keys, { issuer: r.issuer!, algorithms: r.algorithms });
    expect(payload[r.claims.subject]).toBe('b1f2c3d4-0000-4000-8000-00000000jane');
    expect(payload[r.claims.sessionKey!]).toBe('5c2bd0f9-1f0f-4b0b-a1b0-0a4f2c8e1b11');
    expect(payload[r.claims.email!]).toBe('jane@acme.example');
  });
  it('supports the /auth base path of Keycloak 16 and older', () => {
    expect(resolveMigrationBridgePreset('keycloak', { base_url: 'https://sso.example.com/auth', realm: 'acme' }).issuer).toBe('https://sso.example.com/auth/realms/acme');
  });
  it('refuses a token from another realm or signed with HS512, and a missing realm', async () => {
    const r = resolveMigrationBridgePreset('keycloak', { base_url: 'https://sso.example.com', realm: 'acme' });
    expect(r.algorithms).not.toContain('HS512');
    const { jwt, keys } = await token('https://sso.example.com/realms/other');
    await expect(jwtVerify(jwt, keys, { issuer: r.issuer!, algorithms: r.algorithms })).rejects.toThrow();
    expect(() => resolveMigrationBridgePreset('keycloak', { base_url: 'https://sso.example.com' })).toThrow(/realm/);
  });
  it('reads no cookie (KEYCLOAK_IDENTITY is signed with the realm secret) and takes Bearer tokens', () => {
    const p = getMigrationBridgePreset('keycloak')!;
    expect(p.cookies).toEqual([]);
    expect(p.bearer).toBe(true);
  });
});
