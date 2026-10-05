import { afterEach, describe, expect, it } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { ForbiddenError } from '@atlasauth/backend';
import { atlasAstro } from './index';
import { atlasMiddleware, getAuth, signedOut } from './server';
import type { AtlasAPIContext, AtlasMiddlewareNext } from './server';

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

// A networkless fetch that serves the JWKS — the middleware never touches a real
// network, and JWKS transport is a stub.
const serving = (jwks: unknown) =>
  (async () => new Response(JSON.stringify(jwks), { status: 200 })) as unknown as typeof fetch;

/** A fake Astro `APIContext` carrying the given request headers. */
function context(headers: Record<string, string> = {}): AtlasAPIContext {
  const lower = new Map(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v] as const),
  );
  return {
    request: { headers: { get: (name: string) => lower.get(name.toLowerCase()) ?? null } },
    locals: {},
  };
}

/** A `next()` that returns a sentinel Response so we can assert it ran. */
const NEXT_BODY = 'downstream';
const next: AtlasMiddlewareNext = () => new Response(NEXT_BODY, { status: 200 });

// Reach process.env without requiring @types/node (tsconfig sets types: []).
const env = (globalThis as { process: { env: Record<string, string | undefined> } }).process.env;

afterEach(() => {
  delete env.ATLAS_JWKS_URL;
  delete env.ATLAS_ISSUER;
  delete env.ATLAS_AUTHORIZED_PARTIES;
});

describe('atlasMiddleware', () => {
  it('attaches signed-in auth for a valid __session cookie and calls next()', async () => {
    const { privateKey, jwks } = await keyring();
    const mw = atlasMiddleware({ jwksUrl: JWKS_URL, issuer: ISSUER, fetchImpl: serving(jwks) });

    const ctx = context({ cookie: `__session=${await token(privateKey)}` });
    const res = await mw(ctx, next);

    expect(await (res as Response).text()).toBe(NEXT_BODY);
    const auth = getAuth(ctx);
    expect(auth.userId).toBe('user_1');
    expect(auth.sessionId).toBe('sess_1');
    expect(auth.isSignedIn).toBe(true);
  });

  it('attaches signed-in auth for a valid Bearer token (header wins)', async () => {
    const { privateKey, jwks } = await keyring();
    const mw = atlasMiddleware({ jwksUrl: JWKS_URL, issuer: ISSUER, fetchImpl: serving(jwks) });

    const ctx = context({ authorization: `Bearer ${await token(privateKey)}` });
    await mw(ctx, next);

    expect(getAuth(ctx).userId).toBe('user_1');
  });

  it('populates org fields and a working has() from claims', async () => {
    const { privateKey, jwks } = await keyring();
    const mw = atlasMiddleware({ jwksUrl: JWKS_URL, issuer: ISSUER, fetchImpl: serving(jwks) });

    const ctx = context({
      cookie: `__session=${await token(privateKey, {
        org_id: 'org_1',
        org_role: 'admin',
        org_permissions: ['org:billing:manage'],
      })}`,
    });
    await mw(ctx, next);

    const auth = getAuth(ctx);
    expect(auth.orgId).toBe('org_1');
    expect(auth.orgRole).toBe('admin');
    expect(auth.has({ permission: 'org:billing:manage' })).toBe(true);
    expect(auth.has({ permission: 'org:members:delete' })).toBe(false);
    expect(auth.protect({ role: 'admin' })).toBeTruthy();
  });

  it('yields signed-out for a missing token, and never throws', async () => {
    const { jwks } = await keyring();
    const mw = atlasMiddleware({ jwksUrl: JWKS_URL, issuer: ISSUER, fetchImpl: serving(jwks) });

    const ctx = context();
    const res = await mw(ctx, next);

    expect(await (res as Response).text()).toBe(NEXT_BODY);
    const auth = getAuth(ctx);
    expect(auth.userId).toBeNull();
    expect(auth.isSignedIn).toBe(false);
    expect(auth.has()).toBe(false);
    expect(() => auth.protect()).toThrow(ForbiddenError);
  });

  it('yields signed-out for an invalid/garbage token (does not throw)', async () => {
    const { jwks } = await keyring();
    const mw = atlasMiddleware({ jwksUrl: JWKS_URL, issuer: ISSUER, fetchImpl: serving(jwks) });

    const ctx = context({ authorization: 'Bearer not.a.jwt' });
    await mw(ctx, next);

    expect(getAuth(ctx).userId).toBeNull();
  });

  it('yields signed-out for a token from an unexpected issuer', async () => {
    const { privateKey, jwks } = await keyring();
    const mw = atlasMiddleware({
      jwksUrl: JWKS_URL,
      issuer: 'https://someone-else.fapi.atlas.test',
      fetchImpl: serving(jwks),
    });

    const ctx = context({ cookie: `__session=${await token(privateKey)}` });
    await mw(ctx, next);

    expect(getAuth(ctx).userId).toBeNull();
  });

  it('reads config from the environment (ATLAS_JWKS_URL / ATLAS_ISSUER)', async () => {
    const { privateKey, jwks } = await keyring();
    env.ATLAS_JWKS_URL = JWKS_URL;
    env.ATLAS_ISSUER = ISSUER;

    // No jwksUrl/issuer options: they must come from the environment.
    const mw = atlasMiddleware({ fetchImpl: serving(jwks) });
    const ctx = context({ cookie: `__session=${await token(privateKey)}` });
    await mw(ctx, next);

    expect(getAuth(ctx).userId).toBe('user_1');
  });

  it('throws a clear error when neither options nor env supply config', () => {
    expect(() => atlasMiddleware()).toThrow(/ATLAS_JWKS_URL/);
  });
});

describe('getAuth', () => {
  it('returns the signed-out default when the middleware never ran', () => {
    const auth = getAuth(context());
    expect(auth.userId).toBeNull();
    expect(auth.isSignedIn).toBe(false);
    expect(auth.has()).toBe(false);
  });
});

describe('signedOut', () => {
  it('has() is always false and protect() always throws', () => {
    const auth = signedOut();
    expect(auth.has({ role: 'admin' })).toBe(false);
    expect(() => auth.protect()).toThrow(ForbiddenError);
  });
});

describe('atlasAstro integration', () => {
  it('returns a minimal, well-formed AstroIntegration', () => {
    const integration = atlasAstro();
    expect(integration.name).toBe('@atlasauth/astro');
    expect(integration.hooks).toEqual({});
  });
});
