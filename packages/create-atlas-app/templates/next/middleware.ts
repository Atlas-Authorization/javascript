import { atlasMiddleware } from '@atlasauth/nextjs';
import { NextResponse, type NextRequest } from 'next/server';

/**
 * Atlas edge middleware. It verifies the session JWT at the edge (no network
 * round-trip on a warm instance) and protects every route by default — anything
 * not listed in `publicRoutes` requires a signed-in user.
 *
 * `atlasMiddleware` returns a handler shaped `(request, response) => ...`; Next's
 * `NextResponse` provides the `next()` / `redirect()` / `json()` surface it
 * expects, so we hand it straight through.
 */
const handle = atlasMiddleware({
  jwksUrl: process.env.ATLAS_JWKS_URL ?? process.env.NEXT_PUBLIC_ATLAS_JWKS_URL ?? '',
  issuer: process.env.ATLAS_ISSUER ?? process.env.NEXT_PUBLIC_ATLAS_ISSUER ?? '',
  publishableKey: process.env.NEXT_PUBLIC_ATLAS_PUBLISHABLE_KEY,
  signInUrl: '/sign-in',
  // Everything else (e.g. /dashboard) requires a session.
  publicRoutes: ['/', '/sign-in(.*)'],
});

export function middleware(request: NextRequest) {
  return handle(
    request as unknown as Parameters<typeof handle>[0],
    NextResponse as unknown as Parameters<typeof handle>[1],
  );
}

export const config = {
  // Run on everything except Next internals and files with an extension.
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\..*).*)'],
};
