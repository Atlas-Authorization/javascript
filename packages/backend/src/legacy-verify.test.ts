import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  auth0PasswordVerifier,
  clerkPasswordVerifier,
  descopePasswordVerifier,
  handleLegacyVerify,
  oktaPasswordVerifier,
  type LegacyPasswordVerifier,
} from './legacy-verify';

const SECRET = 'whsec_legacy_test';

function signed(body: string, secret = SECRET) {
  const ts = Date.now();
  const mac = createHmac('sha256', secret).update(`evt_1.${ts}.${body}`).digest('base64');
  return { 'atlas-id': 'evt_1', 'atlas-timestamp': String(ts), 'atlas-signature': `v1,${mac}` };
}

const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A fake vendor: routes by `METHOD url` and records each call. */
function fakeVendor(routes: Record<string, (init: RequestInit) => Response>) {
  const calls: Array<{ key: string; body: string }> = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init: RequestInit = {}) => {
    const key = `${init.method ?? 'GET'} ${String(url)}`;
    calls.push({ key, body: String(init.body ?? '') });
    const route = routes[key];
    return route ? route(init) : reply(404, { error: 'not_found' });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

/** Unsigned compact JWT with the given claims (the verifier reads, never trusts, it). */
const idToken = (claims: Record<string, unknown>) =>
  `${Buffer.from('{"alg":"RS256"}').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;

describe('handleLegacyVerify', () => {
  const ok: LegacyPasswordVerifier = async ({ identifier, password }) =>
    password === 'right' ? { email: identifier, external_id: 'old_1' } : null;

  it('answers 200 with the profile for a signed request and a valid password', async () => {
    const body = JSON.stringify({ identifier: 'a@example.com', password: 'right' });
    const out = await handleLegacyVerify({ body, headers: signed(body), secret: SECRET, verify: ok });
    expect(out).toEqual({ status: 200, body: { user: { email: 'a@example.com', external_id: 'old_1' } } });
  });

  it('401 on a wrong password, 400 on a bad signature or body, and a throwing verifier fails closed', async () => {
    const wrong = JSON.stringify({ identifier: 'a@example.com', password: 'nope' });
    expect((await handleLegacyVerify({ body: wrong, headers: signed(wrong), secret: SECRET, verify: ok })).status).toBe(401);
    expect((await handleLegacyVerify({ body: wrong, headers: signed(wrong, 'whsec_other'), secret: SECRET, verify: ok })).status).toBe(400);
    const empty = JSON.stringify({ identifier: '', password: 'x' });
    expect((await handleLegacyVerify({ body: empty, headers: signed(empty), secret: SECRET, verify: ok })).status).toBe(400);
    const boom: LegacyPasswordVerifier = async () => {
      throw new Error('vendor down');
    };
    const body = JSON.stringify({ identifier: 'a@example.com', password: 'right' });
    expect((await handleLegacyVerify({ body, headers: signed(body), secret: SECRET, verify: boom })).status).toBe(401);
  });
});

describe('oktaPasswordVerifier', () => {
  const authn = (status: string) => () =>
    reply(200, {
      status,
      _embedded: { user: { id: '00u1abc', profile: { login: 'Jane@Example.com', firstName: 'Jane', lastName: 'Doe' } } },
    });

  it('treats SUCCESS and post-password states as verified', async () => {
    for (const status of ['SUCCESS', 'MFA_REQUIRED', 'MFA_ENROLL', 'PASSWORD_EXPIRED']) {
      const v = fakeVendor({ 'POST https://acme.okta.com/api/v1/authn': authn(status) });
      const verify = oktaPasswordVerifier({ domain: 'acme.okta.com', fetchImpl: v.fetchImpl });
      expect(await verify({ identifier: 'jane@example.com', password: 'pw' })).toEqual({
        email: 'jane@example.com',
        email_verified: false,
        name: 'Jane Doe',
        external_id: '00u1abc',
      });
      expect(JSON.parse(v.calls[0]!.body)).toMatchObject({ username: 'jane@example.com', password: 'pw' });
    }
  });

  it('refuses 401 E0000004, LOCKED_OUT and a transport error', async () => {
    const bad = fakeVendor({
      'POST https://acme.okta.com/api/v1/authn': () => reply(401, { errorCode: 'E0000004', errorSummary: 'Authentication failed' }),
    });
    expect(await oktaPasswordVerifier({ domain: 'acme.okta.com', fetchImpl: bad.fetchImpl })({ identifier: 'j@e.com', password: 'x' })).toBeNull();
    const locked = fakeVendor({ 'POST https://acme.okta.com/api/v1/authn': authn('LOCKED_OUT') });
    expect(await oktaPasswordVerifier({ domain: 'acme.okta.com', fetchImpl: locked.fetchImpl })({ identifier: 'j@e.com', password: 'x' })).toBeNull();
    const down = (async () => {
      throw new Error('ECONNRESET');
    }) as unknown as typeof fetch;
    expect(await oktaPasswordVerifier({ domain: 'acme.okta.com', fetchImpl: down })({ identifier: 'j@e.com', password: 'x' })).toBeNull();
  });

  it('can verify through the password grant instead', async () => {
    const v = fakeVendor({
      'POST https://acme.okta.com/oauth2/default/v1/token': () =>
        reply(200, { id_token: idToken({ sub: '00u2', email: 'k@example.com', email_verified: true, name: 'K' }) }),
    });
    const verify = oktaPasswordVerifier({ domain: 'acme.okta.com', fetchImpl: v.fetchImpl, passwordGrant: { clientId: '0oa1', clientSecret: 's' } });
    expect(await verify({ identifier: 'k@example.com', password: 'pw' })).toEqual({
      email: 'k@example.com',
      email_verified: true,
      name: 'K',
      external_id: '00u2',
    });
    expect(new URLSearchParams(v.calls[0]!.body).get('grant_type')).toBe('password');
  });
});

describe('auth0PasswordVerifier', () => {
  const route = 'POST https://acme.us.auth0.com/oauth/token';

  it('uses the password-realm grant and reads the ID token', async () => {
    const v = fakeVendor({
      [route]: () => reply(200, { id_token: idToken({ sub: 'auth0|abc', email: 'a@example.com', email_verified: true, given_name: 'A', family_name: 'B' }) }),
    });
    const verify = auth0PasswordVerifier({ domain: 'acme.us.auth0.com', clientId: 'cid', clientSecret: 'cs', realm: 'Username-Password-Authentication', fetchImpl: v.fetchImpl });
    expect(await verify({ identifier: 'a@example.com', password: 'pw' })).toEqual({
      email: 'a@example.com',
      email_verified: true,
      name: 'A B',
      external_id: 'auth0|abc',
    });
    expect(JSON.parse(v.calls[0]!.body)).toMatchObject({
      grant_type: 'http://auth0.com/oauth/grant-type/password-realm',
      realm: 'Username-Password-Authentication',
    });
  });

  it('mfa_required counts as a correct password; invalid_grant does not', async () => {
    const mfa = fakeVendor({ [route]: () => reply(403, { error: 'mfa_required', mfa_token: 'x' }) });
    const verify = (f: typeof fetch) => auth0PasswordVerifier({ domain: 'acme.us.auth0.com', clientId: 'c', realm: 'db', fetchImpl: f });
    expect(await verify(mfa.fetchImpl)({ identifier: 'A@example.com', password: 'pw' })).toEqual({ email: 'a@example.com', email_verified: false });
    const wrong = fakeVendor({ [route]: () => reply(403, { error: 'invalid_grant', error_description: 'Wrong email or password.' }) });
    expect(await verify(wrong.fetchImpl)({ identifier: 'a@example.com', password: 'pw' })).toBeNull();
  });
});

describe('descopePasswordVerifier', () => {
  it('signs in with the project id and maps the user', async () => {
    const v = fakeVendor({
      'POST https://api.descope.com/v1/auth/password/signin': (init) => {
        expect(new Headers(init.headers).get('authorization')).toBe('Bearer P2proj');
        return reply(200, { sessionJwt: 'x', user: { userId: 'U2abc', email: 'd@example.com', verifiedEmail: true, name: 'Dee' } });
      },
    });
    const verify = descopePasswordVerifier({ projectId: 'P2proj', fetchImpl: v.fetchImpl });
    expect(await verify({ identifier: 'd@example.com', password: 'pw' })).toEqual({
      email: 'd@example.com',
      email_verified: true,
      name: 'Dee',
      external_id: 'U2abc',
    });
    const wrong = fakeVendor({ 'POST https://api.descope.com/v1/auth/password/signin': () => reply(401, { errorCode: 'E062108' }) });
    expect(await descopePasswordVerifier({ projectId: 'P2proj', fetchImpl: wrong.fetchImpl })({ identifier: 'd@example.com', password: 'x' })).toBeNull();
  });
});

describe('clerkPasswordVerifier', () => {
  it('finds the user by email and calls verify_password', async () => {
    const user = {
      id: 'user_2abc',
      first_name: 'C',
      last_name: 'L',
      primary_email_address_id: 'idn_1',
      email_addresses: [{ id: 'idn_1', email_address: 'c@example.com', verification: { status: 'verified' } }],
    };
    const v = fakeVendor({
      'GET https://api.clerk.com/v1/users?email_address=c%40example.com&limit=1': () => reply(200, [user]),
      'POST https://api.clerk.com/v1/users/user_2abc/verify_password': (init) =>
        JSON.parse(String(init.body)).password === 'pw' ? reply(200, { verified: true }) : reply(422, { errors: [{ code: 'incorrect_password' }] }),
    });
    const verify = clerkPasswordVerifier({ secretKey: 'sk_test_x', fetchImpl: v.fetchImpl });
    expect(await verify({ identifier: 'c@example.com', password: 'pw' })).toEqual({
      email: 'c@example.com',
      email_verified: true,
      name: 'C L',
      external_id: 'user_2abc',
    });
    expect(await verify({ identifier: 'c@example.com', password: 'bad' })).toBeNull();
    expect(await verify({ identifier: 'username-only', password: 'pw' })).toBeNull();
  });
});
