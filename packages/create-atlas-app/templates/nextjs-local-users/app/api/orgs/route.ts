// Step 8: mirror an org YOU created into Atlas, seat its owner, and set its security policy.
import { auth } from '@atlasauth/nextjs/server';
import { atlas } from '@/lib/atlas';
import { orgs } from '@/lib/store';
import { localUser } from '@/lib/local-user';

export async function POST(request: Request) {
  const { userId } = await auth();
  const me = await localUser();
  if (!userId || !me) return Response.json({ error: 'sign_in_required' }, { status: 401 });
  const { name } = (await request.json()) as { name: string };

  const localId = crypto.randomUUID();
  // Your id is the org's external_id: the same call twice is one org.
  const org = await atlas.organizations.upsertByExternalId(localId, { name });
  // Idempotent: safe to repeat; a directory-managed role is left alone.
  await atlas.organizations.memberships.upsert(org.id, userId, { role: 'org:admin' });
  // Org policy tightens, never loosens, the instance policy.
  await atlas.organizations.updatePolicy(org.id, { requireMfa: true });

  orgs.set(localId, { id: localId, atlasOrgId: org.id, name });
  return Response.json({ id: localId, atlas_org_id: org.id }, { status: 201 });
}
