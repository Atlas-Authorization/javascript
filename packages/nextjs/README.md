# @atlasauth/nextjs

Atlas authentication for Next.js (App Router). It covers route protection in `middleware.ts` (Next 14/15) or `proxy.ts` (Next 16), plus `auth()` and `currentUser()` in server components and route handlers. Session tokens are verified locally against your instance's JWKS, so a warm instance makes no network call.

```bash
npm install @atlasauth/nextjs
```

`next` is an optional peer dependency (`>=13.4`, including 16).

## Next.js 16: `proxy.ts`

```ts
// proxy.ts
import { NextResponse, type NextRequest } from 'next/server';
import { atlasProxy, withAtlasHeaders } from '@atlasauth/nextjs';

const atlas = atlasProxy({
  jwksUrl: 'https://auth.example.com/.well-known/jwks.json',
  issuer: 'https://auth.example.com',
  publicRoutes: ['/', '/sign-in(.*)', '/sign-up(.*)'],
});

export async function proxy(request: NextRequest) {
  return (await atlas(request)) ?? withAtlasHeaders(request, NextResponse.next());
}

export const config = { matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'] };
```

- `atlas(request)` resolves to a `Response` when Atlas has to act (a sign-in redirect, the cross-property handshake, or a JSON 401 for `/api/*`). Otherwise it resolves to `null` and your proxy carries on.
- `withAtlasHeaders(request, response)` forwards the verified session to your app on whatever response the rest of your proxy returns, as `x-atlas-auth-status`, `x-atlas-user-id`, `x-atlas-session-id`, `x-atlas-org-id` and `x-atlas-org-role` request headers. It merges with request-header overrides that other steps have already set, and it always drops `x-atlas-*` headers sent by the client. Read them in a server component with `readAtlasHeaders(await headers())`.
- `proxyAuth(request)` returns the auth state the proxy already resolved, for extra checks inside `proxy.ts`.

**Why `Response | null`?** In Next 16 the proxy is usually a chain (auth, then i18n, then your own logic), so Atlas returns a response only when it must and otherwise steps aside. The session is attached to the final response with `withAtlasHeaders`, and the token is verified only once.

It uses only Web-standard APIs, so it runs on both the Node.js runtime (the Next 16 default) and the Edge runtime.

### With next-intl

```ts
import createMiddleware from 'next-intl/middleware';
import type { NextRequest } from 'next/server';
import { atlasProxy, withAtlasHeaders } from '@atlasauth/nextjs';
import { routing } from './i18n/routing';

const intl = createMiddleware(routing);
const atlas = atlasProxy({
  jwksUrl: 'https://auth.example.com/.well-known/jwks.json',
  issuer: 'https://auth.example.com',
  locales: routing.locales,
  defaultLocale: routing.defaultLocale,
  publicRoutes: ['/', '/:locale', '/:locale/sign-in(.*)'],
  protectedRoutes: ['/:locale/dashboard(.*)'],
  signInUrl: '/:locale/sign-in', // /de/dashboard → /de/sign-in?redirect_url=…
});

export async function proxy(request: NextRequest) {
  return (await atlas(request)) ?? withAtlasHeaders(request, intl(request));
}
```

A `:locale` segment matches only the configured `locales`. Any other `:name` segment matches any single path segment.

## Next.js 14/15: `middleware.ts`

```ts
import { authMiddleware } from '@atlasauth/nextjs';
import { NextResponse, type NextRequest } from 'next/server';

const middleware = authMiddleware({
  jwksUrl: 'https://auth.example.com/.well-known/jwks.json',
  issuer: 'https://auth.example.com',
  publicRoutes: ['/', '/sign-in(.*)'],
});

export default function (request: NextRequest) {
  return middleware(request, NextResponse);
}
```

`atlasMiddleware` is the same function as `authMiddleware`.

## Server components and route handlers

```ts
import { auth, currentUser } from '@atlasauth/nextjs/server';

const { userId, protect } = await auth();
const user = await currentUser(); // from the verified session claims, no network call
```

These read `ATLAS_JWKS_URL` and `ATLAS_ISSUER` (or their `NEXT_PUBLIC_` forms) from the environment.

## Sign-in panel ready on first paint

```tsx
// app/layout.tsx (a Server Component)
import { getAtlasInitialState } from '@atlasauth/nextjs/server';

const initialState = await getAtlasInitialState();
// …pass it to the client component that renders <AtlasProvider initialState={initialState}>
```

`getAtlasInitialState()` fetches the instance's public sign-in data (`/v1/appearance` and `/v1/client/environment`) on the server, cached for 60 seconds (`revalidate`). With it, `<SignIn />` renders styled and with its social buttons in the server HTML. It reads `ATLAS_PUBLISHABLE_KEY` and `ATLAS_FRONTEND_API` (or their `NEXT_PUBLIC_` forms) and never throws: anything it can't fetch within `timeoutMs` (1500 ms) is left for the browser.

## CSRF protection

```ts
const atlas = atlasProxy({ ...config, csrf: true });
export async function proxy(req: NextRequest) {
  return (await atlas(req)) ?? withAtlasHeaders(req, NextResponse.next());
}
```

For a signed-in browser the proxy keeps a token bound to the session in the `__atlas_csrf` cookie, and refuses a `POST`, `PUT`, `PATCH` or `DELETE` without it with `403` (`CSRF_TOKEN_INVALID`). Send the token in the `x-atlas-csrf` header (read it from the cookie) or as an `atlas_csrf` form field. In a server component, `readAtlasHeaders(await headers()).csrfToken` gives it for rendering a form.

- Requests with `Authorization: Bearer`, signed-out requests and your path mount (`mountBasePath`, default `ATLAS_BASE_PATH` or `/atlas`) are exempt.
- The secret is `ATLAS_CSRF_SECRET`, or derived from `ATLAS_SECRET_KEY`. Use the same one with `verifyCsrf` from `@atlasauth/backend` in your own handlers.
- `withAtlasHeaders` sets the cookie, so call it on the response your proxy returns.

## Frontend API on your own domain (path mount)

Serve Atlas under a path of your app, with no DNS record and no reverse proxy of your own. Claim the host with `method: "path"` and a `base_path` such as `/atlas`, then add two route handlers:

```ts
// app/atlas/[[...path]]/route.ts
import { createMountHandler } from '@atlasauth/nextjs/server';
export const { GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD } = createMountHandler({ basePath: '/atlas' });
```

```ts
// app/.well-known/atlas-verify/[token]/route.ts
import { createVerifyHandler } from '@atlasauth/nextjs/server';
export const { GET } = createVerifyHandler();
```

Set `ATLAS_UPSTREAM` (your instance's Frontend API host, from the domain's `instructions.upstream`), `ATLAS_PROXY_SECRET` (from `POST /v1/instance/proxy_secret`) and `ATLAS_VERIFY_TOKEN` (the domain's `verification.token`).

Use a base path without a leading underscore, such as `/atlas`. The App Router treats folders starting with `_` as private and never routes them, so the default `/__atlas` doesn't work in Next.js.

The handler forwards the method, path, query and body, drops any incoming `X-Atlas-*`, `X-Forwarded-*`, `Forwarded` and `X-Real-IP` headers, sets `X-Atlas-Forwarded-Host` and `X-Atlas-Proxy-Secret` itself, and returns every `Set-Cookie` and redirect unchanged. The client IP (`X-Atlas-Client-IP` and `X-Forwarded-For`) is the incoming `X-Forwarded-For` entry `trustedProxyHops` places from the right (default `1`: the entry your nearest proxy appended; entries further left are browser-controlled and ignored; `0` forwards none), or whatever `clientIp(request)` returns when you pass it; values that are not IP addresses are dropped. Without `ATLAS_UPSTREAM` or `ATLAS_PROXY_SECRET` the mount answers 503 and logs the missing variable once. Both handlers are also exported from `@atlasauth/nextjs`.

## Routing rules

- Routes are protected unless they match `publicRoutes`. `protectedRoutes` wins over `publicRoutes`.
- Patterns support a trailing `(.*)` and whole-segment `:name` parameters. They aren't regular expressions.
- A signed-in user whose short-lived `__session` cookie has expired is let through on the durable signed-in hint, so the client can refresh it. It doesn't bounce to sign-in.

## Changelog

See [CHANGELOG.md](./CHANGELOG.md).
