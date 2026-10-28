import { describe, expect, it, vi } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { AtlasBackend } from './verify';
import { createTestIssuer } from './testing';
import {
  betterAuthCookieNames,
  createBetterAuthBridge,
  exchangeBetterAuthSession,
  readBetterAuthSessionCookie,
  serializeBridgeCookie,
} from './better-auth';

/** A Better Auth `jwt`-plugin style issuer: EdDSA key, iss = aud = the app's base URL. */
async function betterAuthIssuer() {
  const { privateKey, publicKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519' });
  const jwk = { ...(await exportJWK(publicKey)), kid: 'ba-key-1', alg: 'EdDSA' };
  const iss = 'https://old.example.com';
  const mint = (claims: Record<string, unknown> = {}, expSeconds = 900) =>
    new SignJWT({ email: 'u@example.com', ...claims })
      .setProtectedHeader({ alg: 'EdDSA', kid: 'ba-key-1' })
      .setIssuer(iss)
      .setAudience(iss)
      .setSubject((claims.sub as string) ?? 'ba_user_1')
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + expSeconds)
      .sign(privateKey);
  return { iss, jwks: { keys: [jwk] }, mint };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('readBetterAuthSessionCookie', () => {
  it('prefers the __Secure- cookie, honours a custom prefix and a custom name', () => {
    expect(readBetterAuthSessionCookie('a=1; better-auth.session_token=plain; __Secure-better-auth.session_token=secure')).toBe('secure');
    expect(readBetterAuthSessionCookie('better-auth.session_token=plain')).toBe('plain');
    expect(readBetterAuthSessionCookie('myapp.session_token=x', { cookiePrefix: 'myapp' })).toBe('x');
    expect(readBetterAuthSessionCookie('sid=y', { cookieName: 'sid' })).toBe('y');
    expect(readBetterAuthSessionCookie('other=1')).toBeUndefined();
    expect(betterAuthCookieNames().all).toContain('__Secure-better-auth.session_data');
  });
});

describe('exchangeBetterAuthSession', () => {
  it('posts the token with body delivery and maps the three answers', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown>; headers: Headers }> = [];
    let answer: Response = json(200, { object: 'session_tokens', jwt: 'j', refresh_token: 'r', session_id: 's', user_id: 'u', expires_in: 60 });
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)), headers: new Headers(init?.headers) });
      return answer;
    }) as unknown as typeof fetch;
    const opts = { fapiOrigin: 'https://fapi.example', publishableKey: 'pk_test_x', token: 'tok', fetchImpl, userAgent: 'UA' };

    expect(await exchangeBetterAuthSession(opts)).toEqual({ kind: 'session', jwt: 'j', refreshToken: 'r', sessionId: 's', userId: 'u', expiresIn: 60 });
    expect(calls[0]!.url).toBe('https://fapi.example/v1/client/migrations/better_auth/exchange');
    expect(calls[0]!.body).toEqual({ token: 'tok', delivery: 'body' });
    expect(calls[0]!.headers.get('x-publishable-key')).toBe('pk_test_x');
    expect(calls[0]!.headers.get('user-agent')).toBe('UA');

    answer = json(200, { object: 'sign_in_attempt', id: 'sia_1', status: 'needs_second_factor' });
    expect(await exchangeBetterAuthSession(opts)).toEqual({ kind: 'needs_mfa', attemptId: 'sia_1', status: 'needs_second_factor' });

    answer = json(400, { errors: [{ code: 'VERIFICATION_FAILED', meta: { bridge_outcome: 'reused' } }] });
    expect(await exchangeBetterAuthSession(opts)).toEqual({ kind: 'refused', outcome: 'reused', status: 400 });

    answer = json(429, { errors: [{ code: 'RATE_LIMITED' }] });
    expect(await exchangeBetterAuthSession(opts)).toMatchObject({ outcome: 'rate_limited' });

    answer = json(503, {});
    expect(await exchangeBetterAuthSession(opts)).toMatchObject({ outcome: 'unavailable' });
  });

  it('never throws on a transport failure', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('down');
    }) as unknown as typeof fetch;
    expect(await exchangeBetterAuthSession({ fapiOrigin: 'https://f', publishableKey: 'pk', token: 't', fetchImpl })).toEqual({
      kind: 'refused',
      outcome: 'unavailable',
      status: 0,
    });
  });
});

describe('createBetterAuthBridge', () => {
  const bridgeWith = (response: Response) => {
    const fetchImpl = vi.fn(async () => response.clone()) as unknown as typeof fetch;
    return { fetchImpl, bridge: createBetterAuthBridge({ fapiOrigin: 'https://f', publishableKey: 'pk', fetchImpl, betterAuthCookieDomain: '.example.com' }) };
  };

  it('does nothing without a Better Auth cookie, or with an Atlas session already present', async () => {
    const { bridge, fetchImpl } = bridgeWith(json(200, {}));
    expect(await bridge({ headers: { cookie: 'x=1' } })).toEqual({ action: 'none' });
    expect(await bridge({ headers: { cookie: 'better-auth.session_token=t; __session=jwt' } })).toEqual({ action: 'none' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('signs in: Atlas cookies set, every Better Auth cookie cleared on its domain', async () => {
    const { bridge } = bridgeWith(json(200, { object: 'session_tokens', jwt: 'j', refresh_token: 'r' }));
    const out = await bridge({ headers: new Headers({ cookie: 'better-auth.session_token=t' }) });
    expect(out.action).toBe('signed_in');
    if (out.action !== 'signed_in') return;
    const names = out.cookies.map((c) => c.name);
    expect(names.slice(0, 2)).toEqual(['__session', '__atlas_rt']);
    const cleared = out.cookies.filter((c) => c.options.maxAge === 0);
    expect(cleared.map((c) => c.name)).toEqual(betterAuthCookieNames().all);
    expect(cleared.every((c) => c.options.domain === '.example.com')).toBe(true);
    expect(serializeBridgeCookie(out.cookies[1]!)).toBe('__atlas_rt=r; Path=/; HttpOnly; Secure; SameSite=Lax');
    expect(serializeBridgeCookie(cleared[0]!)).toContain('Max-Age=0');
  });

  it('needs MFA: clears the spent Better Auth session and builds the continuation URL', async () => {
    const { bridge } = bridgeWith(json(200, { object: 'sign_in_attempt', id: 'sia_9', status: 'needs_mfa_enrollment' }));
    const out = await bridge({ headers: { cookie: 'better-auth.session_token=t' } });
    expect(out.action).toBe('needs_mfa');
    if (out.action !== 'needs_mfa') return;
    expect(out.continuationUrl('https://app.example.com/sign-in?x=1')).toBe(
      'https://app.example.com/sign-in?x=1&__atlas_attempt=sia_9&__atlas_status=needs_mfa_enrollment',
    );
    expect(out.cookies.length).toBeGreaterThan(0);
  });

  it('clears on a final refusal, keeps the cookie when Atlas could not judge', async () => {
    const final = await bridgeWith(json(400, { errors: [{ meta: { bridge_outcome: 'expired' } }] })).bridge({ headers: { cookie: 'better-auth.session_token=t' } });
    expect(final).toMatchObject({ action: 'refused', outcome: 'expired' });
    if (final.action === 'refused') expect(final.cookies.length).toBeGreaterThan(0);
    for (const res of [json(403, { errors: [{ meta: { bridge_outcome: 'closed' } }] }), json(429, {}), json(500, {})]) {
      const kept = await bridgeWith(res).bridge({ headers: { cookie: 'better-auth.session_token=t' } });
      expect(kept.action).toBe('refused');
      if (kept.action === 'refused') expect(kept.cookies).toEqual([]);
    }
  });
});

describe('AtlasBackend legacyIssuers (Better Auth JWTs during cutover)', () => {
  it('accepts an old token within the window and maps sub through resolveSubject', async () => {
    const atlas = await createTestIssuer();
    const ba = await betterAuthIssuer();
    const backend = new AtlasBackend({
      jwks: atlas.jwks,
      issuer: atlas.issuer,
      legacyIssuers: [
        { issuer: ba.iss, jwks: ba.jwks, audience: ba.iss, until: Date.now() + 60_000, resolveSubject: (sub) => (sub === 'ba_user_1' ? 'user_atlas_1' : null) },
      ],
    });
    const result = await backend.verify(await ba.mint());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.claims.sub).toBe('user_atlas_1');
      expect(result.claims.external_id).toBe('ba_user_1');
      expect(result.claims.legacy).toEqual({ kind: 'better_auth', issuer: ba.iss, sub: 'ba_user_1' });
    }
    // Unmapped subject → refused.
    expect((await backend.verify(await ba.mint({ sub: 'ba_unknown' }))).ok).toBe(false);
    // Atlas tokens are unaffected.
    expect((await backend.verify(await atlas.mintSession({ sub: 'user_x' }))).ok).toBe(true);
  });

  it('refuses after the window, a wrong audience, a forged signature and an Atlas-issuer claim', async () => {
    const atlas = await createTestIssuer();
    const ba = await betterAuthIssuer();
    const other = await betterAuthIssuer(); // same iss, different key
    const make = (until: number) =>
      new AtlasBackend({
        jwks: atlas.jwks,
        issuer: atlas.issuer,
        legacyIssuers: [{ issuer: ba.iss, jwks: ba.jwks, audience: ba.iss, until, resolveSubject: () => 'user_1' }],
      });
    expect((await make(Date.now() - 1).verify(await ba.mint())).ok).toBe(false);
    const wrongAud = new AtlasBackend({
      jwks: atlas.jwks,
      issuer: atlas.issuer,
      legacyIssuers: [{ issuer: ba.iss, jwks: ba.jwks, audience: 'https://expected', until: Date.now() + 60_000, resolveSubject: () => 'user_1' }],
    });
    expect((await wrongAud.verify(await ba.mint())).ok).toBe(false);
    expect((await make(Date.now() + 60_000).verify(await ba.mint())).ok).toBe(true);
    expect((await make(Date.now() + 60_000).verify(await other.mint())).ok).toBe(false);
    expect(
      () =>
        new AtlasBackend({
          jwks: atlas.jwks,
          issuer: atlas.issuer,
          legacyIssuers: [{ issuer: atlas.issuer, jwks: ba.jwks, until: Date.now() + 1, resolveSubject: () => 'x' }],
        }),
    ).toThrow(/cannot be the Atlas/);
  });

  it('maps sub via the Backend API external_id lookup (cached) when no resolver is given', async () => {
    const atlas = await createTestIssuer();
    const ba = await betterAuthIssuer();
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = new URL(String(url));
      expect(u.pathname).toBe('/v1/users');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer sk_test_x');
      return json(200, { data: u.searchParams.get('external_id') === 'ba_user_1' ? [{ id: 'user_from_bapi' }] : [] });
    }) as unknown as typeof fetch;
    const backend = new AtlasBackend({
      jwks: atlas.jwks,
      issuer: atlas.issuer,
      secretKey: 'sk_test_x',
      bapiBaseUrl: 'https://api.example',
      fetchImpl,
      legacyIssuers: [{ issuer: ba.iss, jwks: ba.jwks, until: new Date(Date.now() + 60_000) }],
    });
    const token = await ba.mint();
    const first = await backend.verify(token);
    expect(first.ok && first.claims.sub).toBe('user_from_bapi');
    await backend.verify(token);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('requires a way to map subjects and a bounded window', async () => {
    const atlas = await createTestIssuer();
    const ba = await betterAuthIssuer();
    expect(() => new AtlasBackend({ jwks: atlas.jwks, issuer: atlas.issuer, legacyIssuers: [{ issuer: ba.iss, jwks: ba.jwks, until: Date.now() + 1 }] })).toThrow(/secretKey/);
    expect(
      () => new AtlasBackend({ jwks: atlas.jwks, issuer: atlas.issuer, legacyIssuers: [{ issuer: ba.iss, jwks: ba.jwks, until: 'never', resolveSubject: () => 'x' }] }),
    ).toThrow(/until/);
  });
});

describe('secret-key exchange path', () => {
  it('with a secret key: Backend API, Bearer auth, end-user IP + UA forwarded, no publishable key', async () => {
    const calls: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
      return json(200, { object: 'session_tokens', jwt: 'j', refresh_token: 'r' });
    }) as unknown as typeof fetch;
    const out = await exchangeBetterAuthSession({
      fapiOrigin: 'https://fapi.example',
      publishableKey: 'pk_test_x',
      secretKey: 'sk_test_y',
      token: 'tok',
      clientIp: '198.51.100.4',
      userAgent: 'Browser/1',
      fetchImpl,
    });
    expect(out.kind).toBe('session');
    expect(calls[0]!.url).toBe('https://api.atlasauth.net/v1/migrations/better_auth/exchange');
    expect(calls[0]!.headers.get('authorization')).toBe('Bearer sk_test_y');
    expect(calls[0]!.headers.get('x-atlas-client-ip')).toBe('198.51.100.4');
    expect(calls[0]!.headers.get('x-atlas-client-user-agent')).toBe('Browser/1');
    expect(calls[0]!.headers.get('x-publishable-key')).toBeNull();
    expect(calls[0]!.body).toEqual({ token: 'tok' });
  });

  it('the bridge forwards the request IP, else the first X-Forwarded-For hop; 429 is retried later', async () => {
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get('x-atlas-client-ip') ?? '');
      return json(429, { errors: [{ code: 'RATE_LIMITED', meta: { bridge_outcome: 'rate_limited' } }] });
    }) as unknown as typeof fetch;
    const bridge = createBetterAuthBridge({ fapiOrigin: 'https://f', publishableKey: 'pk', secretKey: 'sk_test_z', bapiBaseUrl: 'https://api.example', fetchImpl });
    const a = await bridge({ headers: { cookie: 'better-auth.session_token=t' }, ip: '203.0.113.9' });
    await bridge({ headers: { cookie: 'better-auth.session_token=t', 'x-forwarded-for': '198.51.100.1, 10.0.0.2' } });
    expect(seen).toEqual(['203.0.113.9', '198.51.100.1']);
    expect(a).toEqual({ action: 'refused', outcome: 'rate_limited', cookies: [] });
  });
});
