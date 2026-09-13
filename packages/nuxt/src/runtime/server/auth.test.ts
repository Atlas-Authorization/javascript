import { describe, expect, it } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { AtlasBackend } from '@atlasauth/backend';
import { build, verifyCarriers } from './auth';

/**
 * Exercises the Nitro auth core directly — the pure `verifyCarriers` /
 * `build` surface that `getAtlasAuth(event)` is a thin h3 adapter over. Mirrors
 * the `@atlasauth/nextjs` middleware test: a real RS256 keypair, a fetch that serves
 * the JWKS, and locally-minted tokens.
 */

const ISSUER = 'https://fox.fapi.atlas.test';
const JWKS_URL = `${ISSUER}/.well-known/jwks.json`;

async function keyring() {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'kid-1', alg: 'RS256', use: 'sig' };
  return { privateKey, jwks: { keys: [jwk] } };
}

async function token(privateKey: unknown, claims: Record<string, unknown> = {}) {
  return new SignJWT({ sid: 'sess_1', ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: 'kid-1' })
    .setSubject('user_1')
    .setIssuer(ISSUER)
    .setIssuedAt()
    .setExpirationTime('60s')
    .sign(privateKey as never);
}

const serving = (jwks: unknown) =>
  (async () => new Response(JSON.stringify(jwks), { status: 200 })) as unknown as typeof fetch;

async function backendFor(jwks: unknown) {
  return new AtlasBackend({ jwksUrl: JWKS_URL, issuer: ISSUER, fetchImpl: serving(jwks) });
}

describe('verifyCarriers', () => {
  it('resolves a signed-in state from the __session cookie', async () => {
    const { privateKey, jwks } = await keyring();
    const backend = await backendFor(jwks);
    const jwt = await token(privateKey);

    const auth = await verifyCarriers(backend, { sessionCookie: jwt });

    expect(auth.isSignedIn).toBe(true);
    expect(auth.userId).toBe('user_1');
    expect(auth.sessionId).toBe('sess_1');
    expect(auth.has()).toBe(true);
  });

  it('lets the Authorization header win over the cookie', async () => {
    const { privateKey, jwks } = await keyring();
    const backend = await backendFor(jwks);
    const good = await token(privateKey, { sid: 'from_header' });

    const auth = await verifyCarriers(backend, {
      authorization: `Bearer ${good}`,
      sessionCookie: 'garbage.cookie.token',
    });

    expect(auth.isSignedIn).toBe(true);
    expect(auth.sessionId).toBe('from_header');
  });

  it('returns signed-out (never throws) for a missing token', async () => {
    const { jwks } = await keyring();
    const backend = await backendFor(jwks);

    const auth = await verifyCarriers(backend, {});

    expect(auth.isSignedIn).toBe(false);
    expect(auth.userId).toBeNull();
    expect(auth.has()).toBe(false);
  });

  it('returns signed-out (never throws) for an unverifiable token', async () => {
    const { jwks } = await keyring();
    const backend = await backendFor(jwks);

    const auth = await verifyCarriers(backend, { sessionCookie: 'not.a.jwt' });

    expect(auth.isSignedIn).toBe(false);
  });

  it('surfaces the active org role and permissions', async () => {
    const { privateKey, jwks } = await keyring();
    const backend = await backendFor(jwks);
    const jwt = await token(privateKey, {
      org_id: 'org_1',
      org_role: 'admin',
      org_permissions: ['org:billing:manage'],
    });

    const auth = await verifyCarriers(backend, { sessionCookie: jwt });

    expect(auth.orgId).toBe('org_1');
    expect(auth.orgRole).toBe('admin');
    expect(auth.has({ permission: 'org:billing:manage' })).toBe(true);
    expect(auth.has({ permission: 'org:members:manage' })).toBe(false);
  });
});

describe('build().protect', () => {
  it('is a no-op for a signed-in caller', () => {
    const auth = build({ iss: ISSUER, sub: 'u', sid: 's', exp: 0 });
    expect(() => auth.protect()).not.toThrow();
  });

  it('throws a 401 for an anonymous caller', () => {
    const auth = build(null);
    expect(() => auth.protect()).toThrowError(expect.objectContaining({ statusCode: 401 }));
  });

  it('throws a 403 when signed in but missing the permission', () => {
    const auth = build({
      iss: ISSUER,
      sub: 'u',
      sid: 's',
      exp: 0,
      org_id: 'org_1',
      org_role: 'member',
      org_permissions: [],
    });
    expect(() => auth.protect({ permission: 'org:billing:manage' })).toThrowError(
      expect.objectContaining({ statusCode: 403 }),
    );
  });
});
