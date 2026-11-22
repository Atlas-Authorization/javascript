import { describe, expect, it, vi } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { createAtlas } from './index';

const ISSUER = 'https://fox.fapi.atlas.test';
const JWKS_URL = `${ISSUER}/.well-known/jwks.json`;

async function keyring() {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'kid-1', alg: 'RS256', use: 'sig' };
  return { privateKey, jwks: { keys: [jwk] } };
}
const token = (privateKey: unknown, claims: Record<string, unknown> = {}) =>
  new SignJWT({ sid: 'sess_1', ...claims }).setProtectedHeader({ alg: 'RS256', kid: 'kid-1' }).setSubject('user_1').setIssuer(ISSUER).setIssuedAt().setExpirationTime('60s').sign(privateKey as never);
const serving = (jwks: unknown) => (async () => new Response(JSON.stringify(jwks), { status: 200 })) as unknown as typeof fetch;

async function setup() {
  const { privateKey, jwks } = await keyring();
  const atlas = createAtlas({ jwksUrl: JWKS_URL, issuer: ISSUER, fetchImpl: serving(jwks) });
  return { atlas, privateKey };
}
const req = (headers: Record<string, string> = {}) => new Request('https://app.test/x', { headers });

describe('authenticate', () => {
  it('reads a bearer token, and prefers it over the cookie', async () => {
    const { atlas, privateKey } = await setup();
    const auth = await atlas.authenticate(req({ authorization: `Bearer ${await token(privateKey)}`, cookie: '__session=junk' }));
    expect(auth.userId).toBe('user_1');
    expect(auth.sessionId).toBe('sess_1');
    expect(auth.isSignedIn).toBe(true);
  });

  it('reads the __session cookie', async () => {
    const { atlas, privateKey } = await setup();
    expect((await atlas.authenticate(req({ cookie: `a=b; __session=${await token(privateKey)}` }))).userId).toBe('user_1');
  });

  it('treats a missing or unverifiable token as signed out, never an error', async () => {
    const { atlas } = await setup();
    expect(await atlas.authenticate(req())).toMatchObject({ isSignedIn: false, userId: null, status: 'signed_out', reason: 'no_token' });
    expect((await atlas.authenticate(req({ authorization: 'Bearer not-a-jwt' }))).isSignedIn).toBe(false);
  });

  it('builds the backend once per env object when the config is a function', async () => {
    const { privateKey, jwks } = await keyring();
    const config = vi.fn((env: { issuer: string }) => ({ jwksUrl: JWKS_URL, issuer: env.issuer, fetchImpl: serving(jwks) }));
    const atlas = createAtlas(config);
    const env = { issuer: ISSUER };
    const request = req({ authorization: `Bearer ${await token(privateKey)}` });
    expect((await atlas.authenticate(request, env)).userId).toBe('user_1');
    await atlas.authenticate(request, env);
    expect(config).toHaveBeenCalledTimes(1);
    await expect(atlas.authenticate(request)).rejects.toThrow(/env/);
  });
});

describe('requireAuth and withAuth', () => {
  it('answers 401 when signed out', async () => {
    const { atlas } = await setup();
    const res = await atlas.requireAuth(req());
    expect(res).toBeInstanceOf(Response);
    expect((res as Response).status).toBe(401);
  });

  it('answers 403 when the condition is unmet and passes when met', async () => {
    const { atlas, privateKey } = await setup();
    const t = await token(privateKey, { org_permissions: ['org:billing:read'], org_id: 'org_1' });
    const request = req({ authorization: `Bearer ${t}` });
    const denied = await atlas.requireAuth(request, { permission: 'org:billing:write' });
    expect((denied as Response).status).toBe(403);
    const ok = await atlas.requireAuth(request, { permission: 'org:billing:read' });
    expect((ok as { userId: string }).userId).toBe('user_1');
  });

  it('runs the handler with the auth and env only when allowed', async () => {
    const { atlas, privateKey } = await setup();
    const handler = atlas.withAuth(async (_r, { auth, env }) => Response.json({ user: auth.userId, env }));
    expect((await handler(req(), 'E' as never)).status).toBe(401);
    const res = await handler(req({ authorization: `Bearer ${await token(privateKey)}` }), 'E' as never);
    expect(await res.json()).toEqual({ user: 'user_1', env: 'E' });
  });
});

describe('rateLimit and grantUsage', () => {
  it('returns headers when allowed and a 429 Response when over, with the address from cf-connecting-ip', async () => {
    const { atlas } = await setup();
    const check = vi.fn(async () => ({ allowed: true as const, headers: { 'RateLimit-Remaining': '4' } }));
    const gate = atlas.rateLimit(check as never);
    expect(await gate(req({ 'cf-connecting-ip': '1.2.3.4' }))).toEqual({ headers: { 'RateLimit-Remaining': '4' } });
    expect(check).toHaveBeenCalledWith(expect.objectContaining({ ip: '1.2.3.4' }));

    const over = atlas.rateLimit((async () => ({ allowed: false as const, status: 429, headers: { 'Retry-After': '3' }, body: { error: 'slow' } })) as never);
    const res = (await over(req())) as Response;
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('3');
    expect(await res.json()).toEqual({ error: 'slow' });
  });

  it('answers a missing grant with the gate verdict and merges allow headers into a response', async () => {
    const { atlas } = await setup();
    const res = (await atlas.grantUsage((async () => ({ allowed: false as const, status: 403 })) as never)(req())) as Response;
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ errors: [{ code: 'FORBIDDEN' }] });
    const merged = atlas.withHeaders(await fetchLike(), { 'RateLimit-Remaining': '1' });
    expect(merged.headers.get('ratelimit-remaining')).toBe('1');
  });
});

// A response whose headers are immutable, like one returned by fetch().
async function fetchLike(): Promise<Response> {
  const r = Response.redirect('https://x.test/', 302);
  return r;
}

describe('auth status', () => {
  const expiredToken = (privateKey: unknown) => {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ sid: 'sess_1' }).setProtectedHeader({ alg: 'RS256', kid: 'kid-1' }).setSubject('user_1').setIssuer(ISSUER).setIssuedAt(now - 600).setExpirationTime(now - 120).sign(privateKey as never);
  };

  it('signed in', async () => {
    const { atlas, privateKey } = await setup();
    const auth = await atlas.authenticate(req({ cookie: `__session=${await token(privateKey)}` }));
    expect(auth).toMatchObject({ status: 'signed_in', isSignedIn: true });
    expect(auth.reason).toBeUndefined();
  });

  it('session_expired with only the refresh cookie or hint, signed_out with nothing', async () => {
    const { atlas } = await setup();
    expect(await atlas.authenticate(req({ cookie: '__atlas_rt=r' }))).toMatchObject({ status: 'session_expired', reason: 'no_token' });
    expect(await atlas.authenticate(req({ cookie: '__atlas_uat=1700000000' }))).toMatchObject({ status: 'session_expired' });
  });

  it('an expired token is session_expired with the refresh cookie, signed_out without; garbage is token_invalid', async () => {
    const { atlas, privateKey } = await setup();
    const expired = await expiredToken(privateKey);
    expect(await atlas.authenticate(req({ cookie: `__session=${expired}; __atlas_rt=r` }))).toMatchObject({ status: 'session_expired', reason: 'expired', isSignedIn: false });
    expect(await atlas.authenticate(req({ cookie: `__session=${expired}` }))).toMatchObject({ status: 'signed_out', reason: 'expired' });
    expect(await atlas.authenticate(req({ cookie: '__session=garbage; __atlas_rt=r' }))).toMatchObject({ status: 'token_invalid' });
  });

  it('requireAuth sets x-atlas-auth-status on its 401', async () => {
    const { atlas, privateKey } = await setup();
    const renew = (await atlas.requireAuth(req({ cookie: '__atlas_rt=r' }))) as Response;
    expect(renew.status).toBe(401);
    expect(renew.headers.get('x-atlas-auth-status')).toBe('session-expired');
    expect(renew.headers.get('www-authenticate')).toBe('Bearer');
    const out = (await atlas.requireAuth(req())) as Response;
    expect(out.headers.get('x-atlas-auth-status')).toBe('signed-out');
    const bad = (await atlas.requireAuth(req({ cookie: '__session=garbage' }))) as Response;
    expect(bad.headers.get('x-atlas-auth-status')).toBe('token-invalid');
    const ok = await atlas.requireAuth(req({ cookie: `__session=${await token(privateKey)}` }));
    expect(ok instanceof Response).toBe(false);
  });
});
