import { describe, expect, it } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { AtlasBackend } from '@atlasauth/backend';
import { atlasMiddleware, createAuthHelper, resolveAuth, SIGNED_OUT } from './middleware';

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

const request = (pathname: string, headers: Record<string, string> = {}) => ({
  nextUrl: { pathname },
  url: `https://app.example.com${pathname}`,
  headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
});

const responder = () => {
  const calls: Array<{ kind: string; arg?: unknown }> = [];
  return {
    calls,
    next: () => {
      calls.push({ kind: 'next' });
      return {};
    },
    redirect: (url: string | URL) => {
      calls.push({ kind: 'redirect', arg: String(url) });
      return {};
    },
    json: (body: unknown, init?: { status?: number }) => {
      calls.push({ kind: 'json', arg: init?.status });
      return {};
    },
  };
};

describe('reading the session from a request', () => {
  it('reads a bearer token', async () => {
    const { privateKey, jwks } = await keyring();
    const backend = new AtlasBackend({
      jwksUrl: JWKS_URL,
      issuer: ISSUER,
      fetchImpl: serving(jwks),
    });

    const state = await resolveAuth(
      backend,
      request('/dashboard', { authorization: `Bearer ${await token(privateKey)}` }),
    );
    expect(state.userId).toBe('user_1');
  });

  it('reads the __session cookie', async () => {
    const { privateKey, jwks } = await keyring();
    const backend = new AtlasBackend({
      jwksUrl: JWKS_URL,
      issuer: ISSUER,
      fetchImpl: serving(jwks),
    });

    const state = await resolveAuth(
      backend,
      request('/dashboard', { cookie: `a=b; __session=${await token(privateKey)}` }),
    );
    expect(state.userId).toBe('user_1');
  });

  it('carries organization claims through', async () => {
    const { privateKey, jwks } = await keyring();
    const backend = new AtlasBackend({
      jwksUrl: JWKS_URL,
      issuer: ISSUER,
      fetchImpl: serving(jwks),
    });

    const state = await resolveAuth(
      backend,
      request('/dashboard', {
        cookie: `__session=${await token(privateKey, { org_id: 'org_1', org_role: 'org:admin' })}`,
      }),
    );
    expect(state.orgId).toBe('org_1');
    expect(state.orgRole).toBe('org:admin');
  });

  /**
   * A middleware that throws takes the whole page down. Treating an
   * unverifiable token as "not signed in" degrades to the sign-in screen, which
   * is what the user needs anyway.
   */
  it('treats an unverifiable token as signed out rather than throwing', async () => {
    const { jwks } = await keyring();
    const backend = new AtlasBackend({
      jwksUrl: JWKS_URL,
      issuer: ISSUER,
      fetchImpl: serving(jwks),
    });

    expect(await resolveAuth(backend, request('/x', { cookie: '__session=garbage' }))).toEqual(
      SIGNED_OUT,
    );
  });

  it('reports signed out when nothing is carried', async () => {
    const { jwks } = await keyring();
    const backend = new AtlasBackend({
      jwksUrl: JWKS_URL,
      issuer: ISSUER,
      fetchImpl: serving(jwks),
    });
    expect(await resolveAuth(backend, request('/x'))).toEqual(SIGNED_OUT);
  });
});

describe('the middleware', () => {
  const build = async (config = {}) => {
    const { privateKey, jwks } = await keyring();
    return {
      privateKey,
      middleware: atlasMiddleware({
        jwksUrl: JWKS_URL,
        issuer: ISSUER,
        fetchImpl: serving(jwks),
        ...config,
      }),
    };
  };

  it('lets a signed-in user through', async () => {
    const { privateKey, middleware } = await build();
    const response = responder();

    await middleware(
      request('/dashboard', { cookie: `__session=${await token(privateKey)}` }),
      response,
    );
    expect(response.calls[0]!.kind).toBe('next');
  });

  it('redirects a signed-out user away from a protected page', async () => {
    const { middleware } = await build();
    const response = responder();

    await middleware(request('/dashboard'), response);
    expect(response.calls[0]!.kind).toBe('redirect');
    expect(String(response.calls[0]!.arg)).toContain('/sign-in?redirect_url=%2Fdashboard');
  });

  it('lets a signed-out user reach a public page', async () => {
    const { middleware } = await build({ publicRoutes: ['/', '/sign-in(.*)'] });
    const response = responder();

    await middleware(request('/sign-in'), response);
    expect(response.calls[0]!.kind).toBe('next');
  });

  it('answers an API route with 401 rather than a redirect', async () => {
    const { middleware } = await build();
    const response = responder();

    await middleware(request('/api/orders'), response);
    expect(response.calls[0]).toEqual({ kind: 'json', arg: 401 });
  });

  it('skips static assets without verifying anything', async () => {
    const { middleware } = await build();
    const response = responder();

    await middleware(request('/_next/static/chunk.js'), response);
    expect(response.calls[0]!.kind).toBe('next');
  });

  /**
   * The default that matters: a page nobody listed is protected, so forgetting
   * to list one is a loud redirect rather than a silent breach.
   */
  it('protects a page the developer forgot to list', async () => {
    const { middleware } = await build({ publicRoutes: ['/', '/sign-in(.*)'] });
    const response = responder();

    await middleware(request('/admin/reports'), response);
    expect(response.calls[0]!.kind).toBe('redirect');
  });
});

describe('the auth() helper', () => {
  const build = async () => {
    const { privateKey, jwks } = await keyring();
    return {
      privateKey,
      auth: createAuthHelper({ jwksUrl: JWKS_URL, issuer: ISSUER, fetchImpl: serving(jwks) }),
    };
  };

  it('returns a plain signed-out state rather than throwing', async () => {
    const { auth } = await build();
    const state = await auth(request('/'));
    // A server component rendering differently for anonymous visitors is the
    // normal case, not an error.
    expect(state.userId).toBeNull();
  });

  it('checks a permission from the token', async () => {
    const { privateKey, auth } = await build();
    const state = await auth(
      request('/', {
        cookie: `__session=${await token(privateKey, {
          org_id: 'org_1',
          org_permissions: ['org:invoices:manage'],
        })}`,
      }),
    );

    expect(state.has({ permission: 'org:invoices:manage' })).toBe(true);
    expect(state.has({ permission: 'org:billing:manage' })).toBe(false);
  });

  it('refuses an org condition when there is no active organization', async () => {
    const { privateKey, auth } = await build();
    const state = await auth(request('/', { cookie: `__session=${await token(privateKey)}` }));
    expect(state.has({ permission: 'anything' })).toBe(false);
  });

  it('protect() throws only where anonymous access is genuinely a bug', async () => {
    const { privateKey, auth } = await build();

    const anonymous = await auth(request('/'));
    expect(() => anonymous.protect()).toThrow();

    const signedIn = await auth(request('/', { cookie: `__session=${await token(privateKey)}` }));
    expect(() => signedIn.protect()).not.toThrow();
  });
});

describe('cross-property handshake redeem on satellite return', () => {
  const cookieResponder = () => {
    const calls: Array<{ kind: string; arg?: unknown }> = [];
    const cookies: Array<{ name: string; value: string; opts?: Record<string, unknown> }> = [];
    return {
      calls,
      cookies,
      next: () => {
        calls.push({ kind: 'next' });
        return {};
      },
      json: (_b: unknown, init?: { status?: number }) => {
        calls.push({ kind: 'json', arg: init?.status });
        return {};
      },
      redirect: (url: string | URL) => {
        calls.push({ kind: 'redirect', arg: String(url) });
        return {
          cookies: {
            set: (name: string, value: string, opts?: Record<string, unknown>) => {
              cookies.push({ name, value, opts });
            },
          },
        };
      },
    };
  };

  // Capture the redeem request body so we can assert the PKCE proof is sent.
  const redeemFetch = (jwks: unknown, status = 200, sink?: { body?: unknown }) =>
    (async (url: string | URL, init?: RequestInit) => {
      if (String(url).includes('/v1/client/handshake/redeem')) {
        if (sink) sink.body = JSON.parse((init?.body as string) ?? '{}');
        if (status !== 200) return new Response('', { status });
        return new Response(
          JSON.stringify({ object: 'session_tokens', jwt: 'JWT_V', refresh_token: 'RT_V', session_id: 'sess_1', expires_in: 60 }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify(jwks), { status: 200 });
    }) as unknown as typeof fetch;

  const withVerifier = (cookieVal: string) => ({ get: (n: string) => (n.toLowerCase() === 'cookie' ? `__atlas_hv=${cookieVal}` : null) });

  it('redeems the nonce with the PKCE verifier, sets first-party cookies, strips params, clears the verifier', async () => {
    const { jwks } = await keyring();
    const sink: { body?: unknown } = {};
    const middleware = atlasMiddleware({
      jwksUrl: JWKS_URL,
      issuer: ISSUER,
      handshake: true,
      publishableKey: 'pk_test_sat',
      fapiOrigin: ISSUER,
      fetchImpl: redeemFetch(jwks, 200, sink),
    });
    const response = cookieResponder();
    await middleware(
      {
        nextUrl: { pathname: '/dashboard' },
        url: 'https://sat.example.com/dashboard?__atlas_hs=ok&__atlas_hu=user_1&__atlas_hn=nonce_abc',
        headers: withVerifier('the-verifier'),
      },
      response,
    );

    const redirect = response.calls.find((c) => c.kind === 'redirect');
    expect(redirect).toBeTruthy();
    expect(String(redirect!.arg)).toContain('/dashboard');
    expect(String(redirect!.arg)).not.toContain('__atlas_hs');
    expect(String(redirect!.arg)).not.toContain('__atlas_hn');
    // The verifier from the cookie is what proves possession to the redeem.
    expect((sink.body as { code_verifier?: string }).code_verifier).toBe('the-verifier');
    expect(response.cookies.find((c) => c.name === '__session')?.value).toBe('JWT_V');
    const rt = response.cookies.find((c) => c.name === '__atlas_rt');
    expect(rt?.value).toBe('RT_V');
    expect(rt?.opts?.httpOnly).toBe(true);
    // The spent verifier cookie is cleared.
    const hv = response.cookies.find((c) => c.name === '__atlas_hv');
    expect(hv?.value).toBe('');
  });

  it('does not loop when the redeem fails — carries a spent marker instead of re-bouncing', async () => {
    const { jwks } = await keyring();
    const middleware = atlasMiddleware({
      jwksUrl: JWKS_URL,
      issuer: ISSUER,
      handshake: true,
      publishableKey: 'pk_test_sat',
      fapiOrigin: ISSUER,
      fetchImpl: redeemFetch(jwks, 401),
    });
    const response = cookieResponder();
    await middleware(
      {
        nextUrl: { pathname: '/dashboard' },
        url: 'https://sat.example.com/dashboard?__atlas_hs=ok&__atlas_hu=user_1&__atlas_hn=nonce_abc',
        headers: withVerifier('wrong-verifier'),
      },
      response,
    );
    const redirect = response.calls.find((c) => c.kind === 'redirect');
    expect(redirect).toBeTruthy();
    // No session set; the return URL carries a spent marker so the outbound
    // guard trips and normal routing sends the user to sign-in (never re-bounce).
    expect(response.cookies.find((c) => c.name === '__session')).toBeUndefined();
    expect(String(redirect!.arg)).toContain('__atlas_hs=failed');
    expect(String(redirect!.arg)).not.toContain('__atlas_hn');
  });

  it('does not redeem (and does not loop) when the verifier cookie is missing', async () => {
    const { jwks } = await keyring();
    let redeemCalled = false;
    const fetchImpl = (async (url: string | URL) => {
      if (String(url).includes('/v1/client/handshake/redeem')) redeemCalled = true;
      return new Response(JSON.stringify(jwks), { status: 200 });
    }) as unknown as typeof fetch;
    const middleware = atlasMiddleware({
      jwksUrl: JWKS_URL,
      issuer: ISSUER,
      handshake: true,
      publishableKey: 'pk_test_sat',
      fapiOrigin: ISSUER,
      fetchImpl,
    });
    const response = cookieResponder();
    await middleware(
      {
        nextUrl: { pathname: '/dashboard' },
        url: 'https://sat.example.com/dashboard?__atlas_hs=ok&__atlas_hu=user_1&__atlas_hn=nonce_abc',
        headers: { get: () => null },
      },
      response,
    );
    expect(redeemCalled).toBe(false);
    const redirect = response.calls.find((c) => c.kind === 'redirect');
    expect(String(redirect!.arg)).toContain('__atlas_hs=failed');
  });

  it('bounces a signed-out user to the handshake with a PKCE code_challenge and stashes the HttpOnly verifier', async () => {
    const { jwks } = await keyring();
    const middleware = atlasMiddleware({
      jwksUrl: JWKS_URL,
      issuer: ISSUER,
      handshake: true,
      publishableKey: 'pk_test_sat',
      fapiOrigin: ISSUER,
      fetchImpl: serving(jwks),
    });
    const response = cookieResponder();
    await middleware(
      { nextUrl: { pathname: '/dashboard' }, url: 'https://sat.example.com/dashboard', headers: { get: () => null } },
      response,
    );
    const redirect = response.calls.find((c) => c.kind === 'redirect');
    expect(redirect).toBeTruthy();
    const to = new URL(String(redirect!.arg));
    expect(to.pathname).toBe('/v1/client/handshake');
    const challenge = to.searchParams.get('code_challenge');
    expect(challenge).toBeTruthy();
    // The verifier is stashed HttpOnly; only its challenge left in the URL.
    const hv = response.cookies.find((c) => c.name === '__atlas_hv');
    expect(hv?.value).toBeTruthy();
    expect(hv?.opts?.httpOnly).toBe(true);
    expect(String(redirect!.arg)).not.toContain(hv!.value); // verifier itself never in the URL
  });

  it('does not hit the redeem endpoint when no nonce is present (subdomain return / normal request)', async () => {
    const { jwks } = await keyring();
    let redeemCalled = false;
    const fetchImpl = (async (url: string | URL) => {
      if (String(url).includes('/v1/client/handshake/redeem')) redeemCalled = true;
      return new Response(JSON.stringify(jwks), { status: 200 });
    }) as unknown as typeof fetch;
    const middleware = atlasMiddleware({
      jwksUrl: JWKS_URL,
      issuer: ISSUER,
      handshake: true,
      publishableKey: 'pk_test_sat',
      fapiOrigin: ISSUER,
      fetchImpl,
    });
    const response = cookieResponder();
    await middleware(
      { nextUrl: { pathname: '/dashboard' }, url: 'https://sat.example.com/dashboard?__atlas_hs=signed_out', headers: { get: () => null } },
      response,
    );
    expect(redeemCalled).toBe(false);
    expect(response.cookies).toHaveLength(0);
  });
});
