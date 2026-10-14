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

## Routing rules

- Routes are protected unless they match `publicRoutes`. `protectedRoutes` wins over `publicRoutes`.
- Patterns support a trailing `(.*)` and whole-segment `:name` parameters. They aren't regular expressions.
- A signed-in user whose short-lived `__session` cookie has expired is let through on the durable signed-in hint, so the client can refresh it. It doesn't bounce to sign-in.

## Changelog

See [CHANGELOG.md](./CHANGELOG.md).
