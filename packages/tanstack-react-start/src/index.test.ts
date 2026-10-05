import { describe, expect, it } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { ForbiddenError } from '@atlasauth/backend';
import {
  configFromEnv,
  createAtlasHandler,
  fetchAtlasAuth,
  getAuth,
  signedOut,
} from './index';
import type { AtlasAuth } from './index';

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

// A networkless fetch that serves the JWKS — verification never touches a real
// network; JWKS transport is a stub, exactly as in the express adapter's tests.
const serving = (jwks: unknown) =>
  (async () => new Response(JSON.stringify(jwks), { status: 200 })) as unknown as typeof fetch;

/** Build a real Web `Request` carrying the given headers — the shape a TanStack
 *  Start handler / `getWebRequest()` hands you. */
const request = (headers: Record<string, string> = {}): Request =>
  new Request('https://app.example.com/api/me', { headers });

const opts = (jwks: unknown) => ({ jwksUrl: JWKS_URL, issuer: ISSUER, fetchImpl: serving(jwks) });

describe('getAuth', () => {
  it('returns signed-in auth for a valid __session cookie on a Web Request', async () => {
    const { privateKey, jwks } = await keyring();
    const req = request({ cookie: `__session=${await token(privateKey)}` });

    const auth = await getAuth(req, opts(jwks));
    expect(auth.userId).toBe('user_1');
    expect(auth.sessionId).toBe('sess_1');
    expect(auth.isSignedIn).toBe(true);
    expect(auth.has()).toBe(true);
  });

  it('returns signed-in auth for a valid Bearer token (header wins over cookie)', async () => {
    const { privateKey, jwks } = await keyring();
    const req = request({
      authorization: `Bearer ${await token(privateKey)}`,
      cookie: '__session=garbage.cookie.value',
    });

    const auth = await getAuth(req, opts(jwks));
    expect(auth.userId).toBe('user_1');
    expect(auth.isSignedIn).toBe(true);
  });

  it('populates org fields and a working has() from claims', async () => {
    const { privateKey, jwks } = await keyring();
    const req = request({
      cookie: `__session=${await token(privateKey, {
        org_id: 'org_1',
        org_role: 'admin',
        org_permissions: ['org:billing:manage'],
      })}`,
    });

    const auth = await getAuth(req, opts(jwks));
    expect(auth.orgId).toBe('org_1');
    expect(auth.orgRole).toBe('admin');
    expect(auth.has({ permission: 'org:billing:manage' })).toBe(true);
    expect(auth.has({ permission: 'org:members:delete' })).toBe(false);
    // protect() returns the claims for an allowed condition, throws otherwise.
    expect(auth.protect({ role: 'admin' }).sub).toBe('user_1');
    expect(() => auth.protect({ role: 'owner' })).toThrow(ForbiddenError);
  });

  it('yields signed-out for a missing token, and never throws', async () => {
    const { jwks } = await keyring();
    const auth = await getAuth(request(), opts(jwks));
    expect(auth.userId).toBeNull();
    expect(auth.isSignedIn).toBe(false);
    expect(auth.has()).toBe(false);
    expect(() => auth.protect()).toThrow(ForbiddenError);
  });

  it('yields signed-out for an invalid/garbage token (does not throw)', async () => {
    const { jwks } = await keyring();
    const auth = await getAuth(request({ authorization: 'Bearer not.a.jwt' }), opts(jwks));
    expect(auth.userId).toBeNull();
    expect(auth.isSignedIn).toBe(false);
  });

  it('yields signed-out for a token from an unexpected issuer', async () => {
    const { privateKey, jwks } = await keyring();
    const req = request({ cookie: `__session=${await token(privateKey)}` });

    const auth = await getAuth(req, {
      jwksUrl: JWKS_URL,
      issuer: 'https://someone-else.fapi.atlas.test',
      fetchImpl: serving(jwks),
    });
    expect(auth.userId).toBeNull();
  });
});

describe('fetchAtlasAuth', () => {
  it('resolves auth from an injected request getter (server-function idiom)', async () => {
    const { privateKey, jwks } = await keyring();
    const req = request({ cookie: `__session=${await token(privateKey)}` });

    const auth = await fetchAtlasAuth(() => req, opts(jwks));
    expect(auth.userId).toBe('user_1');
    expect(auth.isSignedIn).toBe(true);
  });

  it('awaits an async getter and yields signed-out when there is no request', async () => {
    const { privateKey, jwks } = await keyring();
    const req = request({ authorization: `Bearer ${await token(privateKey)}` });

    expect((await fetchAtlasAuth(async () => req, opts(jwks))).userId).toBe('user_1');
    // No ambient request (called outside a request scope) → signed out, no throw.
    expect((await fetchAtlasAuth(() => null, opts(jwks))).userId).toBeNull();
  });
});

describe('createAtlasHandler', () => {
  it('injects the verified atlasAuth into the Start request context via next()', async () => {
    const { privateKey, jwks } = await keyring();
    const handler = createAtlasHandler(opts(jwks));
    const req = request({ cookie: `__session=${await token(privateKey)}` });

    let injected: AtlasAuth | undefined;
    await handler({
      request: req,
      next: async ({ context }) => {
        injected = context.atlasAuth;
        return { context };
      },
    });

    expect(injected?.userId).toBe('user_1');
    expect(injected?.isSignedIn).toBe(true);
  });

  it('threads a signed-out state (never throws) for a bad token', async () => {
    const { jwks } = await keyring();
    const handler = createAtlasHandler(opts(jwks));

    let injected: AtlasAuth | undefined;
    await handler({
      request: request({ authorization: 'Bearer not.a.jwt' }),
      next: async ({ context }) => {
        injected = context.atlasAuth;
        return { context };
      },
    });

    expect(injected?.userId).toBeNull();
    expect(injected?.isSignedIn).toBe(false);
  });
});

describe('signedOut', () => {
  it('has() is always false and protect() always throws', () => {
    const auth = signedOut();
    expect(auth.has({ role: 'admin' })).toBe(false);
    expect(() => auth.protect()).toThrow(ForbiddenError);
  });
});

describe('configFromEnv', () => {
  it('reads jwksUrl/issuer from the environment', () => {
    const config = configFromEnv({ ATLAS_JWKS_URL: JWKS_URL, ATLAS_ISSUER: ISSUER });
    expect(config.jwksUrl).toBe(JWKS_URL);
    expect(config.issuer).toBe(ISSUER);
    expect(config.authorizedParties).toBeUndefined();
  });

  it('splits ATLAS_AUTHORIZED_PARTIES into a trimmed list', () => {
    const config = configFromEnv({
      ATLAS_JWKS_URL: JWKS_URL,
      ATLAS_ISSUER: ISSUER,
      ATLAS_AUTHORIZED_PARTIES: 'https://a.test, https://b.test ,,https://c.test',
    });
    expect(config.authorizedParties).toEqual(['https://a.test', 'https://b.test', 'https://c.test']);
  });

  it('throws with an actionable message when a required value is absent', () => {
    expect(() => configFromEnv({ ATLAS_ISSUER: ISSUER })).toThrow(/ATLAS_JWKS_URL/);
    expect(() => configFromEnv({ ATLAS_JWKS_URL: JWKS_URL })).toThrow(/ATLAS_ISSUER/);
  });

  it('lets getAuth fall back to env config when options are omitted', async () => {
    const { privateKey, jwks } = await keyring();
    const prev = { url: process.env.ATLAS_JWKS_URL, iss: process.env.ATLAS_ISSUER };
    process.env.ATLAS_JWKS_URL = JWKS_URL;
    process.env.ATLAS_ISSUER = ISSUER;
    try {
      // fetchImpl still injected so no network is touched, but jwksUrl/issuer
      // come from the environment rather than the options object.
      const req = request({ cookie: `__session=${await token(privateKey)}` });
      const auth = await getAuth(req, { fetchImpl: serving(jwks) });
      expect(auth.userId).toBe('user_1');
    } finally {
      process.env.ATLAS_JWKS_URL = prev.url;
      process.env.ATLAS_ISSUER = prev.iss;
    }
  });
});
