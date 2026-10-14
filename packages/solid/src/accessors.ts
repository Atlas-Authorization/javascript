import { evaluate, type ProtectCondition, type ProviderToken, type SignOutOptions } from '@atlasauth/js';
import { useAtlas } from './context';
import type { AuthStatus } from './provider';
import type { AtlasSession, AtlasUser } from './types';

/**
 * The Solid peer of React's hooks and Vue's composables.
 *
 * Every one returns `isLoaded` alongside its data, and that is not ceremony:
 * without it a component cannot tell "still booting" from "signed out", so it
 * flashes a sign-in form for a frame on every load — the flash of
 * unauthenticated content that makes an app feel broken. Each returned value is
 * an ACCESSOR (a `() => T` function), the idiomatic Solid shape: call it inside
 * JSX or an effect and that spot re-runs when just that field changes.
 */

export function useUser(): {
  isLoaded: () => boolean;
  isSignedIn: () => boolean;
  user: () => AtlasUser | null;
  /**
   * The signed-in user's own live token at a connected provider — always the
   * caller's (the server keys off the session), refreshed on read if stale, and
   * never the refresh token.
   */
  getProviderToken: (provider: string) => Promise<ProviderToken | null>;
} {
  const client = useAtlas();
  return {
    isLoaded: () => client.state.status !== 'loading',
    isSignedIn: () => client.state.status === 'signed_in',
    user: () => client.state.user,
    getProviderToken: client.getProviderToken,
  };
}

export function useSession(): {
  isLoaded: () => boolean;
  session: () => AtlasSession | null;
} {
  const client = useAtlas();
  return {
    isLoaded: () => client.state.status !== 'loading',
    session: () => client.state.session,
  };
}

export function useAuth(): {
  isLoaded: () => boolean;
  isSignedIn: () => boolean;
  /** Three-state auth status (`loading` | `signed_in` | `signed_out`); same source as isLoaded/isSignedIn. */
  status: () => AuthStatus;
  /** The active session, or null while loading or signed out. */
  session: () => AtlasSession | null;
  userId: () => string | null;
  sessionId: () => string | null;
  orgId: () => string | null;
  orgRole: () => string | null;
  getToken: () => Promise<string | null>;
  getProviderToken: (provider: string) => Promise<ProviderToken | null>;
  signOut: (options?: SignOutOptions) => Promise<void>;
  /** Mirrors `<Protect>`, for logic that is not a render decision. */
  has: (condition: ProtectCondition) => boolean;
} {
  const client = useAtlas();
  return {
    isLoaded: () => client.state.status !== 'loading',
    isSignedIn: () => client.state.status === 'signed_in',
    status: () => client.state.status,
    session: () => client.state.session,
    userId: () => client.state.claims?.sub ?? null,
    sessionId: () => client.state.claims?.sid ?? null,
    orgId: () => (client.state.claims?.org_id as string | undefined) ?? null,
    orgRole: () => (client.state.claims?.org_role as string | undefined) ?? null,
    getToken: client.getToken,
    getProviderToken: client.getProviderToken,
    signOut: client.signOut,
    has: (condition) => evaluate(client.state.claims, condition).allowed,
  };
}
