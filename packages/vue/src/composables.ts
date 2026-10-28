import { computed, onMounted, onScopeDispose, shallowRef, watch, type ComputedRef, type ShallowRef } from 'vue';
import {
  actorFromClaims,
  listPublicPlans,
  startPlanCheckout,
  type PublicBillingPlan,
  createOrganizationAuditLog,
  FapiClient,
  type EndImpersonationResult,
  type ImpersonationActor,
  type OrganizationAuditLogOptions,
  type OrganizationAuditLogState,
  type ProviderToken,
  type SignOutOptions,
  type SignOutResult,
} from '@atlasauth/js';
import { useAtlas } from './context';
import { ATLAS_VUE_SDK } from './version';
import type { AuthStatus } from './plugin';
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
  /** Three-state auth status (`loading` | `signed_in` | `signed_out`); same source as isLoaded/isSignedIn. */
  status: ShallowRef<AuthStatus>;
  /** The active session, or null while loading or signed out. */
  session: ShallowRef<AtlasSession | null>;
  userId: ComputedRef<string | null>;
  sessionId: ComputedRef<string | null>;
  orgId: ComputedRef<string | null>;
  orgRole: ComputedRef<string | null>;
  getToken(): Promise<string | null>;
  getProviderToken(provider: string): Promise<ProviderToken | null>;
  /** Resolves `{ revoked, activeSessionId? }`; `{ strict: true }` rejects with `SignOutError` (see `AtlasClient.signOut`). */
  signOut(options?: SignOutOptions): Promise<SignOutResult>;
  has(condition: ProtectCondition): boolean;
} {
  const { status, session, claims, getToken, getProviderToken, signOut } = useAtlas();
  return {
    isLoaded: computed(() => status.value !== 'loading'),
    isSignedIn: computed(() => status.value === 'signed_in'),
    status,
    session,
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

/**
 * The active organization's audit trail, for its admins: one page at a time,
 * newest first, with `loadMore()`. `action` narrows it (exact, or a prefix
 * ending in `.`). `state.forbidden` is true when the signed-in member may not
 * read it, so the caller can hide the surface. Follows the active organization.
 */
export function useOrganizationAuditLog(options: OrganizationAuditLogOptions = {}): {
  state: ShallowRef<OrganizationAuditLogState>;
  loadMore(): Promise<void>;
  reload(): Promise<void>;
} {
  const atlas = useAtlas();
  const { organization } = useOrganization();
  const log = createOrganizationAuditLog(
    new FapiClient({
      publishableKey: atlas.publishableKey,
      baseUrl: atlas.frontendApi,
      locale: atlas.locale,
      sdk: ATLAS_VUE_SDK,
    }),
    options,
  );
  const state = shallowRef(log.getState());
  const unsubscribe = log.subscribe((next) => {
    state.value = next;
  });
  watch(
    () => organization.value?.id ?? null,
    (id) => void log.load(id),
    { immediate: true },
  );
  onScopeDispose(unsubscribe);
  return { state, loadMore: log.loadMore, reload: log.reload };
}

/**
 * The instance's public plans and a Checkout starter — the data behind
 * `<PricingTable/>`. `checkout` needs a signed-in session and navigates to the
 * provider's hosted Checkout page.
 */
export function usePricingPlans(options: { audience?: 'user' | 'org' } = {}): {
  isLoaded: ShallowRef<boolean>;
  plans: ShallowRef<PublicBillingPlan[]>;
  checkout(input: { planId: string; interval?: 'month' | 'year'; orgId?: string; successUrl?: string }): Promise<string | null>;
} {
  const atlas = useAtlas();
  const client = new FapiClient({ publishableKey: atlas.publishableKey, baseUrl: atlas.frontendApi, locale: atlas.locale, sdk: ATLAS_VUE_SDK });
  const plans = shallowRef<PublicBillingPlan[]>([]);
  const isLoaded = shallowRef(false);
  onMounted(async () => {
    plans.value = await listPublicPlans(client, options);
    isLoaded.value = true;
  });
  return {
    isLoaded,
    plans,
    async checkout(input) {
      const here = typeof window === 'undefined' ? '/' : window.location.href;
      const out = await startPlanCheckout(client, { ...input, successUrl: input.successUrl ?? here });
      if (out.url && typeof window !== 'undefined') window.location.assign(out.url);
      return out.url;
    },
  };
}

/**
 * The impersonation state of the active session, and "return to admin" — the
 * Vue peer of React's `useImpersonation()`.
 */
export function useImpersonation(): {
  isImpersonating: ComputedRef<boolean>;
  actor: ComputedRef<ImpersonationActor | null>;
  canReturnToAdmin: ComputedRef<boolean>;
  endImpersonation(): Promise<EndImpersonationResult>;
} {
  const { claims, session, endImpersonation } = useAtlas();
  const actor = computed(() => actorFromClaims(claims.value) ?? session.value?.actor ?? null);
  return {
    isImpersonating: computed(() => actor.value !== null),
    actor,
    canReturnToAdmin: computed(() => actor.value !== null && Boolean(session.value?.actor_session_id)),
    endImpersonation,
  };
}
