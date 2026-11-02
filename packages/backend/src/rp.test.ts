import { createHmac } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { SignJWT } from 'jose';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AtlasApiError,
  AtlasOidcError,
  LogoutTokenVerifier,
  createRelyingParty,
  memoryLogoutReplayStore,
  resetOidcCaches,
  verifyAtlasWebhookRequest,
  type RelyingPartyConfig,
} from './rp';
import { createTestIssuer, type TestIssuer } from './testing';

vi.setConfig({ testTimeout: 30_000 });

/**
 * `@atlasauth/backend/rp` end to end against the offline test issuer: the
 * Request → Response handlers, step-up, touch, revoke and sign-out. No network.
 */

const APP = 'https://app.example.com';
const REDIRECT = `${APP}/auth/callback`;
const SECRET = 'a-test-secret-that-is-at-least-32-characters';
const API = 'https://api.example.test';

beforeEach(() => resetOidcCaches());

interface ApiCall { method: string; url: string; auth: string | null }

/** The issuer's fetch, plus a fake Backend API for touch / revoke. */
function withApi(fx: TestIssuer, answer: (call: ApiCall) => Response) {
  const calls: ApiCall[] = [];
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const request = new Request(input, init);
    if (request.url.startsWith(API)) {
      const call = { method: request.method, url: request.url, auth: request.headers.get('authorization') };
      calls.push(call);
      return answer(call);
    }
    return fx.fetch(input, init);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function makeRp(fx: TestIssuer, extra: Partial<RelyingPartyConfig> = {}) {
  return createRelyingParty({
    issuer: fx.issuer,
    clientId: fx.clientId,
    redirectUri: REDIRECT,
    secret: SECRET,
    fetchImpl: fx.fetch,
    postLogoutRedirectUri: `${APP}/`,
    ...extra,
  });
}

/** Follow `start`'s redirect through the fake authorization server back to the callback Request. */
async function roundTrip(fx: TestIssuer, started: Response, authorize: Parameters<TestIssuer['authorize']>[1] = {}) {
  const back = await fx.authorize(started.headers.get('location')!, authorize);
  const flowCookie = started.headers.get('set-cookie')!.split(';')[0];
  return new Request(back.callbackUrl, { headers: { cookie: `theirs=1; ${flowCookie}` } });
}

describe('createRelyingParty', () => {
  it('start → callback: a 302 with the sealed cookie, then the user, tokens and a mutable 302 response', async () => {
    const fx = await createTestIssuer();
    const rp = makeRp(fx);
    const started = await rp.start(
      new Request(`${APP}/auth/sign-in?prompt=login&login_hint=ada%40example.com&ui_locales=fr&max_age=600&organization=org_acme&return_to=%2Fbilling&unrelated=x`),
    );
    expect(started.status).toBe(302);
    expect(started.headers.get('cache-control')).toBe('no-store');
    const location = new URL(started.headers.get('location')!);
    expect(`${location.origin}${location.pathname}`).toBe(fx.endpoints.authorization);
    const p = location.searchParams;
    expect(p.get('code_challenge_method')).toBe('S256');
    expect(p.get('prompt')).toBe('login');
    expect(p.get('login_hint')).toBe('ada@example.com');
    expect(p.get('ui_locales')).toBe('fr');
    expect(p.get('max_age')).toBe('600');
    expect(p.get('organization')).toBe('org_acme');
    expect(p.has('unrelated')).toBe(false);
    expect(p.has('return_to')).toBe(false);
    expect(started.headers.get('set-cookie')).toMatch(/^atlas_oidc=s1\..*HttpOnly/);

    const req = await roundTrip(fx, started, {
      sub: 'user_ada',
      organization: { id: 'org_acme', slug: 'acme', role: 'admin' },
      claims: { sid: 'sess_1', email: 'ada@example.com', email_verified: true, name: 'Ada', external_id: 'legacy-7' },
    });
    const { user, tokens, response, identity } = await rp.callback(req);
    expect(user).toMatchObject({
      sub: 'user_ada',
      sid: 'sess_1',
      email: 'ada@example.com',
      email_verified: true,
      name: 'Ada',
      external_id: 'legacy-7',
      org_id: 'org_acme',
      org_role: 'admin',
    });
    expect(typeof user.auth_time).toBe('number');
    expect(tokens.id_token).toBe(identity.idToken);
    expect(tokens.access_token).toMatch(/^at_/);
    expect(tokens.expires_at).toBeGreaterThan(Date.now());
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/billing');
    expect(response.headers.get('set-cookie')).toMatch(/^atlas_oidc=;.*Max-Age=0/);
    // The app appends its own session cookie on the same response.
    response.headers.append('set-cookie', 'app_session=abc; Path=/; HttpOnly');
    expect(response.headers.get('set-cookie')).toContain('app_session=abc');
  });

  it('drops an unsafe return_to from the query and falls back to afterSignInPath', async () => {
    const fx = await createTestIssuer();
    const rp = makeRp(fx, { afterSignInPath: '/home' });
    const started = await rp.start(new Request(`${APP}/auth/sign-in?return_to=%2F%2Fevil.example&max_age=abc`));
    expect(new URL(started.headers.get('location')!).searchParams.has('max_age')).toBe(false);
    const { response, user } = await rp.callback(await roundTrip(fx, started));
    expect(response.headers.get('location')).toBe('/home');
    expect(user.external_id).toBeUndefined();
    expect(user.org_id).toBeUndefined();
  });

  it('a callback without the sign-in cookie throws state_mismatch with a clearCookie', async () => {
    const fx = await createTestIssuer();
    const rp = makeRp(fx);
    const started = await rp.start(new Request(`${APP}/auth/sign-in`));
    const back = await fx.authorize(started.headers.get('location')!);
    const error = await rp.callback(new Request(back.callbackUrl)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AtlasOidcError);
    expect((error as AtlasOidcError).code).toBe('state_mismatch');
    expect((error as AtlasOidcError).clearCookie).toMatch(/Max-Age=0/);
  });

  it('refuses a short secret or an unsafe afterSignInPath at setup', async () => {
    const fx = await createTestIssuer();
    expect(() => makeRp(fx, { secret: 'short' })).toThrow(/32 characters/);
    expect(() => makeRp(fx, { afterSignInPath: 'https://evil.example' })).toThrow(/afterSignInPath/);
  });
});

describe('forwardParams', () => {
  it('forwards only the listed query parameters, merges overrides.extraParams, and refuses owned names at setup', async () => {
    const fx = await createTestIssuer();
    const rp = makeRp(fx, { forwardParams: ['ref', 'utm_source'] });
    const long = 'x'.repeat(513);
    const started = await rp.start(new Request(`${APP}/auth/sign-in?ref=friend42&utm_source=${long}&utm_medium=mail&state=evil`), {
      extraParams: { campaign: 'spring' },
    });
    const p = new URL(started.headers.get('location')!).searchParams;
    expect(p.get('ref')).toBe('friend42');
    expect(p.get('campaign')).toBe('spring');
    expect(p.has('utm_source')).toBe(false); // over 512 characters
    expect(p.has('utm_medium')).toBe(false); // not listed
    expect(p.get('state')).not.toBe('evil');
    // The sign-in still completes with the forwarded parameter on the authorize URL.
    const { user } = await rp.callback(await roundTrip(fx, started));
    expect(user.sub).toBeTruthy();

    for (const bad of ['state', 'redirect_uri', 'scope', 'return_to', 'bad name', '']) {
      expect(() => makeRp(fx, { forwardParams: [bad] })).toThrow(/forwardParams/);
    }
  });
});

describe('handle', () => {
  it('routes sign-in, callback and sign-out, and returns null for anything else', async () => {
    const fx = await createTestIssuer();
    const signedIn: Array<{ sub: string; sid: string | null; idToken: string; path: string }> = [];
    const rp = makeRp(fx, {
      onSignedIn: (user, tokens, request, result) => {
        signedIn.push({ sub: user.sub, sid: user.sid, idToken: tokens.id_token, path: new URL(request.url).pathname });
        result.response.headers.append('set-cookie', 'app_session=abc; Path=/; HttpOnly');
      },
      onSignOut: () => ({ idToken: 'id.token.hint', setCookies: ['app_session=; Path=/; Max-Age=0'] }),
    });

    expect(await rp.handle(new Request(`${APP}/dashboard`))).toBeNull();
    expect(await rp.handle(new Request(`${APP}/auth/sign-in`, { method: 'POST' }))).toBeNull();

    const started = (await rp.handle(new Request(`${APP}/auth/sign-in?return_to=%2Fbilling`)))!;
    expect(started.status).toBe(302);
    const done = (await rp.handle(await roundTrip(fx, started, { sub: 'user_ada', claims: { sid: 'sess_1' } })))!;
    expect(done.status).toBe(302);
    expect(done.headers.get('location')).toBe('/billing');
    const cookies = done.headers.getSetCookie();
    expect(cookies.some((c) => /^atlas_oidc=;.*Max-Age=0/.test(c))).toBe(true);
    expect(cookies).toContain('app_session=abc; Path=/; HttpOnly');
    expect(signedIn).toEqual([{ sub: 'user_ada', sid: 'sess_1', idToken: expect.any(String), path: '/auth/callback' }]);

    for (const method of ['POST', 'GET']) {
      const out = (await rp.handle(new Request(`${APP}/auth/sign-out`, { method })))!;
      expect(out.status).toBe(302);
      expect(new URL(out.headers.get('location')!).searchParams.get('id_token_hint')).toBe('id.token.hint');
      expect(out.headers.getSetCookie()).toContain('app_session=; Path=/; Max-Age=0');
    }
  });

  it('a Response from onSignedIn is used, with the sign-in cookie still cleared', async () => {
    const fx = await createTestIssuer();
    const rp = makeRp(fx, {
      routes: { signIn: '/login', callback: '/auth/callback', signOut: '/logout' },
      onSignedIn: () => Response.redirect(`${APP}/welcome`, 303),
    });
    expect(await rp.handle(new Request(`${APP}/auth/sign-in`))).toBeNull();
    const started = (await rp.handle(new Request(`${APP}/login`)))!;
    const done = (await rp.handle(await roundTrip(fx, started)))!;
    expect(done.status).toBe(303);
    expect(done.headers.get('location')).toBe(`${APP}/welcome`);
    expect(done.headers.getSetCookie().some((c) => /^atlas_oidc=;.*Max-Age=0/.test(c))).toBe(true);
    expect((await rp.handle(new Request(`${APP}/logout`, { method: 'POST' })))!.status).toBe(302);
  });

  it('a failed callback answers 400 (or onSignInError) and clears the sign-in cookie; handle needs onSignedIn', async () => {
    const fx = await createTestIssuer();
    const plain = makeRp(fx, { onSignedIn: () => undefined });
    const failed = (await plain.handle(new Request(`${APP}/auth/callback?code=x&state=y`)))!;
    expect(failed.status).toBe(400);
    expect(failed.headers.get('set-cookie')).toMatch(/^atlas_oidc=;.*Max-Age=0/);

    const seen: string[] = [];
    const custom = makeRp(fx, {
      onSignedIn: () => undefined,
      onSignInError: (error) => {
        seen.push(error.code);
        return Response.redirect(`${APP}/sign-in-failed`, 302);
      },
    });
    const out = (await custom.handle(new Request(`${APP}/auth/callback?code=x&state=y`)))!;
    expect(out.headers.get('location')).toBe(`${APP}/sign-in-failed`);
    expect(out.headers.get('set-cookie')).toMatch(/Max-Age=0/);
    expect(seen).toEqual(['state_mismatch']);

    await expect(makeRp(fx).handle(new Request(`${APP}/auth/sign-in`))).rejects.toThrow(/onSignedIn/);
  });
});

describe('requireRecentAuth', () => {
  it('passes a recent sign-in and redirects an old one, bound to the same user', async () => {
    const fx = await createTestIssuer();
    const rp = makeRp(fx);
    const nowSec = Math.floor(Date.now() / 1000);
    const here = new Request(`${APP}/settings/transfer?team=7`);
    expect(await rp.requireRecentAuth(here, 300, { sub: 'user_ada', authTime: nowSec - 10 })).toBeNull();

    const step = await rp.requireRecentAuth(here, 300, { sub: 'user_ada', authTime: nowSec - 3600 });
    expect(step?.status).toBe(302);
    const p = new URL(step!.headers.get('location')!).searchParams;
    expect(p.get('max_age')).toBe('300');
    expect(p.has('prompt')).toBe(false);

    // Same user, fresh auth_time: accepted, back to where the user was.
    const ok = await rp.callback(await roundTrip(fx, step!, { sub: 'user_ada' }));
    expect(ok.response.headers.get('location')).toBe('/settings/transfer?team=7');
    // Another account: refused.
    const step2 = await rp.requireRecentAuth(here, 300, { sub: 'user_ada', authTime: null });
    const err = await rp.callback(await roundTrip(fx, step2!, { sub: 'user_eve' })).catch((e: unknown) => e);
    expect((err as AtlasOidcError).code).toBe('subject_mismatch');
    // An old auth_time coming back (the server skipped the re-auth): refused.
    const step3 = await rp.requireRecentAuth(here, 300, { sub: 'user_ada', authTime: null });
    const err3 = await rp.callback(await roundTrip(fx, step3!, { sub: 'user_ada', claims: { auth_time: nowSec - 3600 } })).catch((e: unknown) => e);
    expect((err3 as AtlasOidcError).code).toBe('reauthentication_required');
  });

  it('maxAge 0 asks with prompt=login, and lets the request back from the confirmation through', async () => {
    const fx = await createTestIssuer();
    const rp = makeRp(fx);
    const nowSec = Math.floor(Date.now() / 1000);
    expect(await rp.requireRecentAuth(new Request(`${APP}/delete`), 0, { sub: 'user_ada', authTime: nowSec - 5 })).toBeNull();
    const step = await rp.requireRecentAuth(new Request(`${APP}/delete`), 0, { sub: 'user_ada', authTime: nowSec - 120 });
    const p = new URL(step!.headers.get('location')!).searchParams;
    expect(p.get('prompt')).toBe('login');
    expect(p.get('max_age')).toBe('0');
    await expect(rp.requireRecentAuth(new Request(`${APP}/x`), -5, { sub: 'u', authTime: 0 })).rejects.toThrow(/maxAgeSeconds/);
  });
});

describe('touchIfDue', () => {
  it('skips inside the interval, then touches with the secret key', async () => {
    const fx = await createTestIssuer();
    let now = 1_800_000_000_000;
    const api = withApi(fx, () => json(200, { object: 'session', id: 'sess_1', idle_expires_at: '2027-01-15T00:00:00.000Z', extended: true }));
    const rp = makeRp(fx, { fetchImpl: api.fetchImpl, secretKey: 'sk_test_1', apiUrl: `${API}/`, now: () => now, touchIntervalMs: 60_000 });

    expect(await rp.touchIfDue('sess_1', now - 30_000)).toEqual({ status: 'skipped', lastTouchedAt: now - 30_000 });
    expect(api.calls).toHaveLength(0);
    const first = await rp.touchIfDue('sess_1', null);
    expect(first).toEqual({ status: 'touched', lastTouchedAt: now, idleExpiresAt: '2027-01-15T00:00:00.000Z' });
    expect(api.calls[0]).toEqual({ method: 'POST', url: `${API}/v1/sessions/sess_1/touch`, auth: 'Bearer sk_test_1' });
    now += 61_000;
    expect((await rp.touchIfDue('sess_1', now - 61_000)).status).toBe('touched');
    // A lastTouchedAt in the future (clock skew between servers) does not suppress the touch forever.
    expect((await rp.touchIfDue('sess_1', now + 3_600_000)).status).toBe('touched');
  });

  it('reports an ended session by reason and throws on anything else', async () => {
    const fx = await createTestIssuer();
    const answers: Record<string, Response> = {
      sess_revoked: json(409, { errors: [{ code: 'SESSION_REVOKED', message: 'ended' }] }),
      sess_idle: json(409, { errors: [{ code: 'SESSION_IDLE_EXPIRED', message: 'timed out' }] }),
      sess_old: json(409, { errors: [{ code: 'SESSION_EXPIRED', message: 'expired' }] }),
      sess_gone: json(404, { errors: [{ code: 'NOT_FOUND', message: 'Unknown session.' }] }),
      sess_key: json(401, { errors: [{ code: 'UNAUTHORIZED', message: 'bad key' }] }),
    };
    const api = withApi(fx, (c) => answers[c.url.split('/')[5]!]!);
    const rp = makeRp(fx, { fetchImpl: api.fetchImpl, secretKey: 'sk_test_1', apiUrl: API });
    expect(await rp.touchIfDue('sess_revoked', null)).toEqual({ status: 'ended', reason: 'revoked' });
    expect(await rp.touchIfDue('sess_idle', null)).toEqual({ status: 'ended', reason: 'idle_expired' });
    expect(await rp.touchIfDue('sess_old', null)).toEqual({ status: 'ended', reason: 'expired' });
    expect(await rp.touchIfDue('sess_gone', null)).toEqual({ status: 'ended', reason: 'not_found' });
    const err = await rp.touchIfDue('sess_key', null).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AtlasApiError);
    expect((err as AtlasApiError).status).toBe(401);
    await expect(makeRp(fx).touchIfDue('sess_1', null)).rejects.toThrow(/secretKey/);
  });
});

describe('signOut and revokeSession', () => {
  it('revokes the sid server-side, then redirects to the end-session endpoint', async () => {
    const fx = await createTestIssuer();
    const api = withApi(fx, (c) => (c.url.includes('sess_gone') ? json(404, { errors: [] }) : json(200, { object: 'session', id: 'sess_1', status: 'revoked' })));
    const rp = makeRp(fx, { fetchImpl: api.fetchImpl, secretKey: 'sk_test_1', apiUrl: API });
    const res = await rp.signOut({ idToken: 'id.token.hint', sid: 'sess_1', state: 's1' });
    expect(api.calls[0]).toMatchObject({ method: 'POST', url: `${API}/v1/sessions/sess_1/revoke` });
    expect(res.status).toBe(302);
    const u = new URL(res.headers.get('location')!);
    expect(`${u.origin}${u.pathname}`).toBe(fx.endpoints.endSession);
    expect(u.searchParams.get('id_token_hint')).toBe('id.token.hint');
    expect(u.searchParams.get('post_logout_redirect_uri')).toBe(`${APP}/`);
    expect(u.searchParams.get('client_id')).toBe(fx.clientId);
    expect(u.searchParams.get('state')).toBe('s1');
    expect(await rp.revokeSession('sess_gone')).toBe('not_found');
    expect(await rp.revokeSession('sess_1')).toBe('revoked');
  });

  it('without a secret key, only redirects', async () => {
    const fx = await createTestIssuer();
    const res = await makeRp(fx).signOut({ sid: 'sess_1' });
    expect(res.status).toBe(302);
  });

  it('a failed revoke fails the sign-out instead of pretending the session ended', async () => {
    const fx = await createTestIssuer();
    const api = withApi(fx, () => json(503, { errors: [{ code: 'UNAVAILABLE', message: 'try later' }] }));
    const rp = makeRp(fx, { fetchImpl: api.fetchImpl, secretKey: 'sk_test_1', apiUrl: API });
    await expect(rp.signOut({ sid: 'sess_1' })).rejects.toBeInstanceOf(AtlasApiError);
  });

  it('serverSignOut: one client logout call, then straight to the post-logout URI with state', async () => {
    const fx = await createTestIssuer();
    const bodies: string[] = [];
    const api = withApi(fx, () => json(200, { object: 'oauth_client_logout', session: 'revoked' }));
    const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (typeof init?.body === 'string') bodies.push(init.body);
      return api.fetchImpl(input, init);
    }) as typeof fetch;
    const rp = makeRp(fx, { fetchImpl, secretKey: 'sk_test_1', apiUrl: API, serverSignOut: true });
    const res = await rp.signOut({ idToken: 'id.token.hint', sid: 'sess_1', state: 's1' });
    expect(api.calls).toHaveLength(1);
    expect(api.calls[0]).toMatchObject({
      method: 'POST',
      url: `${API}/v1/oauth_clients/${encodeURIComponent(fx.clientId)}/logout`,
      auth: 'Bearer sk_test_1',
    });
    expect(JSON.parse(bodies[0]!)).toEqual({ sid: 'sess_1' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`${APP}/?state=s1`);
  });

  it('serverSignOut: a session already gone (404) still signs out; other failures throw', async () => {
    const fx = await createTestIssuer();
    const gone = withApi(fx, () => json(404, { errors: [] }));
    const res = await makeRp(fx, { fetchImpl: gone.fetchImpl, secretKey: 'sk_test_1', apiUrl: API, serverSignOut: true, postLogoutRedirectUri: undefined }).signOut({ sid: 'sess_1' });
    expect(res.headers.get('location')).toBe('/');
    const forbidden = withApi(fx, () => json(403, { errors: [{ code: 'FORBIDDEN', message: 'no' }] }));
    const rp = makeRp(fx, { fetchImpl: forbidden.fetchImpl, secretKey: 'sk_test_1', apiUrl: API, serverSignOut: true });
    await expect(rp.signOut({ sid: 'sess_1' })).rejects.toBeInstanceOf(AtlasApiError);
  });
});

describe('runs without Node globals', () => {
  it('nothing the rp entry loads references Buffer (Workers, Deno and browsers have none)', () => {
    // Static: the rp entry and every module it reaches through relative imports.
    // (Deleting globalThis.Buffer at run time breaks the test runner itself.)
    const dir = join(process.cwd(), 'src'); // vitest runs from the package root
    const seen = new Set<string>();
    const visit = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      const src = readFileSync(file, 'utf8');
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      expect(/\bBuffer\b/.test(code), `${file} references Buffer`).toBe(false);
      for (const m of code.matchAll(/from\s+'(\.{1,2}\/[^']+)'/g)) {
        const base = resolve(dirname(file), m[1]!.replace(/\.js$/, ''));
        visit(existsSync(`${base}.ts`) ? `${base}.ts` : join(base, 'index.ts'));
      }
    };
    visit(join(dir, 'rp.ts'));
    expect(seen.size).toBeGreaterThan(3);
  });

  it('start, callback, webhook and logout-token verification work end to end', async () => {
    const fx = await createTestIssuer();
    const rp = makeRp(fx);
    const body = JSON.stringify({ id: 'evt_1', type: 'session.ended', data: { id: 'sess_1' } });
    const ts = Date.now();
    const mac = createHmac('sha256', 'whsec_x').update(`msg_1.${ts}.${body}`).digest('base64');
    const logoutToken = await new SignJWT({
      sid: 'sess_1',
      events: { 'http://schemas.openid.net/event/backchannel-logout': {} },
    })
      .setProtectedHeader({ alg: 'RS256', kid: fx.kid, typ: 'logout+jwt' })
      .setIssuer(fx.issuer)
      .setAudience(fx.clientId)
      .setIssuedAt()
      .setJti('jti_1')
      .sign(fx.privateKey);
    const verifier = new LogoutTokenVerifier({ issuer: fx.issuer, clientId: fx.clientId, jwks: fx.jwks, replayStore: memoryLogoutReplayStore() });

    const started = await rp.start(new Request(`${APP}/auth/sign-in`));
    const { user } = await rp.callback(await roundTrip(fx, started, { claims: { sid: 'sess_1' } }));
    expect(user.sid).toBe('sess_1');
    const hook = await verifyAtlasWebhookRequest(
      new Request(`${APP}/webhooks`, { method: 'POST', body, headers: { 'atlas-id': 'msg_1', 'atlas-timestamp': String(ts), 'atlas-signature': `v1,${mac}` } }),
      { secret: 'whsec_x' },
    );
    expect(hook.verified).toBe(true);
    const first = await verifier.verify(logoutToken);
    expect(first).toEqual({ ok: true, claims: expect.objectContaining({ sid: 'sess_1', jti: 'jti_1' }) });
    expect(await verifier.verify(logoutToken)).toMatchObject({ ok: false, reason: 'replayed' });
  });
});
