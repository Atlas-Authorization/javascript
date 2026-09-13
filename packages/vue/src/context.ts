import { inject, type InjectionKey } from 'vue';
import type { AtlasClient } from './plugin';

/**
 * §10.1 the injected Atlas client.
 *
 * The Vue peer of React's `AtlasContext`. `createAtlas()` provides exactly one
 * `AtlasClient` on the app; every composable and component reaches it through
 * `inject`, so there is a single reactive source of auth truth per app instance
 * — never a module-level singleton that would leak state between two apps (or
 * two SSR requests) sharing a process.
 */
export const ATLAS_INJECTION_KEY: InjectionKey<AtlasClient> = Symbol('atlas');

/**
 * The Vue peer of React's `useAtlas()`.
 *
 * Throws rather than returning a null-ish default. A composable handing back
 * `{ user: null }` outside the plugin is indistinguishable from a signed-out
 * user, and the developer spends an afternoon on it.
 */
export function useAtlas(): AtlasClient {
  const client = inject(ATLAS_INJECTION_KEY, null);
  if (!client) {
    throw new Error('Atlas composables must be used after app.use(createAtlas({ publishableKey })).');
  }
  return client;
}
