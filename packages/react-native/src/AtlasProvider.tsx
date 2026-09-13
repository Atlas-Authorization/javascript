import {
  createContext,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { AtlasStore, createAtlasStore, type AtlasStoreState } from './store';
import type { TokenStorage } from './storage';

/**
 * `<AtlasProvider>` — the RN peer of the web provider. It renders NO host
 * element (the web one wraps a `<div>` for appearance CSS variables; there is no
 * DOM here), it just creates the store once, boots it, and puts it on context.
 * All state and behaviour live in `AtlasStore`; the hooks read from it.
 */

const AtlasContext = createContext<AtlasStore | null>(null);

export interface AtlasProviderProps {
  publishableKey: string;
  /** The instance's FAPI origin. */
  frontendApi?: string;
  /**
   * Where the session token is kept. Defaults to a non-persistent in-memory
   * store — ship an `expo-secure-store` / AsyncStorage adapter in production
   * (see `TokenStorage`).
   */
  storage?: TokenStorage;
  /** Injectable for tests; defaults to the platform `fetch`. */
  fetchImpl?: typeof fetch;
  children: ReactNode;
}

export function AtlasProvider(props: AtlasProviderProps): JSX.Element {
  // Created exactly once — the initializer runs on first render only, so the
  // store (and its token cache) survives re-renders.
  const [store] = useState(() =>
    createAtlasStore({
      publishableKey: props.publishableKey,
      frontendApi: props.frontendApi,
      storage: props.storage,
      fetchImpl: props.fetchImpl,
    }),
  );

  useEffect(() => {
    void store.bootstrap();
  }, [store]);

  return <AtlasContext.Provider value={store}>{props.children}</AtlasContext.Provider>;
}

/** The store instance from context. Throws outside a provider, on purpose. */
export function useAtlasStore(): AtlasStore {
  const store = useContext(AtlasContext);
  if (!store) {
    // A null-ish default here would be indistinguishable from a signed-out user
    // and cost the developer an afternoon; a clear throw does not.
    throw new Error('Atlas hooks must be used inside <AtlasProvider>.');
  }
  return store;
}

/** Subscribe a component to the store's auth state. */
export function useAtlasState(): AtlasStoreState {
  const store = useAtlasStore();
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
