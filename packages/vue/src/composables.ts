import { computed, type ComputedRef, type ShallowRef } from 'vue';
import type { ProviderToken } from '@atlasauth/js';
import { useAtlas } from './context';
import { evaluate, type ProtectCondition } from './protect';
import type { AtlasOrganizationMembership, AtlasSession, AtlasUser } from './types';

/**
 * §10.1 composables — the Vue peer of React's hooks.
 *
 * Every one returns `isLoaded` alongside its data, and that is not ceremony.
 * Without it a component cannot tell "still booting" from "signed out", so it
 * renders a sign-in form for a fraction of a second on every page load — the
 * flash of unauthenticated content that makes an app feel broken. The React SDK
 * returns plain values recomputed each render; the Vue SDK returns `computed`
 * refs off the reactive client, which stay live without a re-render.
 */

export function useUser(): {
  isLoaded: ComputedRef<boolean>;
  isSignedIn: ComputedRef<boolean>;
  user: ShallowRef<AtlasUser | null>;
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
    isLoaded: computed(() => status.value !== 'loading'),
    isSignedIn: computed(() => status.value === 'signed_in'),
    user,
    getProviderToken,
  };
}

export function useSession(): {
  isLoaded: ComputedRef<boolean>;
  session: ShallowRef<AtlasSession | null>;
} {
  const { status, session } = useAtlas();
  return {
    isLoaded: computed(() => status.value !== 'loading'),
    session,
  };
}

export function useAuth(): {
  isLoaded: ComputedRef<boolean>;
  isSignedIn: ComputedRef<boolean>;
  userId: ComputedRef<string | null>;
  sessionId: ComputedRef<string | null>;
  orgId: ComputedRef<string | null>;
  orgRole: ComputedRef<string | null>;
  getToken(): Promise<string | null>;
  getProviderToken(provider: string): Promise<ProviderToken | null>;
  signOut(): Promise<void>;
  has(condition: ProtectCondition): boolean;
} {
  const { status, claims, getToken, getProviderToken, signOut } = useAtlas();
  return {
    isLoaded: computed(() => status.value !== 'loading'),
    isSignedIn: computed(() => status.value === 'signed_in'),
    userId: computed(() => claims.value?.sub ?? null),
    sessionId: computed(() => claims.value?.sid ?? null),
    orgId: computed(() => (claims.value?.org_id as string | undefined) ?? null),
    orgRole: computed(() => (claims.value?.org_role as string | undefined) ?? null),
    /** Always fresh: refreshes first if the cached token is close to expiry. */
    getToken,
    /** §6.6 the user's own live access token at a connected social provider. */
    getProviderToken,
    signOut,
    /** Mirrors <Protect>, for logic that is not a render decision. */
    has: (condition: ProtectCondition) => evaluate(claims.value, condition).allowed,
  };
}

export function useOrganization(): {
  isLoaded: ComputedRef<boolean>;
  organization: ComputedRef<AtlasOrganizationMembership['organization'] | null>;
  membership: ComputedRef<AtlasOrganizationMembership | null>;
  memberships: ShallowRef<AtlasOrganizationMembership[]>;
  setActive(organizationId: string | null): Promise<void>;
} {
  const { status, claims, memberships, setActiveOrganization } = useAtlas();
  const active = computed(
    () => memberships.value.find((m) => m.organization.id === claims.value?.org_id) ?? null,
  );

  return {
    isLoaded: computed(() => status.value !== 'loading'),
    organization: computed(() => active.value?.organization ?? null),
    membership: active,
    memberships,
    setActive: setActiveOrganization,
  };
}
