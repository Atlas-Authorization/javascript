'use client';

import { useCallback, useMemo, type ReactNode } from 'react';
import { ConvexProviderWithAuth, type ConvexReactClient } from 'convex/react';
import { useAuth } from '@atlasauth/react';
import { DEFAULT_CONVEX_TEMPLATE } from './index';

/**
 * `@atlasauth/convex/react` — authenticate Convex with the Atlas session.
 *
 * ```tsx
 * <AtlasProvider publishableKey={…}>
 *   <ConvexProviderWithAtlas client={convex}>
 *     <App />
 *   </ConvexProviderWithAtlas>
 * </AtlasProvider>
 * ```
 *
 * Convex asks for a token whenever it (re)connects; the provider answers with a
 * fresh token minted from the `convex` JWT template of the signed-in session.
 */

/** The shape Convex's `ConvexProviderWithAuth` expects from its `useAuth` prop. */
export interface ConvexAuthState {
  isLoading: boolean;
  isAuthenticated: boolean;
  fetchAccessToken(args: { forceRefreshToken: boolean }): Promise<string | null>;
}

/** The part of Atlas's `useAuth()` the bridge reads. */
export interface AtlasAuthLike {
  isLoaded: boolean;
  isSignedIn: boolean;
  getToken(options?: { template?: string }): Promise<string | null>;
}

/**
 * The pure projection: Atlas auth state → Convex auth state. A token fetch that
 * fails resolves `null` (Convex then treats the client as signed out) instead of
 * throwing into Convex's reconnect loop.
 */
export function convexAuthFromAtlas(auth: AtlasAuthLike, template: string = DEFAULT_CONVEX_TEMPLATE): ConvexAuthState {
  return {
    isLoading: !auth.isLoaded,
    isAuthenticated: auth.isLoaded && auth.isSignedIn,
    fetchAccessToken: async () => {
      if (!auth.isSignedIn) return null;
      try {
        return await auth.getToken({ template });
      } catch {
        return null;
      }
    },
  };
}

/**
 * Convex's `useAuth` contract backed by Atlas. `template` is the JWT template
 * to mint (default `convex`). Memoised so Convex only re-authenticates when the
 * sign-in state actually changes.
 */
export function useAtlasConvexAuth(template: string = DEFAULT_CONVEX_TEMPLATE): ConvexAuthState {
  const { isLoaded, isSignedIn, getToken } = useAuth();
  const fetchAccessToken = useCallback(
    (args: { forceRefreshToken: boolean }) =>
      convexAuthFromAtlas({ isLoaded, isSignedIn, getToken }, template).fetchAccessToken(args),
    // getToken is stable per provider; isSignedIn flips on sign-in / sign-out.
    [isLoaded, isSignedIn, getToken, template],
  );
  return useMemo(
    () => ({ isLoading: !isLoaded, isAuthenticated: isLoaded && isSignedIn, fetchAccessToken }),
    [isLoaded, isSignedIn, fetchAccessToken],
  );
}

/**
 * Drop-in for Convex's `ConvexProvider` when the app signs in with Atlas. Must
 * sit inside `<AtlasProvider>`.
 */
export function ConvexProviderWithAtlas({
  client,
  children,
  template = DEFAULT_CONVEX_TEMPLATE,
}: {
  client: ConvexReactClient;
  children: ReactNode;
  /** The JWT template Convex tokens are minted from. Default `convex`. */
  template?: string;
}) {
  const useAuthFromAtlas = useMemo(
    () =>
      function useAuthFromAtlas() {
        return useAtlasConvexAuth(template);
      },
    [template],
  );
  return (
    <ConvexProviderWithAuth client={client} useAuth={useAuthFromAtlas}>
      {children}
    </ConvexProviderWithAuth>
  );
}
