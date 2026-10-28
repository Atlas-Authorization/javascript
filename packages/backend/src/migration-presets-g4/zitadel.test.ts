import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, jwtVerify } from 'jose';
import { describe, expect, it } from 'vitest';
import { PresetVariableError, getMigrationBridgePreset, resolveMigrationBridgePreset } from '../migration-presets';

/**
 * The ZITADEL preset against a token shaped like the ones ZITADEL issues (an
 * ID token: iss, sub = user id, aud = [client id, project id], sid, amr, the
 * profile and `urn:zitadel:iam:*` claims; a JWT access token has client_id
 * and jti instead of the profile).
 */

const ISSUER = 'https://acme-abc123.zitadel.cloud';

async function issue(claims: Record<string, unknown>, opts: { iss?: string; exp?: string | number } = {}) {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: '259394555590164482', alg: 'RS256', use: 'sig' };
  const token = await new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: jwk.kid, typ: 'JWT' })
    .setIssuer(opts.iss ?? ISSUER)
    .setIssuedAt()
    .setExpirationTime(opts.exp ?? '12h')
    .sign(privateKey);
  return { token, keys: createLocalJWKSet({ keys: [jwk] }) };
}

const ID_TOKEN = {
  sub: '259394710217244418',
  aud: ['259394780999843073', '259394710217244499'],
  azp: '259394780999843073',
  client_id: '259394780999843073',
  auth_time: 1760000000,
  amr: ['password', 'pwd', 'mfa'],
  sid: 'V2_259399163458666498',
  email: 'jane@acme.com',
  email_verified: true,
  name: 'Jane Doe',
  given_name: 'Jane',
  family_name: 'Doe',
  preferred_username: 'jane@acme.com',
  'urn:zitadel:iam:user:resourceowner:id': '259394555590164482',
  'urn:zitadel:iam:org:project:roles': { admin: { '259394555590164482': 'acme.zitadel.cloud' } },
};

describe('ZITADEL bridge preset', () => {
  it('replaced the starter and resolves the issuer, keys and claims from the instance URL', () => {
    expect(getMigrationBridgePreset('zitadel')?.mode).toBe('jwt');
    const r = resolveMigrationBridgePreset('zitadel', { issuer: `${ISSUER}/` });
    expect(r).toMatchObject({
      mode: 'jwt',
      issuer: ISSUER,
      keysUrl: `${ISSUER}/oauth/v2/keys`,
      keysFormat: 'jwks',
      bearer: true,
      cookies: [],
      audience: null,
      expiredGraceSeconds: 7 * 24 * 3600,
      claims: { subject: 'sub', email: 'email', emailVerified: 'email_verified', name: 'name', sessionKey: 'sid', mfa: 'amr:mfa' },
    });
    expect(r.algorithms).toContain('RS256');
  });

  it('accepts a real-shaped ID token, whose sub is the ZITADEL user id the export keys users by', async () => {
    const { token, keys } = await issue(ID_TOKEN);
    const r = resolveMigrationBridgePreset('zitadel', { issuer: ISSUER });
    const { payload } = await jwtVerify(token, keys, { issuer: r.issuer!, algorithms: r.algorithms });
    expect(payload[r.claims.subject]).toBe('259394710217244418');
    expect(payload[r.claims.sessionKey!]).toBe('V2_259399163458666498');
    expect(payload[r.claims.email!]).toBe('jane@acme.com');
    expect((payload.amr as string[]).includes('mfa')).toBe(true);
  });

  it('accepts a JWT access token (no profile claims, jti instead of sid)', async () => {
    const { token, keys } = await issue({ sub: '259394710217244418', aud: ['259394780999843073'], client_id: '259394780999843073', scope: 'openid', jti: 'V2_259399163458666499' });
    const r = resolveMigrationBridgePreset('zitadel', { issuer: ISSUER });
    const { payload } = await jwtVerify(token, keys, { issuer: r.issuer!, algorithms: r.algorithms });
    expect(payload.sub).toBe('259394710217244418');
    // No sid: the server spends the whole token in the single-use ledger.
    expect(payload[r.claims.sessionKey!]).toBeUndefined();
  });

  it('refuses a token from another instance or signed with another algorithm', async () => {
    const { token, keys } = await issue(ID_TOKEN, { iss: 'https://evil.example.com' });
    const r = resolveMigrationBridgePreset('zitadel', { issuer: ISSUER });
    await expect(jwtVerify(token, keys, { issuer: r.issuer!, algorithms: r.algorithms })).rejects.toThrow();
    expect(r.algorithms).not.toContain('HS256');
    expect(r.algorithms).not.toContain('none');
  });

  it('works with a custom domain and refuses a missing or non-https issuer', () => {
    expect(resolveMigrationBridgePreset('zitadel', { issuer: 'https://login.acme.com' })).toMatchObject({ issuer: 'https://login.acme.com', keysUrl: 'https://login.acme.com/oauth/v2/keys' });
    expect(() => resolveMigrationBridgePreset('zitadel', {})).toThrow(PresetVariableError);
    expect(() => resolveMigrationBridgePreset('zitadel', { issuer: 'http://login.acme.com' })).toThrow(PresetVariableError);
  });
});
