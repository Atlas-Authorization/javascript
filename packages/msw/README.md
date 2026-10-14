# @atlasauth/msw

[Mock Service Worker](https://mswjs.io) (`msw` v2) request handlers that mock
Atlas's **Frontend API** (FAPI, the publishable-key browser surface) and
**Backend API** (BAPI, the secret-key administrative surface), so you can test
your Atlas integration against realistic, shape-correct responses **without a
live server**. The MSW peer of [`@atlasauth/testing`](../testing).

The handlers are backed by a small **in-memory mock backend** that advances
across calls: a sign-in attempt really transitions `prepare → attempt →
complete`, a minted session really authenticates `GET /v1/client/me`, and a user
you create over the BAPI really appears in the next list. Ids are deterministic,
so a test that seeds the same thing gets the same ids every run.

## Install

```sh
pnpm add -D @atlasauth/msw msw
```

`msw` is a **peer dependency** — you bring the version your project already uses
(v2).

## Usage

```ts
import { setupServer } from 'msw/node';
import { atlasHandlers, createAtlasMock } from '@atlasauth/msw';

const mock = createAtlasMock({
  instance: {
    fapiBaseUrl: 'https://fapi.atlas.test', // the origin your SDK calls
    bapiBaseUrl: 'https://api.atlas.test',
    publishableKey: 'pk_test_…',
    secretKey: 'sk_test_…',
    firstFactors: ['password', 'email_code'],
  },
  users: [{ email: 'ada@example.com', password: 'hunter2', firstName: 'Ada' }],
  organizations: [{ name: 'Acme', slug: 'acme' }],
});

const server = setupServer(...atlasHandlers(mock));

beforeAll(() => server.listen());
afterEach(() => {
  server.resetHandlers();
  mock.reset(); // back to the original seed
});
afterAll(() => server.close());
```

In the browser (component tests, Storybook) use `setupWorker` from `msw/browser`
with the same `atlasHandlers(mock)`.

### Driving the mock

`createAtlasMock(seed?)` returns a mutable store you can inspect and mutate
directly:

```ts
mock.addUser({ email: 'grace@example.com', password: 'hopper' });
mock.addOrganization({ name: 'Globex', members: [{ userId, role: 'admin' }] });
mock.createSession(userId); // mint a live session out of band
mock.reset();               // restore the original seed (ids realign)

mock.users;          // the current users
mock.sessions;       // the live sessions
mock.fapiBaseUrl;    // the FAPI origin the handlers are mounted on
```

Email-code and sign-up verification accept one fixed OTP — `instance.testOtp`,
default **`424242`** — so a happy-path test needs no mailbox.

`atlasHandlers(mock, { fapiBaseUrl, bapiBaseUrl })` overrides the origins the
handlers mount on without changing the store.

## Covered endpoints

Breadth is weighted toward the commonly-tested surface: environment bootstrap,
the full sign-in / sign-up happy paths, `me`, JWKS, and BAPI users / orgs /
sessions.

### Frontend API (publishable key — `x-publishable-key` header or `?publishable_key`)

| Method & path | What it does |
| --- | --- |
| `GET /v1/client/environment` | Enabled first factors + social providers (the seeded instance config) |
| `GET /v1/client` | Session boot — `session: null` until signed in, otherwise the active session + user + memberships |
| `POST /v1/client/sign_ins` | Start a sign-in attempt from an identifier |
| `POST /v1/client/sign_ins/:id/prepare_first_factor` | Send an email/phone code; returns a `poll_secret` |
| `POST /v1/client/sign_ins/:id/attempt_first_factor` | Present `password` or `code`; on success completes + returns a `ticket` |
| `GET /v1/client/sign_ins/:id?poll_secret=…` | Poll an attempt (cross-device) |
| `POST /v1/client/sign_ups` | Start a sign-up (email + password) |
| `POST /v1/client/sign_ups/:id/prepare_verification` | (Re)send the verification code |
| `POST /v1/client/sign_ups/:id/attempt_verification` | Present the code; completes + returns a `ticket` |
| `POST /v1/client/tickets/exchange` | Swap a completed attempt's ticket for a session (`{ jwt, expires_in }`) |
| `GET /v1/client/me` | The signed-in user (`Authorization: Bearer <session jwt>`) |
| `GET /.well-known/jwks.json` | The JWKS the backend verifies tokens against |

### Backend API (secret key — `Authorization: Bearer sk_…`)

| Method & path | What it does |
| --- | --- |
| `GET /v1/users` | Cursor-paginated list (`limit`, `starting_after`) — `{ data, has_more, next_cursor }` |
| `POST /v1/users` | Create a user |
| `GET /v1/users/:id` | Get one user (`404` unknown / soft-deleted; `?include_deleted=true` to see the tombstone) |
| `PATCH /v1/users/:id` | Update profile / metadata / password |
| `DELETE /v1/users/:id` | Soft delete (`{ object: 'user', id, deleted: true }`) |
| `GET /v1/organizations` | Cursor-paginated list |
| `POST /v1/organizations` | Create an organization |
| `GET /v1/organizations/:id` | Get one organization |
| `POST /v1/sessions` | Mint a session for a user in one call (`{ jwt, refresh_token, expires_in }`) |
| `GET /v1/sessions/:id` | Get one session (operator view) |
| `POST /v1/sessions/:id/revoke` | Revoke a session |

Object and error shapes mirror the real API: resources carry their `object`
tag (`user`, `organization`, `session`, `sign_in_attempt`, …), and errors use
the §9.1 envelope `{ errors: [{ code, message, param?, meta?, docs_url }] }`.
`private_metadata` is never serialised.

## Not covered

MFA / second factor, passkeys, OAuth / SSO / SAML, magic-link navigation,
sessions refresh-rotation + multi-account, invitations, and the rest of the BAPI
admin surface. Add your own `http.*` handlers alongside `atlasHandlers(mock)` for
anything your test needs beyond the table above.
