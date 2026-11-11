// Step 5: the row in YOUR table that belongs to the signed-in Atlas user, created on first request.
import { auth } from '@atlasauth/nextjs/server';
import { AtlasLinkConflictError, syncLocalUser } from '@atlasauth/backend';
import { users, type LocalUser } from './store';

export async function localUser(): Promise<LocalUser | null> {
  const { claims } = await auth();
  if (!claims) return null;
  try {
    const { user } = await syncLocalUser(claims, {
      findBySub: async (sub) => [...users.values()].find((u) => u.atlasSub === sub),
      findByEmail: async (email) => [...users.values()].find((u) => u.email === email),
      subOf: (row) => row.atlasSub,
      // Link by email only when YOUR app proved the address too.
      isLocalEmailVerified: (row) => row.emailVerified,
      link: async (row, sub) => Object.assign(row, { atlasSub: sub }),
      create: async ({ sub, email, email_verified, external_id }) => {
        // The before_user_create hook reserved external_id; reuse it so both sides agree.
        const row = { id: external_id ?? crypto.randomUUID(), atlasSub: sub, email, emailVerified: email_verified, externalId: external_id ?? '' };
        if ([...users.values()].some((u) => u.atlasSub === sub)) throw new Error('duplicate sub');
        users.set(row.id, row);
        return row;
      },
    });
    return user;
  } catch (e) {
    if (e instanceof AtlasLinkConflictError) return null; // this email belongs to another Atlas user
    throw e;
  }
}
