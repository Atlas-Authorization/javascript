# @atlasauth/rp

Atlas sign-in for any server, as `(Request) => Response` handlers. Your server sends the user to Atlas's hosted sign-in page, verifies who came back, and keeps its own session.

- One dependency: [`jose`](https://www.npmjs.com/package/jose). Web standards only (fetch, Web Crypto, `Request`, `Response`): no `Buffer`, no `node:*`.
- Runs unchanged on Node 18+, Deno, Bun and Cloudflare Workers.
- State, nonce and PKCE (S256) in one sealed, short-lived, httpOnly cookie. The ID token's algorithm is pinned and `iss`, `aud`/`azp`, `exp`/`iat`, `nonce` and `at_hash` are checked.
- Step-up (`requireRecentAuth`), Atlas session keep-alive (`touchIfDue`), server-side sign-out, back-channel logout and webhook verification.

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

The full guide, with Deno, Bun, Workers, Hono, Express and Fastify examples: [Server-side sign-in without a framework SDK](https://atlasauth.net/docs/server-side-sign-in-hosted-redirect).

## License

MIT
