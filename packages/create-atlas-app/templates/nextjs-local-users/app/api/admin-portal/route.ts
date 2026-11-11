// Step 9: a one-time Admin Portal link for the customer's IT admin (SSO, directory sync, domains).
import { auth } from '@atlasauth/nextjs/server';
import { atlas } from '@/lib/atlas';

export async function POST(request: Request) {
  const { userId, orgId } = await auth();
  if (!userId || !orgId) return Response.json({ error: 'select_an_organization' }, { status: 401 });
  const profileId = process.env.ATLAS_ADMIN_PORTAL_PROFILE_ID;
  if (!profileId) return Response.json({ error: 'ATLAS_ADMIN_PORTAL_PROFILE_ID is not set' }, { status: 503 });
  const ticket = await atlas.ssoOnboarding.createTicket(profileId, { organization_id: orgId });
  return Response.json({ url: ticket.url, expires_at: ticket.expires_at }); // shown once: hand it over now
}
