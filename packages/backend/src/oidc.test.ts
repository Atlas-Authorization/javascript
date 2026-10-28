import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AtlasOidcError, oidc, oidcCallback, oidcLogoutUrl, oidcStart, resetOidcCaches } from './oidc';
import { AtlasBackend } from './verify';
import { TEST_TOKEN_TAMPERS, createTestIssuer, type TestIssuer } from './testing';

// Every test here starts its own test issuer, which generates a fresh RSA key
// (that is the published helper's contract). RSA generation takes a random and,
// on a loaded machine, multi-second stretch of CPU, so the default 5 s budget
// measured the machine rather than the flow; nothing here asserts on speed.
vi.setConfig({ testTimeout: 30_000 });

/**
 * The relying-party flow end to end against the offline test issuer: start →
 * the fake authorization server → callback → verified identity. No network.
 */

const REDIRECT = 'https://app.example.com/auth/callback';
const SECRET = 'a-test-secret-that-is-at-least-32-characters';

beforeEach(() => resetOidcCaches());

async function signIn(
  fx: TestIssuer,
  opts: {
    authorize?: Parameters<TestIssuer['authorize']>[1];
    clientSecret?: string;
    clientAuth?: 'client_secret_basic' | 'client_secret_post' | 'none';
    secret?: string | null;
    scope?: string;
  } = {},
) {
  const secret = opts.secret === null ? undefined : (opts.secret ?? SECRET);
  const started = await oidcStart({
    issuer: fx.issuer,
    clientId: fx.clientId,
    redirectUri: REDIRECT,
    scope: opts.scope,
    secret,
    fetchImpl: fx.fetch,
  });
  const back = await fx.authorize(started.url, opts.authorize);
  const cookieHeader = `other=1; ${started.cookie.split(';')[0]}`;
  const run = () =>
    oidcCallback({
      issuer: fx.issuer,
      clientId: fx.clientId,
      clientSecret: opts.clientSecret,
      clientAuth: opts.clientAuth,
      redirectUri: REDIRECT,
      query: back.callbackUrl,
      cookie: cookieHeader,
      secret,
      fetchImpl: fx.fetch,
    });
  return { started, back, cookieHeader, run };
}

async function failure(promise: Promise<unknown>): Promise<AtlasOidcError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AtlasOidcError);
    return error as AtlasOidcError;
  }
  throw new Error('expected the call to fail');
}

describe('oidc.start', () => {
  it('builds a PKCE authorize URL and a sealed, httpOnly, path-scoped flow cookie', async () => {
    const fx = await createTestIssuer();
    const { url, cookie, state, nonce } = await oidcStart({
      issuer: fx.issuer,
      clientId: fx.clientId,
      redirectUri: REDIRECT,
      prompt: 'login',
      loginHint: 'ada@example.com',
      audienceHint: 'https://api.example.com',
      extraParams: { ui_locales: 'fr', state: 'ignored' },
      secret: SECRET,
      fetchImpl: fx.fetch,
    });
    const u = new URL(url);
    expect(`${u.origin}${u.pathname}`).toBe(fx.endpoints.authorization);
    expect(u.searchParams.get('response_type')).toBe('code');
    expect(u.searchParams.get('client_id')).toBe(fx.clientId);
    expect(u.searchParams.get('redirect_uri')).toBe(REDIRECT);
    expect(u.searchParams.get('scope')).toBe('openid profile email');
    expect(u.searchParams.get('state')).toBe(state);
    expect(u.searchParams.get('nonce')).toBe(nonce);
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(u.searchParams.get('prompt')).toBe('login');
    expect(u.searchParams.get('login_hint')).toBe('ada@example.com');
    expect(u.searchParams.get('audience_hint')).toBe('https://api.example.com');
    expect(u.searchParams.get('ui_locales')).toBe('fr');

    expect(cookie).toMatch(/^atlas_oidc=s1\./);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/auth/callback');
    expect(cookie).toContain('Max-Age=600');
    // Sealed: neither the state nor the nonce is visible in the cookie.
    expect(cookie).not.toContain(state);
    expect(cookie).not.toContain(nonce);
  });

  it('adds openid to a scope that lacks it and refuses a short secret or http redirect', async () => {
    const fx = await createTestIssuer();
    const { url } = await oidcStart({
      issuer: fx.issuer,
      clientId: fx.clientId,
      redirectUri: REDIRECT,
      scope: 'email offline_access',
      fetchImpl: fx.fetch,
    });
    expect(new URL(url).searchParams.get('scope')).toBe('openid email offline_access');
    await expect(
      oidcStart({ issuer: fx.issuer, clientId: fx.clientId, redirectUri: REDIRECT, secret: 'short', fetchImpl: fx.fetch }),
    ).rejects.toThrow(/32 characters/);
    await expect(
      oidcStart({ issuer: fx.issuer, clientId: fx.clientId, redirectUri: 'http://app.example.com/cb', fetchImpl: fx.fetch }),
    ).rejects.toThrow(/https/);
  });

  it('omits Secure only for a plain-http localhost callback', async () => {
    const fx = await createTestIssuer();
    const { cookie } = await oidcStart({
      issuer: fx.issuer,
      clientId: fx.clientId,
      redirectUri: 'http://localhost:3000/cb',
      fetchImpl: fx.fetch,
    });
    expect(cookie).not.toContain('Secure');
    expect(cookie).toContain('Path=/cb');
  });

  it('reports discovery_failed for an unreachable or foreign discovery document', async () => {
    const fx = await createTestIssuer();
    const err = await failure(
      oidcStart({ issuer: 'https://elsewhere.example.com', clientId: 'c', redirectUri: REDIRECT, fetchImpl: fx.fetch }),
    );
    expect(err.code).toBe('discovery_failed');

    const lying = vi.fn(async () =>
      new Response(JSON.stringify({ issuer: 'https://evil.example.com', authorization_endpoint: 'x' }), { status: 200 }),
    ) as unknown as typeof fetch;
    const err2 = await failure(
      oidcStart({ issuer: 'https://good.example.com', clientId: 'c', redirectUri: REDIRECT, fetchImpl: lying }),
    );
    expect(err2.code).toBe('discovery_failed');
    expect(err2.message).toMatch(/issuer/);
  });

  it('caches discovery per issuer', async () => {
    const fx = await createTestIssuer();
    const spy = vi.fn(fx.fetch) as unknown as typeof fetch;
    for (let i = 0; i < 3; i++) {
      await oidcStart({ issuer: fx.issuer, clientId: fx.clientId, redirectUri: REDIRECT, fetchImpl: spy });
    }
    expect((spy as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });
});

describe('oidc.callback', () => {
  it('returns the verified identity and a clearing cookie (sealed cookie, public client)', async () => {
    const fx = await createTestIssuer();
    const { run } = await signIn(fx, {
      authorize: { sub: 'user_ada', claims: { email: 'ada@example.com', email_verified: true, name: 'Ada' } },
    });
    const id = await run();
    expect(id.sub).toBe('user_ada');
    expect(id.namespacedSub).toBe(`${fx.issuer}#user_ada`);
    expect(id.email).toBe('ada@example.com');
    expect(id.emailVerified).toBe(true);
    expect(id.name).toBe('Ada');
    expect(id.idToken.split('.')).toHaveLength(3);
    expect(id.accessToken).toMatch(/^at_/);
    expect(id.refreshToken).toBeUndefined();
    expect(id.expiresAt).toBeGreaterThan(Date.now());
    expect(id.claims.aud).toBe(fx.clientId);
    expect(id.clearCookie).toMatch(/^atlas_oidc=; Path=\/auth\/callback; Max-Age=0/);
  });

  it('treats email_verified as false unless the token says true', async () => {
    const fx = await createTestIssuer();
    const { run } = await signIn(fx, { authorize: { claims: { email: 'x@example.com' } } });
    const id = await run();
    expect(id.email).toBe('x@example.com');
    expect(id.emailVerified).toBe(false);
  });

  it.each(['client_secret_basic', 'client_secret_post'] as const)('authenticates with %s', async (clientAuth) => {
    const fx = await createTestIssuer({ clientSecret: 'cs:with/odd+chars' });
    const { run } = await signIn(fx, { clientSecret: 'cs:with/odd+chars', clientAuth, scope: 'openid offline_access' });
    const id = await run();
    expect(id.sub).toBe('user_test');
    expect(id.refreshToken).toMatch(/^rt_/);
  });

  it('reports token_exchange_failed with the OAuth error on a wrong client secret', async () => {
    const fx = await createTestIssuer({ clientSecret: 'right' });
    const { run } = await signIn(fx, { clientSecret: 'wrong' });
    const err = await failure(run());
    expect(err.code).toBe('token_exchange_failed');
    expect(err.oauthError).toBe('invalid_client');
    expect(err.status).toBe(401);
    expect(err.clearCookie).toMatch(/Max-Age=0/);
  });

  it('works with an unsealed cookie when no secret is configured', async () => {
    const fx = await createTestIssuer();
    const { started, run } = await signIn(fx, { secret: null });
    expect(started.cookie).toMatch(/^atlas_oidc=p1\./);
    expect((await run()).sub).toBe('user_test');
  });

  it('refuses an unsealed cookie when a secret is configured (downgrade)', async () => {
    const fx = await createTestIssuer();
    const started = await oidcStart({ issuer: fx.issuer, clientId: fx.clientId, redirectUri: REDIRECT, fetchImpl: fx.fetch });
    const back = await fx.authorize(started.url);
    const err = await failure(
      oidcCallback({
        issuer: fx.issuer,
        clientId: fx.clientId,
        redirectUri: REDIRECT,
        query: back.query,
        cookie: started.cookie.split(';')[0],
        secret: SECRET,
        fetchImpl: fx.fetch,
      }),
    );
    expect(err.code).toBe('state_mismatch');
  });

  it('state_mismatch: a missing cookie, a different state, or another browser\'s cookie', async () => {
    const fx = await createTestIssuer();
    const a = await signIn(fx);
    const b = await signIn(fx);
    const base = { issuer: fx.issuer, clientId: fx.clientId, redirectUri: REDIRECT, secret: SECRET, fetchImpl: fx.fetch };

    expect((await failure(oidcCallback({ ...base, query: a.back.query, cookie: undefined }))).code).toBe('state_mismatch');
    // a's callback with b's cookie: the state does not match.
    expect((await failure(oidcCallback({ ...base, query: a.back.query, cookie: b.cookieHeader }))).code).toBe(
      'state_mismatch',
    );
    const tampered = new URLSearchParams(a.back.query);
    tampered.set('state', 'forged');
    expect((await failure(oidcCallback({ ...base, query: tampered, cookie: a.cookieHeader }))).code).toBe(
      'state_mismatch',
    );
    // A cookie sealed with another secret cannot be opened.
    expect(
      (await failure(oidcCallback({ ...base, secret: `${SECRET}-other`, query: a.back.query, cookie: a.cookieHeader }))).code,
    ).toBe('state_mismatch');
  });

  it('state_mismatch: a flow older than ten minutes', async () => {
    const fx = await createTestIssuer();
    let now = Date.now();
    const clock = () => now;
    const started = await oidcStart({
      issuer: fx.issuer, clientId: fx.clientId, redirectUri: REDIRECT, secret: SECRET, fetchImpl: fx.fetch, now: clock,
    });
    const back = await fx.authorize(started.url);
    now += 11 * 60 * 1000;
    const err = await failure(
      oidcCallback({
        issuer: fx.issuer, clientId: fx.clientId, redirectUri: REDIRECT, query: back.query,
        cookie: started.cookie, secret: SECRET, fetchImpl: fx.fetch, now: clock,
      }),
    );
    expect(err.code).toBe('state_mismatch');
  });

  it('access_denied: the authorization server redirected back with an error', async () => {
    const fx = await createTestIssuer();
    const denied = await signIn(fx, { authorize: { error: 'access_denied' } });
    const err = await failure(denied.run());
    expect(err.code).toBe('access_denied');
    expect(err.oauthError).toBe('access_denied');

    const other = await signIn(fx, { authorize: { error: 'login_required' } });
    const err2 = await failure(other.run());
    expect(err2.code).toBe('access_denied');
    expect(err2.oauthError).toBe('login_required');
  });

  it('issuer_mismatch: an iss callback parameter naming another server (RFC 9207)', async () => {
    const fx = await createTestIssuer();
    const { back, cookieHeader } = await signIn(fx);
    const q = new URLSearchParams(back.query);
    q.set('iss', 'https://evil.example.com');
    const err = await failure(
      oidcCallback({
        issuer: fx.issuer, clientId: fx.clientId, redirectUri: REDIRECT, query: q, cookie: cookieHeader,
        secret: SECRET, fetchImpl: fx.fetch,
      }),
    );
    expect(err.code).toBe('issuer_mismatch');
  });

  it('a code is single-use: replaying the callback fails the exchange', async () => {
    const fx = await createTestIssuer();
    const { run } = await signIn(fx);
    await run();
    const err = await failure(run());
    expect(err.code).toBe('token_exchange_failed');
    expect(err.oauthError).toBe('invalid_grant');
  });

  it('accepts the query as a record (Express req.query)', async () => {
    const fx = await createTestIssuer();
    const { back, cookieHeader } = await signIn(fx);
    const record = Object.fromEntries(back.query.entries());
    const id = await oidcCallback({
      issuer: fx.issuer, clientId: fx.clientId, redirectUri: REDIRECT, query: record, cookie: cookieHeader,
      secret: SECRET, fetchImpl: fx.fetch,
    });
    expect(id.sub).toBe('user_test');
  });

  describe('the six negative ID-token cases are refused as invalid_token', () => {
    it.each(TEST_TOKEN_TAMPERS)('%s', async (tamper) => {
      const fx = await createTestIssuer();
      const { run } = await signIn(fx, { authorize: { tamper } });
      const err = await failure(run());
      expect(err.code).toBe('invalid_token');
      expect(err.clearCookie).toMatch(/Max-Age=0/);
    });
  });

  it('refuses several audiences without azp, and a foreign azp', async () => {
    const fx = await createTestIssuer();
    const multi = await signIn(fx, { authorize: { claims: { aud: [fx.clientId, 'client_other'] } } });
    expect((await failure(multi.run())).code).toBe('invalid_token');
    const azp = await signIn(fx, { authorize: { claims: { azp: 'client_other' } } });
    expect((await failure(azp.run())).code).toBe('invalid_token');
    const ok = await signIn(fx, { authorize: { claims: { aud: [fx.clientId, 'client_other'], azp: fx.clientId } } });
    expect((await ok.run()).sub).toBe('user_test');
  });

  it('refuses an HS256 token signed with the public key material (alg confusion)', async () => {
    const fx = await createTestIssuer();
    const started = await oidcStart({
      issuer: fx.issuer, clientId: fx.clientId, redirectUri: REDIRECT, secret: SECRET, fetchImpl: fx.fetch,
    });
    const back = await fx.authorize(started.url);
    const nonce = new URL(started.url).searchParams.get('nonce')!;
    const { SignJWT } = await import('jose');
    const hs = await new SignJWT({ iss: fx.issuer, sub: 'user_x', aud: fx.clientId, nonce })
      .setProtectedHeader({ alg: 'HS256', kid: fx.kid })
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode(JSON.stringify(fx.jwks.keys[0])));
    const swapping = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const res = await fx.fetch(input, init);
      if (new Request(input, init).url !== fx.endpoints.token) return res;
      const body = (await res.json()) as Record<string, unknown>;
      return new Response(JSON.stringify({ ...body, id_token: hs }), { status: 200 });
    }) as typeof fetch;
    const err = await failure(
      oidcCallback({
        issuer: fx.issuer, clientId: fx.clientId, redirectUri: REDIRECT, query: back.query,
        cookie: started.cookie, secret: SECRET, fetchImpl: swapping,
      }),
    );
    expect(err.code).toBe('invalid_token');
    expect(err.message).toMatch(/RS256/);
  });
});

describe('the six negative cases against session verification', () => {
  // A session token has no nonce, and `aud` is only checked when configured.
  it.each(['wrong_iss', 'foreign_key', 'expired', 'alg_none'] as const)('%s is refused by verify()', async (tamper) => {
    const fx = await createTestIssuer();
    const atlas = new AtlasBackend({ jwks: fx.jwks, issuer: fx.issuer });
    const result = await atlas.verify(await fx.mintSession({}, { tamper }));
    expect(result.ok).toBe(false);
  });

  it('wrong_aud is refused when the verifier pins an audience', async () => {
    const fx = await createTestIssuer();
    const atlas = new AtlasBackend({ jwks: fx.jwks, issuer: fx.issuer, audience: 'ins_test' });
    expect((await atlas.verify(await fx.mintSession({ aud: 'ins_test' } as never))).ok).toBe(true);
    expect((await atlas.verify(await fx.mintSession({ aud: 'ins_test' } as never, { tamper: 'wrong_aud' }))).ok).toBe(false);
  });
});

describe('oidc.logoutUrl and the bound atlas.oidc', () => {
  it('builds the end-session URL from discovery', async () => {
    const fx = await createTestIssuer();
    const url = new URL(
      await oidcLogoutUrl({
        issuer: fx.issuer,
        clientId: fx.clientId,
        postLogoutRedirectUri: 'https://app.example.com/',
        idTokenHint: 'id.token.hint',
        state: 'xyz',
        fetchImpl: fx.fetch,
      }),
    );
    expect(`${url.origin}${url.pathname}`).toBe(fx.endpoints.endSession);
    expect(url.searchParams.get('client_id')).toBe(fx.clientId);
    expect(url.searchParams.get('id_token_hint')).toBe('id.token.hint');
    expect(url.searchParams.get('post_logout_redirect_uri')).toBe('https://app.example.com/');
    expect(url.searchParams.get('state')).toBe('xyz');
  });

  it('AtlasBackend#oidc fills in the issuer and fetch', async () => {
    const fx = await createTestIssuer();
    const atlas = new AtlasBackend({ jwks: fx.jwks, issuer: fx.issuer, fetchImpl: fx.fetch });
    const started = await atlas.oidc.start({ clientId: fx.clientId, redirectUri: REDIRECT, secret: SECRET });
    const back = await fx.authorize(started.url, { sub: 'user_bound' });
    const id = await atlas.oidc.callback({
      clientId: fx.clientId, redirectUri: REDIRECT, query: back.query, cookie: started.cookie, secret: SECRET,
    });
    expect(id.sub).toBe('user_bound');
    const logout = await atlas.oidc.logoutUrl({ clientId: fx.clientId, idTokenHint: id.idToken });
    expect(logout.startsWith(fx.endpoints.endSession)).toBe(true);
    // The namespace object is the same set of functions.
    expect(typeof oidc.start).toBe('function');
    expect(typeof oidc.callback).toBe('function');
  });
});
