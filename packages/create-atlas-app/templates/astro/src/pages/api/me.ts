import type { APIRoute } from 'astro';
import { getAuth } from '@atlasauth/astro';

export const GET: APIRoute = (context) => {
  const auth = getAuth(context);
  if (!auth.isSignedIn) return new Response(JSON.stringify({ error: 'unauthenticated' }), { status: 401, headers: { 'content-type': 'application/json' } });
  return new Response(JSON.stringify({ userId: auth.userId, orgId: auth.orgId }), { headers: { 'content-type': 'application/json' } });
};
