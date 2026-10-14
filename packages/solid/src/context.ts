import { createContext, useContext } from 'solid-js';
import type { AtlasClient } from './provider';

/**
 * The injected Atlas client — the Solid peer of React's `AtlasContext` and Vue's
 * `ATLAS_INJECTION_KEY`.
 *
 * `<AtlasProvider>` puts exactly one `AtlasClient` here, so every accessor and
 * component reaches a single reactive source of auth truth per provider — never
 * a module-level singleton that would leak one request's session into another
 * on an SSR server sharing a process.
 */
export const AtlasContext = createContext<AtlasClient>();

/**
 * Reach the Atlas client from inside the provider tree.
 *
 * Throws rather than handing back a null-ish default. An accessor that returned
 * `{ user: null }` outside the provider is indistinguishable from a signed-out
 * user, and the developer loses an afternoon to it.
 */
export function useAtlas(): AtlasClient {
  const client = useContext(AtlasContext);
  if (!client) {
    throw new Error(
      'Atlas accessors and components must be used inside <AtlasProvider publishableKey="...">.',
    );
  }
  return client;
}
