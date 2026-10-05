import { createElement, useMemo } from 'react';
import { AtlasProvider as ReactAtlasProvider, type AtlasProviderProps } from '@atlasauth/react';
import { persistingBearerFetch } from './client';
import { StorageCache, type TokenStore } from './storage';

/**
 * `<AtlasProvider>` for a Chrome/MV3 extension.
 *
 * A thin wrapper over `@atlasauth/react`'s provider. It reuses the entire React
 * SDK — the same hooks (`useAuth`, `useUser`, …), the same components — and
 * changes exactly ONE thing: how the session travels. The web provider assumes
 * cookies (`credentials: 'include'`); an extension has none, so this wrapper
 * injects a `fetchImpl` that instead
 *   1. attaches the token from the extension's {@link TokenStore} as a bearer, and
 *   2. captures any freshly-minted token out of a `/v1/client` response back
 *      into `chrome.storage`, so it survives the popup closing and the service
 *      worker being torn down.
 *
 * React and `@atlasauth/react` are OPTIONAL peer dependencies — this module is
 * only reached through the `@atlasauth/chrome-extension/react` entry point. A
 * background service worker imports the React-free core (`createAtlasClient`,
 * `syncSessionToken`, `StorageCache`) from the package root instead and never
 * pulls React in.
 *
 * The token must already be in the store (seed it with `client.setToken(jwt)`
 * after a hosted sign-in, or let a prior session persist it). This provider does
 * not itself drive the sign-in UI flow.
 */
export interface ChromeAtlasProviderProps extends Omit<AtlasProviderProps, 'fetchImpl'> {
  /** Where the token lives. Defaults to `chrome.storage.local` via {@link StorageCache}. */
  store?: TokenStore;
  /** Base `fetch` to wrap (before bearer/persist). Defaults to the platform `fetch`. */
  fetchImpl?: typeof fetch;
}

export function AtlasProvider(props: ChromeAtlasProviderProps) {
  const { store, fetchImpl, ...rest } = props;

  const wrappedFetch = useMemo(
    () => persistingBearerFetch(fetchImpl ?? fetch, store ?? new StorageCache()),
    [store, fetchImpl],
  );

  return createElement(ReactAtlasProvider, { ...rest, fetchImpl: wrappedFetch });
}

// Re-export the React SDK surface so extension code has one import site for the
// provider AND the hooks/components it renders inside it.
export * from '@atlasauth/react';
