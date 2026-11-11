import { NextResponse, type NextRequest } from 'next/server';
import { atlasProxy, withAtlasHeaders } from '@atlasauth/nextjs';

// Step 4: verify the session at the edge. csrf: true makes every cookie-authenticated
// POST/PUT/PATCH/DELETE carry the x-atlas-csrf token (the Atlas mount and Bearer calls are exempt).
const atlas = atlasProxy({
  jwksUrl: process.env.ATLAS_JWKS_URL!,
  issuer: process.env.ATLAS_ISSUER!,
  // Atlas's own mount, the webhook and hook receivers (they verify their own signatures) stay public.
  publicRoutes: ['/', '/atlas(.*)', '/.well-known/(.*)', '/api/atlas/(.*)'],
  csrf: true,
});

export async function middleware(request: NextRequest) {
  return (await atlas(request)) ?? withAtlasHeaders(request, NextResponse.next());
}

export const config = { matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'] };
