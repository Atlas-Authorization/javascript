import { describe, expect, it, vi } from 'vitest';
import {
  createMigrationBridge,
  exchangeMigrationSession,
  migrationBapiExchangePath,
  migrationExchangePath,
  parseCookieHeader,
  readSupabaseAccessToken,
  type MigrationBridgeOptions,
} from './migration-bridge';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const b64url = (s: string) => Buffer.from(s, 'utf8').toString('base64url');
/** An unsigned compact JWT carrying `iss` (the bridge only peeks at it; Atlas verifies). */
const jwt = (claims: Record<string, unknown>) => `${b64url('{"alg":"RS256"}')}.${b64url(JSON.stringify(claims))}.sig`;

const SESSION = { object: 'session_tokens', jwt: 'atlas_jwt', refresh_token: 'atlas_rt', session_id: 'sess_1', user_id: 'user_1', expires_in: 60 };

function setup(response: Response, options: Partial<MigrationBridgeOptions> = {}) {
  const calls: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
    return response.clone();
  }) as unknown as typeof fetch;
  const bridge = createMigrationBridge({ source: 'auth0', fapiOrigin: 'https://fapi.example', publishableKey: 'pk_test_x', fetchImpl, ...options });
  return { bridge, calls, fetchImpl };
}

describe('paths', () => {
  it('builds the per-source exchange paths', () => {
    expect(migrationExchangePath('clerk')).toBe('/v1/client/migrations/clerk/exchange');
    expect(migrationBapiExchangePath('cognito')).toBe('/v1/migrations/cognito/exchange');
  });
});

describe('exchangeMigrationSession', () => {
  it('publishable path: FAPI, body delivery; secret path: Backend API with forwarded client', async () => {
    const { calls, fetchImpl } = setup(json(200, SESSION));
    const pub = await exchangeMigrationSession({ source: 'supabase', fapiOrigin: 'https://fapi.example', publishableKey: 'pk', token: 't', fetchImpl, userAgent: 'UA' });
    expect(pub).toEqual({ kind: 'session', jwt: 'atlas_jwt', refreshToken: 'atlas_rt', sessionId: 'sess_1', userId: 'user_1', expiresIn: 60 });
    expect(calls[0]!.url).toBe('https://fapi.example/v1/client/migrations/supabase/exchange');
    expect(calls[0]!.body).toEqual({ token: 't', delivery: 'body' });
    expect(calls[0]!.headers.get('x-publishable-key')).toBe('pk');

    await exchangeMigrationSession({ source: 'supabase', fapiOrigin: 'https://fapi.example', publishableKey: 'pk', secretKey: 'sk_test_1', bapiBaseUrl: 'https://api.example/', token: 't', clientIp: '203.0.113.1', userAgent: 'UA', remember: false, fetchImpl });
    expect(calls[1]!.url).toBe('https://api.example/v1/migrations/supabase/exchange');
    expect(calls[1]!.headers.get('authorization')).toBe('Bearer sk_test_1');
    expect(calls[1]!.headers.get('x-atlas-client-ip')).toBe('203.0.113.1');
    expect(calls[1]!.headers.get('x-atlas-client-user-agent')).toBe('UA');
    expect(calls[1]!.headers.get('x-publishable-key')).toBeNull();
    expect(calls[1]!.body).toEqual({ token: 't', remember: false });
  });

  it('maps refusals, including user_unknown; anything else is unavailable', async () => {
    const run = (r: Response) => exchangeMigrationSession({ source: 'auth0', fapiOrigin: 'https://f', publishableKey: 'pk', token: 't', fetchImpl: (async () => r) as unknown as typeof fetch });
    expect(await run(json(400, { errors: [{ meta: { bridge_outcome: 'user_unknown' } }] }))).toEqual({ kind: 'refused', outcome: 'user_unknown', status: 400 });
    expect(await run(json(200, { object: 'sign_in_attempt', id: 'sia_1', status: 'needs_second_factor' }))).toEqual({ kind: 'needs_mfa', attemptId: 'sia_1', status: 'needs_second_factor' });
    expect(await run(json(429, {}))).toMatchObject({ outcome: 'rate_limited' });
    expect(await run(json(502, { errors: [{ meta: { bridge_outcome: 'weird' } }] }))).toMatchObject({ outcome: 'unavailable', status: 502 });
    const down = await exchangeMigrationSession({ source: 'auth0', fapiOrigin: 'https://f', publishableKey: 'pk', token: 't', fetchImpl: (async () => { throw new Error('x'); }) as unknown as typeof fetch });
    expect(down).toEqual({ kind: 'refused', outcome: 'unavailable', status: 0 });
  });
});

describe('createMigrationBridge', () => {
  it('does nothing (no network) without an old session, or once on Atlas', async () => {
    const { bridge, fetchImpl } = setup(json(200, SESSION));
    expect(await bridge({ headers: { cookie: 'x=1' } })).toEqual({ action: 'none' });
    expect(await bridge({ headers: { cookie: 'appSession=old; __atlas_rt=r' } })).toEqual({ action: 'none' });
    // An Atlas session (a JWT from another issuer) under the shared __session name.
    expect(await bridge({ headers: { cookie: `appSession=old; __session=${jwt({ iss: 'https://fapi.example' })}` } })).toEqual({ action: 'none' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('signs in: Atlas cookies set, the old cookies (wildcards resolved) cleared on their domain', async () => {
    const { bridge, calls } = setup(json(200, SESSION), {
      source: 'cognito',
      presetVars: { region: 'us-east-1', user_pool_id: 'us-east-1_X', client_id: 'abc' },
      oldCookieDomain: '.example.com',
    });
    const cookie = [
      'CognitoIdentityServiceProvider.abc.jane.idToken=idtok',
      'CognitoIdentityServiceProvider.abc.jane.accessToken=at',
      'CognitoIdentityServiceProvider.abc.LastAuthUser=jane',
      'unrelated=1',
    ].join('; ');
    const out = await bridge({ headers: new Headers({ cookie }) });
    expect(calls[0]!.url).toBe('https://fapi.example/v1/client/migrations/cognito/exchange');
    expect(calls[0]!.body.token).toBe('idtok');
    expect(out.action).toBe('signed_in');
    if (out.action !== 'signed_in') return;
    expect(out.cookies.slice(0, 2).map((c) => c.name)).toEqual(['__session', '__atlas_rt']);
    const cleared = out.cookies.filter((c) => c.options.maxAge === 0);
    expect(cleared.map((c) => c.name).sort()).toEqual([
      'CognitoIdentityServiceProvider.abc.LastAuthUser',
      'CognitoIdentityServiceProvider.abc.jane.accessToken',
      'CognitoIdentityServiceProvider.abc.jane.idToken',
    ]);
    expect(cleared.every((c) => c.options.domain === '.example.com')).toBe(true);
  });

  it('needs MFA: clears the spent session and builds the continuation URL', async () => {
    const { bridge } = setup(json(200, { object: 'sign_in_attempt', id: 'sia_2', status: 'needs_mfa_enrollment' }));
    const out = await bridge({ headers: { cookie: 'appSession=old' } });
    expect(out.action).toBe('needs_mfa');
    if (out.action !== 'needs_mfa') return;
    expect(out.cookies.map((c) => c.name)).toContain('appSession');
    expect(out.continuationUrl('https://app.example.com/sign-in')).toBe('https://app.example.com/sign-in?__atlas_attempt=sia_2&__atlas_status=needs_mfa_enrollment');
  });

  it('clears on a final refusal, keeps the cookie when Atlas could not judge', async () => {
    for (const outcome of ['invalid', 'expired', 'reused', 'user_unknown']) {
      const out = await setup(json(400, { errors: [{ meta: { bridge_outcome: outcome } }] })).bridge({ headers: { cookie: 'appSession=old' } });
      expect(out).toMatchObject({ action: 'refused', outcome });
      if (out.action === 'refused') expect(out.cookies.length).toBeGreaterThan(0);
    }
    for (const res of [json(403, { errors: [{ meta: { bridge_outcome: 'closed' } }] }), json(429, {}), json(500, {})]) {
      const kept = await setup(res).bridge({ headers: { cookie: 'appSession=old' } });
      if (kept.action === 'refused') expect(kept.cookies).toEqual([]);
      else throw new Error('expected a refusal');
    }
  });

  it("Clerk: a __session carrying Clerk's issuer is exchanged; Atlas's own __session is left alone", async () => {
    const vars = { frontend_api: 'clerk.example.com' };
    const clerkToken = jwt({ iss: 'https://clerk.example.com', sub: 'user_2abc', sid: 'sess_x' });
    const { bridge, calls } = setup(json(200, SESSION), { source: 'clerk', presetVars: vars });
    const out = await bridge({ headers: { cookie: `__session=${clerkToken}; __client_uat=1` } });
    expect(out.action).toBe('signed_in');
    expect(calls[0]!.body.token).toBe(clerkToken);
    if (out.action === 'signed_in') {
      // The new Atlas __session replaces the old one rather than being cleared after it.
      expect(out.cookies.filter((c) => c.name === '__session')).toHaveLength(1);
      expect(out.cookies[0]!.value).toBe('atlas_jwt');
    }
    const atlasToken = jwt({ iss: 'https://fapi.example', sub: 'user_1' });
    const second = setup(json(200, SESSION), { source: 'clerk', presetVars: vars });
    expect(await second.bridge({ headers: { cookie: `__session=${atlasToken}` } })).toEqual({ action: 'none' });
    expect(await second.bridge({ headers: { cookie: '__session=not-a-jwt' } })).toEqual({ action: 'none' });
    expect(second.fetchImpl).not.toHaveBeenCalled();
  });

  it('Supabase: reads the access token from the (chunked) base64- cookie', async () => {
    const value = `base64-${b64url(JSON.stringify({ access_token: 'sb_access', refresh_token: 'sb_refresh' }))}`;
    const half = Math.ceil(value.length / 2);
    const { bridge, calls } = setup(json(200, SESSION), { source: 'supabase', presetVars: { project_ref: 'abcdefgh' } });
    await bridge({ headers: { cookie: `sb-abcdefgh-auth-token.0=${value.slice(0, half)}; sb-abcdefgh-auth-token.1=${value.slice(half)}` } });
    expect(calls[0]!.body.token).toBe('sb_access');
    const out = await bridge({ headers: { cookie: `sb-abcdefgh-auth-token=${encodeURIComponent(JSON.stringify({ access_token: 'plain_json' }))}` } });
    expect(calls[1]!.body.token).toBe('plain_json');
    if (out.action === 'signed_in') expect(out.cookies.map((c) => c.name)).toContain('sb-abcdefgh-auth-token');
  });

  it('extractToken replaces cookie reading (encrypted vendor cookies)', async () => {
    const extractToken = vi.fn(({ cookies }: { cookies: Record<string, string> }) => (cookies['wos-session'] ? 'unsealed_access_token' : undefined));
    const { bridge, calls } = setup(json(200, SESSION), { source: 'workos', extractToken });
    expect(await bridge({ headers: { cookie: 'other=1' } })).toEqual({ action: 'none' });
    await bridge({ headers: { cookie: 'wos-session=sealed' } });
    expect(calls[0]!.body.token).toBe('unsealed_access_token');
    expect(extractToken).toHaveBeenCalledTimes(2);
  });

  it("reads a bearer token only when its issuer is the vendor's", async () => {
    const { bridge, calls } = setup(json(200, SESSION), { source: 'auth0', presetVars: { domain: 'acme.us.auth0.com', client_id: 'AbCdEf0123456789' } });
    const old = jwt({ iss: 'https://acme.us.auth0.com/', sub: 'auth0|1' });
    await bridge({ headers: { authorization: `Bearer ${old}` } });
    expect(calls).toHaveLength(1);
    expect(await bridge({ headers: { authorization: `Bearer ${jwt({ iss: 'https://other.example' })}` } })).toEqual({ action: 'none' });
    const noBearer = setup(json(200, SESSION), { source: 'auth0', presetVars: { domain: 'acme.us.auth0.com', client_id: 'AbCdEf0123456789' }, bearer: false });
    expect(await noBearer.bridge({ headers: { authorization: `Bearer ${old}` } })).toEqual({ action: 'none' });
  });

  it('explicit cookie names override the preset', async () => {
    const { bridge, calls } = setup(json(200, SESSION), { source: 'custom', cookieNames: ['my_sid'] });
    const out = await bridge({ headers: { cookie: 'my_sid=opaque' } });
    expect(calls[0]!.body.token).toBe('opaque');
    if (out.action === 'signed_in') expect(out.cookies.filter((c) => c.options.maxAge === 0).map((c) => c.name)).toEqual(['my_sid']);
  });
});

describe('cookie helpers', () => {
  it('parseCookieHeader keeps the first occurrence and values with =', () => {
    expect(parseCookieHeader('a=1; b=x=y; a=2; bad')).toEqual({ a: '1', b: 'x=y' });
    expect(parseCookieHeader(undefined)).toEqual({});
  });
  it('readSupabaseAccessToken tolerates garbage', () => {
    expect(readSupabaseAccessToken({ x: 'base64-!!!' }, 'x')).toBeUndefined();
    expect(readSupabaseAccessToken({}, 'x')).toBeUndefined();
    expect(readSupabaseAccessToken({ x: JSON.stringify(['tok', 'refresh']) }, 'x')).toBe('tok');
  });
});
