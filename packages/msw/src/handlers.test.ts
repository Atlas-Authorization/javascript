import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { setupServer } from 'msw/node';
import { atlasHandlers } from './handlers';
import { createAtlasMock } from './state';

const FAPI = 'https://fapi.atlas.test';
const BAPI = 'https://api.atlas.test';
const PK = 'pk_test_atlas';
const SK = 'sk_test_atlas';

function freshMock() {
  return createAtlasMock({
    instance: {
      fapiBaseUrl: FAPI,
      bapiBaseUrl: BAPI,
      publishableKey: PK,
      secretKey: SK,
      firstFactors: ['password', 'email_code'],
      socialProviders: [{ provider: 'google', native: true, display_name: 'Google' }],
    },
    users: [
      { email: 'ada@example.com', password: 'correct horse', firstName: 'Ada' },
      { email: 'grace@example.com', password: 'hopper', firstName: 'Grace' },
    ],
    organizations: [{ name: 'Acme', slug: 'acme' }],
  });
}

// A fresh mock + server per test keeps state isolated and deterministic.
let mock = freshMock();
const server = setupServer(...atlasHandlers(mock));

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  server.resetHandlers();
  mock.reset();
});
afterAll(() => server.close());

const fapiHeaders = { 'x-publishable-key': PK, 'content-type': 'application/json' };
const bapiHeaders = { authorization: `Bearer ${SK}`, 'content-type': 'application/json' };

describe('FAPI environment bootstrap', () => {
  it('returns the seeded instance config', async () => {
    const res = await fetch(`${FAPI}/v1/client/environment`, { headers: fapiHeaders });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.object).toBe('environment');
    expect(body.first_factors).toEqual(['password', 'email_code']);
    expect(body.social_providers).toEqual([
      { provider: 'google', native: true, display_name: 'Google' },
    ]);
  });

  it('requires a publishable key', async () => {
    const res = await fetch(`${FAPI}/v1/client/environment`);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.errors[0].code).toBe('VALIDATION_FAILED');
    expect(body.errors[0].param).toBe('publishable_key');
    expect(body.errors[0].docs_url).toContain('/errors/validation_failed');
  });
});

describe('FAPI sign-in happy path (email code)', () => {
  it('advances prepare -> attempt -> complete and yields a session that me reflects', async () => {
    // 1. start
    const start = await fetch(`${FAPI}/v1/client/sign_ins`, {
      method: 'POST',
      headers: fapiHeaders,
      body: JSON.stringify({ identifier: 'ada@example.com' }),
    });
    expect(start.status).toBe(201);
    const attempt = await start.json();
    expect(attempt.object).toBe('sign_in_attempt');
    expect(attempt.status).toBe('needs_first_factor');
    expect(attempt.supported_first_factors).toEqual(['password', 'email_code']);
    expect(attempt.created_session_id).toBeNull();

    // 2. prepare
    const prepare = await fetch(`${FAPI}/v1/client/sign_ins/${attempt.id}/prepare_first_factor`, {
      method: 'POST',
      headers: fapiHeaders,
      body: JSON.stringify({ strategy: 'email_code' }),
    });
    expect(prepare.status).toBe(200);
    const prepared = await prepare.json();
    expect(prepared.status).toBe('needs_first_factor');
    expect(prepared.poll_secret).toBeTruthy();

    // 3. attempt with the mock's fixed OTP
    const attemptRes = await fetch(`${FAPI}/v1/client/sign_ins/${attempt.id}/attempt_first_factor`, {
      method: 'POST',
      headers: fapiHeaders,
      body: JSON.stringify({ strategy: 'email_code', code: '424242' }),
    });
    expect(attemptRes.status).toBe(200);
    const completed = await attemptRes.json();
    expect(completed.status).toBe('complete');
    expect(completed.created_session_id).toBeTruthy();
    expect(completed.ticket).toBeTruthy();

    // 4. exchange the ticket for a session
    const exchange = await fetch(`${FAPI}/v1/client/tickets/exchange`, {
      method: 'POST',
      headers: fapiHeaders,
      body: JSON.stringify({ attempt_id: attempt.id, ticket: completed.ticket }),
    });
    expect(exchange.status).toBe(200);
    const session = await exchange.json();
    expect(session.object).toBe('session');
    expect(session.jwt).toBeTruthy();
    expect(session.expires_in).toBeGreaterThan(0);

    // 5. me reflects the signed-in user (Bearer the session jwt)
    const me = await fetch(`${FAPI}/v1/client/me`, {
      headers: { ...fapiHeaders, authorization: `Bearer ${session.jwt}` },
    });
    expect(me.status).toBe(200);
    const user = await me.json();
    expect(user.object).toBe('user');
    expect(user.first_name).toBe('Ada');
    expect(user.email_addresses[0].email_address).toBe('ada@example.com');
  });

  it('completes a password sign-in and rejects a wrong password', async () => {
    const start = await (
      await fetch(`${FAPI}/v1/client/sign_ins`, {
        method: 'POST',
        headers: fapiHeaders,
        body: JSON.stringify({ identifier: 'grace@example.com' }),
      })
    ).json();

    const bad = await fetch(`${FAPI}/v1/client/sign_ins/${start.id}/attempt_first_factor`, {
      method: 'POST',
      headers: fapiHeaders,
      body: JSON.stringify({ strategy: 'password', password: 'wrong' }),
    });
    expect(bad.status).toBe(400);
    expect((await bad.json()).errors[0].code).toBe('VERIFICATION_FAILED');

    const good = await fetch(`${FAPI}/v1/client/sign_ins/${start.id}/attempt_first_factor`, {
      method: 'POST',
      headers: fapiHeaders,
      body: JSON.stringify({ strategy: 'password', password: 'hopper' }),
    });
    expect(good.status).toBe(200);
    expect((await good.json()).status).toBe('complete');
  });
});

describe('FAPI client boot', () => {
  it('returns session: null before sign-in', async () => {
    const res = await fetch(`${FAPI}/v1/client`, { headers: fapiHeaders });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.object).toBe('client');
    expect(body.session).toBeNull();
    expect(body.user).toBeNull();
  });
});

describe('FAPI sign-up happy path', () => {
  it('creates, verifies, and yields a signed-in user', async () => {
    const start = await fetch(`${FAPI}/v1/client/sign_ups`, {
      method: 'POST',
      headers: fapiHeaders,
      body: JSON.stringify({ email: 'linus@example.com', password: 'torvalds' }),
    });
    expect(start.status).toBe(201);
    const attempt = await start.json();
    expect(attempt.object).toBe('sign_up_attempt');
    expect(attempt.status).toBe('needs_email_verification');

    const verify = await fetch(`${FAPI}/v1/client/sign_ups/${attempt.id}/attempt_verification`, {
      method: 'POST',
      headers: fapiHeaders,
      body: JSON.stringify({ code: '424242' }),
    });
    expect(verify.status).toBe(200);
    const done = await verify.json();
    expect(done.status).toBe('complete');
    expect(done.ticket).toBeTruthy();
  });
});

describe('FAPI JWKS', () => {
  it('returns a well-formed key set', async () => {
    const res = await fetch(`${FAPI}/.well-known/jwks.json`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.keys)).toBe(true);
    expect(body.keys.length).toBeGreaterThan(0);
    const key = body.keys[0];
    expect(key.kty).toBe('RSA');
    expect(key.alg).toBe('RS256');
    expect(key.kid).toBeTruthy();
    expect(key.e).toBe('AQAB');
  });
});

describe('BAPI users', () => {
  it('lists seeded users with the cursor pagination envelope', async () => {
    const res = await fetch(`${BAPI}/v1/users`, { headers: bapiHeaders });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('data');
    expect(body).toHaveProperty('has_more');
    expect(body).toHaveProperty('next_cursor');
    expect(body.data).toHaveLength(2);
    expect(body.data[0].object).toBe('user');
    expect(body.has_more).toBe(false);
    expect(body.next_cursor).toBeNull();
  });

  it('paginates with limit + starting_after', async () => {
    const first = await (
      await fetch(`${BAPI}/v1/users?limit=1`, { headers: bapiHeaders })
    ).json();
    expect(first.data).toHaveLength(1);
    expect(first.has_more).toBe(true);
    expect(first.next_cursor).toBe(first.data[0].id);

    const second = await (
      await fetch(`${BAPI}/v1/users?limit=1&starting_after=${first.next_cursor}`, {
        headers: bapiHeaders,
      })
    ).json();
    expect(second.data).toHaveLength(1);
    expect(second.data[0].id).not.toBe(first.data[0].id);
    expect(second.has_more).toBe(false);
  });

  it('gets one user by id and 404s for an unknown id', async () => {
    const list = await (await fetch(`${BAPI}/v1/users`, { headers: bapiHeaders })).json();
    const id = list.data[0].id;

    const one = await fetch(`${BAPI}/v1/users/${id}`, { headers: bapiHeaders });
    expect(one.status).toBe(200);
    expect((await one.json()).id).toBe(id);

    const missing = await fetch(`${BAPI}/v1/users/user_nope`, { headers: bapiHeaders });
    expect(missing.status).toBe(404);
    expect((await missing.json()).errors[0].code).toBe('NOT_FOUND');
  });

  it('a created user then appears in list and get', async () => {
    const created = await fetch(`${BAPI}/v1/users`, {
      method: 'POST',
      headers: bapiHeaders,
      body: JSON.stringify({
        email_address: 'margaret@example.com',
        email_verified: true,
        first_name: 'Margaret',
      }),
    });
    expect(created.status).toBe(201);
    const user = await created.json();
    expect(user.object).toBe('user');
    expect(user.primary_email).toBe('margaret@example.com');

    const list = await (await fetch(`${BAPI}/v1/users`, { headers: bapiHeaders })).json();
    expect(list.data).toHaveLength(3);
    expect(list.data.map((u: { id: string }) => u.id)).toContain(user.id);

    const fetched = await fetch(`${BAPI}/v1/users/${user.id}`, { headers: bapiHeaders });
    expect((await fetched.json()).first_name).toBe('Margaret');
  });

  it('soft-deletes a user so it drops out of list and get', async () => {
    const list = await (await fetch(`${BAPI}/v1/users`, { headers: bapiHeaders })).json();
    const id = list.data[0].id;
    const del = await fetch(`${BAPI}/v1/users/${id}`, { method: 'DELETE', headers: bapiHeaders });
    expect(del.status).toBe(200);
    expect(await del.json()).toEqual({ object: 'user', id, deleted: true });

    const after = await (await fetch(`${BAPI}/v1/users`, { headers: bapiHeaders })).json();
    expect(after.data).toHaveLength(1);
    const gone = await fetch(`${BAPI}/v1/users/${id}`, { headers: bapiHeaders });
    expect(gone.status).toBe(404);
  });

  it('rejects a missing / wrong secret key', async () => {
    expect((await fetch(`${BAPI}/v1/users`)).status).toBe(401);
    const wrong = await fetch(`${BAPI}/v1/users`, { headers: { authorization: 'Bearer sk_wrong' } });
    expect(wrong.status).toBe(401);
    expect((await wrong.json()).errors[0].code).toBe('INVALID_KEY');
  });
});

describe('BAPI organizations', () => {
  it('lists + gets a seeded organization, 404s for unknown', async () => {
    const list = await fetch(`${BAPI}/v1/organizations`, { headers: bapiHeaders });
    expect(list.status).toBe(200);
    const body = await list.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].object).toBe('organization');
    expect(body.data[0].name).toBe('Acme');

    const one = await fetch(`${BAPI}/v1/organizations/${body.data[0].id}`, { headers: bapiHeaders });
    expect(one.status).toBe(200);

    const missing = await fetch(`${BAPI}/v1/organizations/org_nope`, { headers: bapiHeaders });
    expect(missing.status).toBe(404);
  });

  it('creates an organization that then appears in list', async () => {
    const created = await fetch(`${BAPI}/v1/organizations`, {
      method: 'POST',
      headers: bapiHeaders,
      body: JSON.stringify({ name: 'Globex', slug: 'globex' }),
    });
    expect(created.status).toBe(201);
    const org = await created.json();
    expect(org.name).toBe('Globex');

    const list = await (await fetch(`${BAPI}/v1/organizations`, { headers: bapiHeaders })).json();
    expect(list.data.map((o: { id: string }) => o.id)).toContain(org.id);
  });
});

describe('BAPI sessions', () => {
  it('mints a session for a user and reads it back', async () => {
    const list = await (await fetch(`${BAPI}/v1/users`, { headers: bapiHeaders })).json();
    const userId = list.data[0].id;

    const minted = await fetch(`${BAPI}/v1/sessions`, {
      method: 'POST',
      headers: bapiHeaders,
      body: JSON.stringify({ user_id: userId }),
    });
    expect(minted.status).toBe(201);
    const session = await minted.json();
    expect(session.object).toBe('session');
    expect(session.user_id).toBe(userId);
    expect(session.jwt).toBeTruthy();
    expect(session.refresh_token).toBeTruthy();

    const fetched = await fetch(`${BAPI}/v1/sessions/${session.id}`, { headers: bapiHeaders });
    expect(fetched.status).toBe(200);
    const read = await fetched.json();
    expect(read.status).toBe('active');
    expect(read.user_id).toBe(userId);
  });

  it('refuses minting for an unknown user', async () => {
    const res = await fetch(`${BAPI}/v1/sessions`, {
      method: 'POST',
      headers: bapiHeaders,
      body: JSON.stringify({ user_id: 'user_nope' }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).errors[0].code).toBe('VALIDATION_FAILED');
  });
});

describe('determinism', () => {
  it('mints stable ids across a reset', async () => {
    const a = freshMock();
    const b = freshMock();
    expect(a.users.map((u) => u.id)).toEqual(b.users.map((u) => u.id));
    const before = a.users.map((u) => u.id);
    a.reset();
    expect(a.users.map((u) => u.id)).toEqual(before);
  });
});
