import { useState, createElement, type ReactElement } from 'react';
import {
  AtlasProvider as ReactAtlasProvider,
  type AtlasProviderProps as ReactAtlasProviderProps,
} from '@atlasauth/react';
import { createCacheFetch } from './cache-fetch';
import {
  createInMemoryTokenCache,
  DEFAULT_SESSION_KEY,
  type TokenCache,
} from './token-cache';

/**
 * `<AtlasProvider>` — the Expo peer of the web provider.
 *
 * It does NOT re-implement the auth state machine: it wraps `@atlasauth/react`'s
 * provider (so every hook and control component in this package is the exact web
 * one) and swaps one thing — the transport. The web provider carries the session
 * in an HttpOnly cookie; Expo has no cookie jar, so this provider injects a
 * {@link createCacheFetch} that bearer-authenticates from, and persists rotated
 * tokens into, an `expo-secure-store`-backed {@link TokenCache}.
 *
 * Expo Router friendly: mount it once at the app root (e.g. in `app/_layout.tsx`)
 * and read auth anywhere with `useAuth()` / `useUser()` / `<SignedIn>` — the
 * token cache, not a cookie, is what carries the session across a cold start.
 */

/**
 * Props mirror `@atlasauth/react`'s provider (publishableKey, frontendApi,
 * appearance, localization, oauthMode, onSignedIn) and add the two Expo knobs.
 * `fetchImpl` is replaced by the cache-backed fetch, so it is not forwardable.
 */
export interface AtlasProviderProps extends Omit<ReactAtlasProviderProps, 'fetchImpl'> {
  /**
   * Where the session token is kept. Defaults to a NON-persistent in-memory
   * cache — pass `createSecureStoreTokenCache(SecureStore)` in production so the
   * session survives an app restart.
   */
  tokenCache?: TokenCache;
  /** The cache key the session token is stored under. */
  tokenKey?: string;
  /** Injectable for tests; defaults to the platform `fetch`. */
  fetchImpl?: typeof fetch;
}

export function AtlasProvider(props: AtlasProviderProps): ReactElement {
  const { tokenCache, tokenKey = DEFAULT_SESSION_KEY, fetchImpl, ...rest } = props;

  // Built exactly once — the initializer runs on first render only, so the cache
  // (and the default in-memory one, when no adapter is passed) survives
  // re-renders rather than being re-created and losing the session every render.
  const [cacheFetch] = useState(() =>
    createCacheFetch({
      cache: tokenCache ?? createInMemoryTokenCache(),
      key: tokenKey,
      fetchImpl: fetchImpl ?? fetch,
    }),
  );

  return createElement(ReactAtlasProvider, { ...rest, fetchImpl: cacheFetch });
}
