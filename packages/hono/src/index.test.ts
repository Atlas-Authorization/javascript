import { describe, expect, it } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { AtlasBackend } from '@atlasauth/backend';
import {
  ATLAS_CONTEXT_KEY,
  SESSION_COOKIE,
  SIGNED_OUT,
  atlasMiddleware,
  getAuth,
  resolveAuth,
  type AtlasAuth,
  type HonoContextLike,
} from './index';

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

// Stub the JWKS fetch — no network. Matches how @atlasauth/nextjs tests serve keys.
const serving = (jwks: unknown) =>
  (async () => new Response(JSON.stringify(jwks), { status: 200 })) as unknown as typeof fetch;

const backendFor = (jwks: unknown) =>
  new AtlasBackend({ jwksUrl: JWKS_URL, issuer: ISSUER, fetchImpl: serving(jwks) });

/**
 * A minimal fake of the Hono `Context` surface the adapter touches:
 * `c.req.header(name)`, plus the `c.get`/`c.set` variable store.
 */
function fakeContext(headers: Record<string, string> = {}): HonoContextLike & {
  store: Map<string, unknown>;
} {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  const store = new Map<string, unknown>();
  return {
    store,
    req: { header: (name: string) => lower[name.toLowerCase()] },
    get: (key: string) => store.get(key),
    set: (key: string, value: unknown) => {
      store.set(key, value);
    },
  };
}

describe('resolveAuth', () => {
  it('reads a bearer token', async () => {
    const { privateKey, jwks } = await keyring();
    const state = await resolveAuth(
      backendFor(jwks),
      fakeContext({ authorization: `Bearer ${await token(privateKey)}` }),
    );
    expect(state.userId).toBe('user_1');
    expect(state.sessionId).toBe('sess_1');
  });

  it('reads the __session cookie', async () => {
    const { privateKey, jwks } = await keyring();
    const state = await resolveAuth(
      backendFor(jwks),
      fakeContext({ cookie: `a=b; ${SESSION_COOKIE}=${await token(privateKey)}` }),
    );
    expect(state.userId).toBe('user_1');
  });

  it('prefers the Authorization header over the cookie', async () => {
    const { privateKey, jwks } = await keyring();
    const headerToken = await token(privateKey, { sid: 'sess_header' });
    const cookieToken = await token(privateKey, { sid: 'sess_cookie' });
    const state = await resolveAuth(
      backendFor(jwks),
      fakeContext({
        authorization: `Bearer ${headerToken}`,
        cookie: `${SESSION_COOKIE}=${cookieToken}`,
      }),
    );
    expect(state.sessionId).toBe('sess_header');
  });

  it('carries organization claims through', async () => {
    const { privateKey, jwks } = await keyring();
    const state = await resolveAuth(
      backendFor(jwks),
      fakeContext({
        cookie: `${SESSION_COOKIE}=${await token(privateKey, {
          org_id: 'org_1',
          org_role: 'org:admin',
        })}`,
      }),
    );
    expect(state.orgId).toBe('org_1');
    expect(state.orgRole).toBe('org:admin');
  });

  /**
   * A middleware that throws takes the whole route down. Treating an
   * unverifiable token as "not signed in" degrades to the signed-out path.
   */
  it('treats an unverifiable token as signed out rather than throwing', async () => {
    const { jwks } = await keyring();
    const state = await resolveAuth(
      backendFor(jwks),
      fakeContext({ cookie: `${SESSION_COOKIE}=garbage` }),
    );
    expect(state.userId).toBeNull();
    expect(state.claims).toBeNull();
  });

  it('reports signed out when nothing is carried', async () => {
    const { jwks } = await keyring();
    const state = await resolveAuth(backendFor(jwks), fakeContext());
    expect(state.userId).toBeNull();
  });
});

describe('atlasMiddleware + getAuth', () => {
  it('stores a verified auth object on the context', async () => {
    const { privateKey, jwks } = await keyring();
    const c = fakeContext({ authorization: `Bearer ${await token(privateKey)}` });
    let nextCalled = false;

    await atlasMiddleware({ jwksUrl: JWKS_URL, issuer: ISSUER, fetchImpl: serving(jwks) })(
      c,
      async () => {
        nextCalled = true;
      },
    );

    expect(nextCalled).toBe(true);
    const auth = getAuth(c);
    expect(auth.userId).toBe('user_1');
    expect(auth.isSignedIn).toBe(true);
    expect(c.store.get(ATLAS_CONTEXT_KEY)).toBe(auth);
  });

  it('stores a signed-out object for a bad token (never throws)', async () => {
    const { jwks } = await keyring();
    const c = fakeContext({ cookie: `${SESSION_COOKIE}=garbage` });

    await expect(
      atlasMiddleware({ jwksUrl: JWKS_URL, issuer: ISSUER, fetchImpl: serving(jwks) })(
        c,
        async () => {},
      ),
    ).resolves.toBeUndefined();

    expect(getAuth(c).userId).toBeNull();
  });

  it('getAuth returns SIGNED_OUT when the middleware never ran', () => {
    const auth = getAuth(fakeContext());
    expect(auth).toBe(SIGNED_OUT);
    expect(auth.isSignedIn).toBe(false);
  });
});

describe('has / protect helpers', () => {
  it('has() answers permission conditions from the token', async () => {
    const { privateKey, jwks } = await keyring();
    const auth: AtlasAuth = await resolveAuth(
      backendFor(jwks),
      fakeContext({
        authorization: `Bearer ${await token(privateKey, {
          org_id: 'org_1',
          org_role: 'org:admin',
          org_permissions: ['org:billing:manage'],
        })}`,
      }),
    );
    expect(auth.has({ permission: 'org:billing:manage' })).toBe(true);
    expect(auth.has({ permission: 'org:billing:delete' })).toBe(false);
  });

  it('protect() throws for a signed-out caller', () => {
    expect(() => SIGNED_OUT.protect()).toThrow();
  });

  it('has() is false and protect() throws on the signed-out object', () => {
    expect(SIGNED_OUT.has()).toBe(false);
    expect(() => SIGNED_OUT.protect({ permission: 'x' })).toThrow();
  });
});
