import { redirect } from '@sveltejs/kit';
import { getServerAuth } from '@atlasauth/svelte/server';
import type { PageServerLoad } from './$types';

// A protected route: the server checks the session, never the browser.
export const load: PageServerLoad = (event) => {
  const auth = getServerAuth(event);
  if (!auth.isSignedIn) throw redirect(303, '/');
  return { userId: auth.userId, orgId: auth.orgId };
};
