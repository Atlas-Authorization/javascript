// Step 10: a token for a connected service, minted for this user's session.
import { auth } from '@atlasauth/nextjs/server';
import { atlas } from '@/lib/atlas';

export async function POST() {
  const { sessionId } = await auth();
  if (!sessionId) return Response.json({ error: 'sign_in_required' }, { status: 401 });
  return Response.json(await atlas.sessions.getToken(sessionId, { for: process.env.ATLAS_INTEGRATION ?? 'chatly' }));
}
