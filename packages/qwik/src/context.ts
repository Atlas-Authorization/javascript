import { createContextId, useContext } from '@builder.io/qwik';
import type { AtlasStore } from './store';

/**
 * The Qwik context id carrying the Atlas store.
 *
 * The peer of React's `AtlasContext` / Vue's injection key. `<AtlasProvider>`
 * calls `useContextProvider(AtlasContextId, store)` exactly once; every hook and
 * component reaches the single store through `useContext`, so there is one
 * reactive source of auth truth per provider — never a module-level singleton
 * that would leak state between two apps (or two SSR requests) in one process.
 */
export const AtlasContextId = createContextId<AtlasStore>('atlasauth.store');

/**
 * Read the Atlas store from context.
 *
 * Throws rather than returning a null-ish default. A hook handing back
 * `{ user: null }` outside the provider is indistinguishable from a signed-out
 * user, and the developer spends an afternoon on it.
 */
export function useAtlas(): AtlasStore {
  const store = useContext(AtlasContextId, null);
  if (!store) {
    throw new Error(
      'Atlas hooks must be used inside <AtlasProvider publishableKey="pk_…"> (did you forget to render it?).',
    );
  }
  return store;
}
