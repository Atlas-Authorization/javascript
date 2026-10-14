import type { ProtectCondition, ProviderToken, SignOutOptions } from '@atlasauth/js';
import { evaluate } from '@atlasauth/js';
import { useAtlas } from './context';
import {
  isLoaded,
  isSignedIn,
  orgId,
  orgRole,
  sessionId,
  userId,
  type AtlasStore,
} from './store';
import type {
  AtlasOrganizationMembership,
  AtlasSession,
  AtlasUser,
  AuthStatus,
  SessionClaims,
} from './types';

/**
 * The Qwik hooks — the peer of React's hooks / Vue's composables.
 *
 * Each returns `isLoaded` alongside its data, and that is not ceremony: without
 * it a component cannot tell "still booting" from "signed out", so it flashes a
 * sign-in form for a fraction of a second on every page load — the flash of
 * unauthenticated content that makes an app feel broken.
 *
 * The values are read off the reactive store, so a component that reads them
 * re-renders when the provider republishes a new snapshot. The action functions
 * delegate to the live client; before the client exists (on the server, or
 * before `<AtlasProvider>`'s visible task runs) they resolve to a safe default
 * rather than throwing, so SSR and the first paint are inert, not broken.
 */

export interface UseAtlasAll {
  store: AtlasStore;
  isLoaded: boolean;
  isSignedIn: boolean;
}

export function useUser(): {
  isLoaded: boolean;
  isSignedIn: boolean;
  user: AtlasUser | null;
  /** §6.6 the signed-in user's own live token at a connected provider. */
  getProviderToken: (provider: string) => Promise<ProviderToken | null>;
} {
  const store = useAtlas();
  return {
    isLoaded: isLoaded(store),
    isSignedIn: isSignedIn(store),
    user: store.user,
    getProviderToken: (provider: string) =>
      store.client?.getProviderToken(provider) ?? Promise.resolve(null),
  };
}

export function useSession(): {
  isLoaded: boolean;
  session: AtlasSession | null;
} {
  const store = useAtlas();
  return {
    isLoaded: isLoaded(store),
    session: store.session,
  };
}

export function useAuth(): {
  isLoaded: boolean;
  isSignedIn: boolean;
  /** Three-state auth status (`loading` | `signed_in` | `signed_out`); same source as isLoaded/isSignedIn. */
  status: AuthStatus;
  /** The active session, or null while loading or signed out. */
  session: AtlasSession | null;
  userId: string | null;
  sessionId: string | null;
  orgId: string | null;
  orgRole: string | null;
  getToken: () => Promise<string | null>;
  getProviderToken: (provider: string) => Promise<ProviderToken | null>;
  signOut: (options?: SignOutOptions) => Promise<void>;
  /** Mirrors <Protect>, for logic that is not a render decision. */
  has: (condition: ProtectCondition) => boolean;
} {
  const store = useAtlas();
  return {
    isLoaded: isLoaded(store),
    isSignedIn: isSignedIn(store),
    status: store.status,
    session: store.session,
    userId: userId(store),
    sessionId: sessionId(store),
    orgId: orgId(store),
    orgRole: orgRole(store),
    getToken: () => store.client?.getToken() ?? Promise.resolve(null),
    getProviderToken: (provider: string) =>
      store.client?.getProviderToken(provider) ?? Promise.resolve(null),
    signOut: (options?: SignOutOptions) => store.client?.signOut(options) ?? Promise.resolve(),
    // Evaluate against the store's claims directly so `has()` works even before
    // the client is attached (it is a pure read of the current claims).
    has: (condition: ProtectCondition) => evaluate(store.claims, condition).allowed,
  };
}

export function useOrganization(): {
  isLoaded: boolean;
  organization: AtlasOrganizationMembership['organization'] | null;
  membership: AtlasOrganizationMembership | null;
  memberships: AtlasOrganizationMembership[];
  setActive: (organizationId: string | null) => Promise<void>;
} {
  const store = useAtlas();
  const active =
    store.memberships.find(
      (m) => m.organization.id === (store.claims?.org_id as string | undefined),
    ) ?? null;

  return {
    isLoaded: isLoaded(store),
    organization: active?.organization ?? null,
    membership: active,
    memberships: store.memberships,
    setActive: (organizationId: string | null) =>
      store.client?.setActiveOrganization(organizationId) ?? Promise.resolve(),
  };
}

/** Re-export so a consumer can name the claim shape if they want it. */
export type { SessionClaims };
