import { getServerAuth } from '@atlasauth/svelte/server';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = (event) => {
  const auth = getServerAuth(event);
  return { userId: auth.userId, isSignedIn: auth.isSignedIn };
};
