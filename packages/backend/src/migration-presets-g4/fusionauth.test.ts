import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, jwtVerify } from 'jose';
import { describe, expect, it } from 'vitest';
import { resolveMigrationBridgePreset } from '../migration-presets';

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

describe('fusionauth bridge presets', () => {
  it('accepts an access token whose issuer is the tenant issuer string', async () => {
    const r = resolveMigrationBridgePreset('fusionauth', { base_url: 'https://auth.example.com', issuer_name: 'acme.com' });
    expect(r.issuer).toBe('acme.com');
    expect(r.keysUrl).toBe('https://auth.example.com/.well-known/jwks.json');
    expect(r.cookies).toEqual(['app.at']);
    const { jwt, keys } = await token('acme.com');
    const { payload } = await jwtVerify(jwt, keys, { issuer: r.issuer!, algorithms: r.algorithms });
    expect(payload.sub).toBeTruthy();
    expect(r.algorithms).not.toContain('HS256');
  });
  it('has a URL-issuer variant', () => {
    const r = resolveMigrationBridgePreset('fusionauth_url_issuer', { base_url: 'https://auth.example.com' });
    expect(r.issuer).toBe('https://auth.example.com');
  });
});
