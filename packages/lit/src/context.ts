import { createContext } from '@lit/context';
import type { AtlasClient } from './client';
import type { AtlasSnapshot } from './types';

/**
 * What `<atlas-provider>` shares with every element below it. `client` is null on the server and
 * before the provider connects; `snapshot.status` is `loading` until the first boot settles.
 */
export interface AtlasState {
  client: AtlasClient | null;
  snapshot: AtlasSnapshot;
  publishableKey: string;
  frontendApi: string;
}

export const atlasContext = createContext<AtlasState>(Symbol.for('atlasauth.lit.state'));

export const loadingSnapshot: AtlasSnapshot = {
  status: 'loading',
  user: null,
  session: null,
  claims: null,
  memberships: [],
};
