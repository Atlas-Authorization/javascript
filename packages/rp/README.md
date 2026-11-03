# @atlasauth/rp

Atlas sign-in for any server, as `(Request) => Response` handlers. Your server sends the user to Atlas's hosted sign-in page, verifies who came back, and keeps its own session.

- One dependency: [`jose`](https://www.npmjs.com/package/jose). Web standards only (fetch, Web Crypto, `Request`, `Response`): no `Buffer`, no `node:*`.
- Runs unchanged on Node 18+, Deno, Bun and Cloudflare Workers.
- State, nonce and PKCE (S256) in one sealed, short-lived, httpOnly cookie. The ID token's algorithm is pinned and `iss`, `aud`/`azp`, `exp`/`iat`, `nonce` and `at_hash` are checked.
- Step-up (`requireRecentAuth`), session keep-alive (`touchIfDue`), server-side sign-out, back-channel logout with a sid store, webhook verification, and an offline mock issuer for tests.

It is the same code as `@atlasauth/backend/rp`; use this package when you do not need the rest of `@atlasauth/backend`.

```bash
npm install @atlasauth/rp
```

## One handler for sign-in, callback and sign-out

```ts
import { createRelyingParty } from '@atlasauth/rp';

const rp = createRelyingParty({
  issuer: process.env.ATLAS_ISSUER!,              // https:// + your Frontend API host
  clientId: process.env.ATLAS_CLIENT_ID!,
  clientSecret: process.env.ATLAS_CLIENT_SECRET!,
  redirectUri: 'https://app.example.com/auth/callback',
  secret: process.env.SESSION_SECRET!,            // 32+ characters, seals the sign-in cookie
  secretKey: process.env.ATLAS_SECRET_KEY,        // optional: server-side revoke and keep-alive
  postLogoutRedirectUri: 'https://app.example.com/',
  forwardParams: ['ref', 'utm_source'],           // optional: passed on to /oauth2/authorize

  // Your session, your cookie. Return nothing to send the user to their return path.
  async onSignedIn(user, tokens, request, result) {
    const cookie = await sessions.create({ sub: user.sub, sid: user.sid, idToken: tokens.id_token });
    result.response.headers.append('set-cookie', cookie);
  },
  async onSignOut(request) {
    const session = await sessions.end(request);
    return { sid: session?.sid, idToken: session?.idToken, setCookies: [sessions.clearCookie] };
  },
});

// Answers GET /auth/sign-in, GET /auth/callback and POST (or GET) /auth/sign-out; null for anything else.
const response = await rp.handle(request);
```

`/auth/sign-in?return_to=/billing&prompt=create` opens the sign-up screen and comes back to `/billing`. `prompt`, `login_hint`, `ui_locales`, `max_age`, `organization` and the `forwardParams` you list are passed on; anything else on the URL is dropped. Set other paths with `routes: { signIn, callback, signOut }`.

A failed callback answers `400` (or what `onSignInError(error, request)` returns) and always clears the sign-in cookie.

## Or route it yourself

```ts
const started = await rp.start(request);                         // 302 to /oauth2/authorize
const { user, tokens, response } = await rp.callback(request);   // throws AtlasOidcError
const stepUp = await rp.requireRecentAuth(request, 300, { sub: user.sub, authTime: user.auth_time });
const touch = await rp.touchIfDue(user.sid!, lastTouchedAt);     // 'skipped' | 'touched' | 'ended'
const out = await rp.signOut({ idToken: tokens.id_token, sid: user.sid });
```

## Sign in with Atlas

Sign in with Atlas apps use the issuer `https://atlasauth.net` and the client id and secret you got when you registered the app. There is no instance secret key: leave `secretKey` out.

```ts
const rp = createRelyingParty({
  issuer: 'https://atlasauth.net',
  clientId: process.env.ATLAS_CLIENT_ID!,
  clientSecret: process.env.ATLAS_CLIENT_SECRET!,
  redirectUri: 'https://app.example.com/auth/callback',
  secret: process.env.SESSION_SECRET!,
  onSignedIn: async (user, tokens, request, result) => { /* create your session */ },
});
```

Without a `secretKey`, `touchIfDue(sid, lastTouchedAt)` keeps **your app's own sign-in** alive with the client credentials (`POST https://atlasauth.net/oauth2/session/touch`, authenticated like the token endpoint: `client_secret_basic` by default, or `clientAuth: 'client_secret_post'`). A sid with no live sign-in of your app comes back as `{ status: 'ended', reason: 'not_found' }`: end your session.

`rp.endAppSession(sid)` ends your app's sign-in under that sid from the server (`POST /oauth2/session/end`): its refresh tokens are revoked and Atlas sends your app a back-channel logout, so every one of your servers hears it. The user's Atlas session and other apps stay signed in. It returns `'ended'` or `'not_found'`.

Both need a confidential client: with no `clientSecret` (or `clientAuth: 'none'`) they throw a `TypeError`. With a `secretKey`, `touchIfDue` and `revokeSession` work on the Atlas session through the Backend API, as before.

## Back-channel logout with a sid store

When a session ends at Atlas (signed out elsewhere, revoked, the user removed), Atlas POSTs a signed `logout_token` naming its `sid`. Record which of your sessions each `sid` backs, and the relying party ends exactly those:

```ts
import { createRelyingParty, sqlSidStore } from '@atlasauth/rp';

const rp = createRelyingParty({
  // ...settings as above
  sidStore: sqlSidStore({ query: (sql, params) => pool.query(sql, params) }),
  routes: { backchannelLogout: '/auth/backchannel-logout' }, // handle() answers POSTs here
  async onSignedIn(user, tokens, request, result) {
    const session = await sessions.create({ sub: user.sub });
    await rp.bindSession(user.sid!, session.id, session.expiresAt);
    result.response.headers.append('set-cookie', session.cookie);
  },
  async onBackchannelLogout(appSessionIds, claims) {
    await sessions.endMany(appSessionIds); // [] when no sid matched: end by claims.sub if you need to
  },
});
```

- Bind when you create your session, after MFA if you gate on it. A step-up keeps the same `sid`; bind again only if you rotate your session id then.
- `rp.backchannelLogout(request)` verifies the token (issuer, client id, signature, event, no nonce), takes the sessions bound to its `sid` and calls `onBackchannelLogout`. It answers `200`, `400` for a bad token (not retried), or `503` when the keys could not be loaded or your callback threw (Atlas retries; the bindings are kept for the retry).
- `memorySidStore()` is for one process. `sqlSidStore({ query })` works with any PostgreSQL client whose `query(sql, params)` returns `{ rows }`, on this table:

```sql
create table atlas_rp_sessions (
  sid text not null,
  app_session_id text not null,
  expires_at timestamptz not null,
  primary key (sid, app_session_id)
);
```

Or implement `SidStore` yourself: `bind(sid, appSessionId, expiresAt)` and `take(sid)` (return and remove every unexpired binding).

## Testing

`@atlasauth/rp/testing` is an offline issuer: no network, no Atlas account.

```ts
import { createRelyingParty } from '@atlasauth/rp';
import { mockIssuer } from '@atlasauth/rp/testing';

const issuer = await mockIssuer({ issuer: 'https://atlasauth.net', clientId: 'client_test' }); // alg: 'RS256' (default) or 'ES256'
const rp = createRelyingParty({ ...settings, issuer: issuer.issuer, clientId: issuer.clientId, clientSecret: 'any', fetchImpl: issuer.fetch });

issuer.nextClaims = { sub: 'user_1', sid: 'sid_1', email: 'ada@example.com' };
const started = await rp.start(new Request('https://app.test/auth/sign-in'));
const callbackUrl = issuer.authorize(started.headers.get('location')!);
const cookie = started.headers.get('set-cookie')!.split(';')[0];
const { user } = await rp.callback(new Request(callbackUrl, { headers: { cookie } }));

const logout = await issuer.logoutToken({ sid: 'sid_1' });
await rp.backchannelLogout(new Request('https://app.test/auth/backchannel-logout', {
  method: 'POST',
  body: new URLSearchParams({ logout_token: logout }),
}));
```

`issuer.fetch` answers discovery, the JWKS, the token endpoint (PKCE checked, codes single use) and `/oauth2/session/touch` and `/end` (for sids it has issued); anything else is `404`. `issuer.idToken(claims)` signs an ID token on its own; `issuer.jwks` and `issuer.discovery` are there for other verifiers.

The full guide, with Deno, Bun, Workers, Hono, Express and Fastify examples: [Server-side sign-in without a framework SDK](https://atlasauth.net/docs/server-side-sign-in-hosted-redirect).

## License

MIT
