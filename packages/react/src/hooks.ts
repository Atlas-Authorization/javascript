import { useEffect, useState } from 'react';
import { checkSession, type CheckSessionOptions, type ProviderToken } from '@atlasauth/js';
import { useAtlas } from './AtlasProvider';
import { evaluate, type ProtectCondition } from './protect';
import type { AtlasOrganizationMembership, AtlasSession, AtlasUser } from './types';

/**
 * §10.1 hooks.
 *
 * Every one returns `isLoaded` alongside its data, and that is not ceremony.
 * Without it a component cannot tell "still booting" from "signed out", so it
 * renders a sign-in form for a fraction of a second on every page load — the
 * flash of unauthenticated content that makes an app feel broken.
 */

export function useUser(): {
  isLoaded: boolean;
  isSignedIn: boolean;
  user: AtlasUser | null;
  /**
   * §6.6 the signed-in user's own live token at a connected provider — the
   * `user.getToken({ provider })` equivalent. Always the caller's own token
   * (the server keys off the session), refreshed on read if stale, and never
   * the refresh token.
   */
  getProviderToken(provider: string): Promise<ProviderToken | null>;
} {
  const { status, user, getProviderToken } = useAtlas();
  return {
    isLoaded: status !== 'loading',
    isSignedIn: status === 'signed_in',
    user,
    getProviderToken,
  };
}

export function useSession(): { isLoaded: boolean; session: AtlasSession | null } {
  const { status, session } = useAtlas();
  return { isLoaded: status !== 'loading', session };
}

export function useAuth() {
  const { status, claims, getToken, getProviderToken, signOut } = useAtlas();
  return {
    isLoaded: status !== 'loading',
    isSignedIn: status === 'signed_in',
    userId: claims?.sub ?? null,
    sessionId: claims?.sid ?? null,
    orgId: claims?.org_id ?? null,
    orgRole: claims?.org_role ?? null,
    /** Always fresh: refreshes first if the cached token is close to expiry. */
    getToken,
    /** §6.6 the user's own live access token at a connected social provider. */
    getProviderToken,
    signOut,
    /** Mirrors <Protect>, for logic that is not a render decision. */
    has: (condition: ProtectCondition) => evaluate(claims, condition).allowed,
  };
}

export function useOrganization(): {
  isLoaded: boolean;
  organization: AtlasOrganizationMembership['organization'] | null;
  membership: AtlasOrganizationMembership | null;
  memberships: AtlasOrganizationMembership[];
  setActive(organizationId: string | null): Promise<void>;
} {
  const { status, claims, memberships, setActiveOrganization } = useAtlas();
  const active = memberships.find((m) => m.organization.id === claims?.org_id) ?? null;

  return {
    isLoaded: status !== 'loading',
    organization: active?.organization ?? null,
    membership: active,
    memberships,
    setActive: setActiveOrganization,
  };
}

/**
 * Cross-property silent auth (P3). Runs the hidden-iframe OIDC `prompt=none`
 * check ({@link checkSession}) once on mount and reports whether the visitor is
 * already signed in on this Atlas instance — for a pure client-side UI decision
 * ("show Sign in" vs "show account"), never as a security boundary. Pass `null`
 * to skip the check (e.g. until config is ready). `signedIn` is `null` while the
 * check is in flight or skipped, then a boolean.
 */
export function useSilentAuth(options: CheckSessionOptions | null): {
  loading: boolean;
  signedIn: boolean | null;
  error?: string;
} {
  const [state, setState] = useState<{ loading: boolean; signedIn: boolean | null; error?: string }>({
    loading: options !== null,
    signedIn: null,
  });
  // Re-run only when the meaningful inputs change, not on every render.
  const key = options
    ? [options.issuer, options.clientId, options.redirectUri, options.idTokenHint ?? ''].join('|')
    : null;
  useEffect(() => {
    if (!options) {
      setState({ loading: false, signedIn: null });
      return;
    }
    let active = true;
    setState((s) => ({ ...s, loading: true }));
    void checkSession(options).then((r) => {
      if (active) setState({ loading: false, signedIn: r.signedIn, error: r.error });
    });
    return () => {
      active = false;
    };
  }, [key]);
  return state;
}
