import { describe, expect, it } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { ForbiddenError } from '@atlasauth/backend';
import {
  ATLAS_AUTH_STATE_KEY,
  configFromEnv,
  getAuth,
  rootAuthLoader,
  signedOut,
} from './index';
import type { GetAuthOptions } from './index';

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
// network, and JWKS transport is a stub.
const serving = (jwks: unknown) =>
  (async () => new Response(JSON.stringify(jwks), { status: 200 })) as unknown as typeof fetch;

const opts = (jwks: unknown, extra: Partial<GetAuthOptions> = {}): GetAuthOptions => ({
  jwksUrl: JWKS_URL,
  issuer: ISSUER,
  fetchImpl: serving(jwks),
  ...extra,
});

/** Build a real Web `Request` with the given headers — exactly what a React
 *  Router loader receives as `args.request`. */
const request = (headers: Record<string, string> = {}) =>
  new Request('https://app.example.test/dashboard', { headers });

describe('getAuth', () => {
  it('yields signed-in auth for a valid __session cookie', async () => {
    const { privateKey, jwks } = await keyring();
    const req = request({ cookie: `__session=${await token(privateKey)}` });

    const auth = await getAuth(req, opts(jwks));
    expect(auth.userId).toBe('user_1');
    expect(auth.sessionId).toBe('sess_1');
    expect(auth.isSignedIn).toBe(true);
  });

  it('yields signed-in auth for a valid Bearer token (header wins over cookie)', async () => {
    const { privateKey, jwks } = await keyring();
    // A garbage cookie plus a valid Bearer: the header must win.
    const req = request({
      cookie: '__session=not.a.jwt',
      authorization: `Bearer ${await token(privateKey)}`,
    });

    const auth = await getAuth(req, opts(jwks));
    expect(auth.userId).toBe('user_1');
    expect(auth.isSignedIn).toBe(true);
  });

  it('accepts a React Router loader args object ({ request }) too', async () => {
    const { privateKey, jwks } = await keyring();
    const req = request({ cookie: `__session=${await token(privateKey)}` });

    const auth = await getAuth({ request: req, params: {}, context: {} }, opts(jwks));
    expect(auth.userId).toBe('user_1');
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
    expect(() => auth.protect({ permission: 'org:members:delete' })).toThrow(ForbiddenError);
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
  });

  it('yields signed-out for a token from an unexpected issuer', async () => {
    const { privateKey, jwks } = await keyring();
    const req = request({ cookie: `__session=${await token(privateKey)}` });

    const auth = await getAuth(req, opts(jwks, { issuer: 'https://someone-else.fapi.atlas.test' }));
    expect(auth.userId).toBeNull();
  });
});

describe('configFromEnv', () => {
  it('reads ATLAS_JWKS_URL / ATLAS_ISSUER and parses authorized parties', () => {
    const options = configFromEnv({
      ATLAS_JWKS_URL: JWKS_URL,
      ATLAS_ISSUER: ISSUER,
      ATLAS_AUTHORIZED_PARTIES: 'app-a, app-b ,',
      ATLAS_PUBLISHABLE_KEY: 'pk_test',
    });
    expect(options.jwksUrl).toBe(JWKS_URL);
    expect(options.issuer).toBe(ISSUER);
    expect(options.authorizedParties).toEqual(['app-a', 'app-b']);
    expect(options.publishableKey).toBe('pk_test');
  });

  it('throws an actionable error when a required var is missing', () => {
    expect(() => configFromEnv({ ATLAS_ISSUER: ISSUER })).toThrow(/ATLAS_JWKS_URL/);
    expect(() => configFromEnv({ ATLAS_JWKS_URL: JWKS_URL })).toThrow(/ATLAS_ISSUER/);
    expect(() => configFromEnv({ ATLAS_JWKS_URL: '', ATLAS_ISSUER: ISSUER })).toThrow(
      /ATLAS_JWKS_URL/,
    );
  });

  it('drives getAuth end-to-end when options are omitted (env-configured)', async () => {
    const { privateKey, jwks } = await keyring();
    const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
    const prev = { jwks: proc?.env?.ATLAS_JWKS_URL, iss: proc?.env?.ATLAS_ISSUER };
    if (proc?.env) {
      proc.env.ATLAS_JWKS_URL = JWKS_URL;
      proc.env.ATLAS_ISSUER = ISSUER;
    }
    try {
      const resolved = configFromEnv();
      // Feed the env-derived config an injected JWKS transport so the run stays
      // networkless while still proving env resolution flows into getAuth.
      const req = request({ cookie: `__session=${await token(privateKey)}` });
      const auth = await getAuth(req, { ...resolved, fetchImpl: serving(jwks) });
      expect(auth.userId).toBe('user_1');
    } finally {
      if (proc?.env) {
        proc.env.ATLAS_JWKS_URL = prev.jwks;
        proc.env.ATLAS_ISSUER = prev.iss;
      }
    }
  });
});

describe('signedOut', () => {
  it('has() is always false and protect() always throws', () => {
    const auth = signedOut();
    expect(auth.has({ role: 'admin' })).toBe(false);
    expect(() => auth.protect()).toThrow(ForbiddenError);
  });
});

describe('rootAuthLoader', () => {
  it('returns the serializable auth state when called with args alone', async () => {
    const { privateKey, jwks } = await keyring();
    const req = request({ cookie: `__session=${await token(privateKey)}` });

    const state = await rootAuthLoader({ request: req }, opts(jwks));
    expect(state.userId).toBe('user_1');
    expect(state.isSignedIn).toBe(true);
    // No non-serializable helpers leak into hydration state.
    expect('has' in state).toBe(false);
    expect('protect' in state).toBe(false);
  });

  it('merges auth state into a handler result under the namespaced key', async () => {
    const { privateKey, jwks } = await keyring();
    const req = request({ cookie: `__session=${await token(privateKey)}` });

    const data = await rootAuthLoader(
      { request: req },
      async ({ auth }) => ({ theme: 'dark', signedInUser: auth.userId }),
      opts(jwks),
    );
    expect(data.theme).toBe('dark');
    expect(data.signedInUser).toBe('user_1');
    expect(data[ATLAS_AUTH_STATE_KEY].userId).toBe('user_1');
    expect(data[ATLAS_AUTH_STATE_KEY].isSignedIn).toBe(true);
  });

  it('passes a handler-returned Response through untouched', async () => {
    const { jwks } = await keyring();
    const redirect = new Response(null, { status: 302, headers: { location: '/sign-in' } });

    const result = await rootAuthLoader({ request: request() }, async () => redirect, opts(jwks));
    expect(result).toBe(redirect);
  });

  it('attaches signed-out state for an anonymous request', async () => {
    const { jwks } = await keyring();
    const state = await rootAuthLoader({ request: request() }, opts(jwks));
    expect(state.userId).toBeNull();
    expect(state.isSignedIn).toBe(false);
  });
});
