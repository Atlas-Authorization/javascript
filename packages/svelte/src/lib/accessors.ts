import { derived, get, writable, type Readable } from 'svelte/store';
import {
  FapiClient,
  advance,
  flowFromPending,
  pollAttempt,
  shouldKeepPolling,
  type FlowState,
  type ProviderToken,
} from '@atlasauth/js';
import { useAtlas } from './context';
import { evaluate, type ProtectCondition } from './protect';
import type { AtlasOrganizationMembership, AtlasSession, AtlasUser } from './types';

/**
 * §10.1 accessors — the Svelte peer of React's hooks (`useUser`, `useSession`,
 * `useAuth`, `useOrganization`).
 *
 * React returns a plain snapshot that re-runs on every render. Svelte has no
 * render loop, so each accessor returns a **derived store** instead: `$user`
 * in a template updates exactly when the underlying state changes, and
 * `get(user)` reads it once in plain code.
 *
 * Every one carries `isLoaded`, and that is not ceremony. Without it a component
 * cannot tell "still booting" from "signed out", so it flashes a sign-in form
 * for a fraction of a second on every page load.
 */

export interface UseUser {
  isLoaded: boolean;
  isSignedIn: boolean;
  user: AtlasUser | null;
  /**
   * §6.6 the signed-in user's own live token at a connected provider — the
   * `user.getToken({ provider })` equivalent. Always the caller's own token,
   * refreshed on read if stale, never the refresh token.
   */
  getProviderToken(provider: string): Promise<ProviderToken | null>;
}

export function getUser(): Readable<UseUser> {
  const atlas = useAtlas();
  return derived([atlas.status, atlas.user], ([$status, $user]) => ({
    isLoaded: $status !== 'loading',
    isSignedIn: $status === 'signed_in',
    user: $user,
    getProviderToken: atlas.getProviderToken,
  }));
}

export interface UseSession {
  isLoaded: boolean;
  session: AtlasSession | null;
}

export function getSession(): Readable<UseSession> {
  const atlas = useAtlas();
  return derived([atlas.status, atlas.session], ([$status, $session]) => ({
    isLoaded: $status !== 'loading',
    session: $session,
  }));
}

export interface UseAuth {
  isLoaded: boolean;
  isSignedIn: boolean;
  userId: string | null;
  sessionId: string | null;
  orgId: string | null;
  orgRole: string | null;
  /** Always fresh: refreshes first if the cached token is close to expiry. */
  getToken(): Promise<string | null>;
  /** §6.6 the user's own live access token at a connected social provider. */
  getProviderToken(provider: string): Promise<ProviderToken | null>;
  signOut(): Promise<void>;
  /** Mirrors `<Protect>`, for logic that is not a render decision. */
  has(condition: ProtectCondition): boolean;
}

export function getAuth(): Readable<UseAuth> {
  const atlas = useAtlas();
  return derived([atlas.status, atlas.claims], ([$status, $claims]) => ({
    isLoaded: $status !== 'loading',
    isSignedIn: $status === 'signed_in',
    userId: ($claims?.sub as string | undefined) ?? null,
    sessionId: ($claims?.sid as string | undefined) ?? null,
    orgId: ($claims?.org_id as string | undefined) ?? null,
    orgRole: ($claims?.org_role as string | undefined) ?? null,
    getToken: atlas.getToken,
    getProviderToken: atlas.getProviderToken,
    signOut: atlas.signOut,
    has: (condition: ProtectCondition) => evaluate($claims, condition).allowed,
  }));
}

export interface UseOrganization {
  isLoaded: boolean;
  organization: AtlasOrganizationMembership['organization'] | null;
  membership: AtlasOrganizationMembership | null;
  memberships: AtlasOrganizationMembership[];
  setActive(organizationId: string | null): Promise<void>;
}

export function getOrganization(): Readable<UseOrganization> {
  const atlas = useAtlas();
  return derived([atlas.status, atlas.claims, atlas.memberships], ([$status, $claims, $memberships]) => {
    const active =
      $memberships.find((m) => m.organization.id === $claims?.org_id) ?? null;
    return {
      isLoaded: $status !== 'loading',
      organization: active?.organization ?? null,
      membership: active,
      memberships: $memberships,
      setActive: atlas.setActiveOrganization,
    };
  });
}

/* ------------------------------------------------------------------ actions */

/** Refresh-if-stale, then hand over the JWT. The `useAuth().getToken` shortcut. */
export function getToken(): Promise<string | null> {
  return useAtlas().getToken();
}

/** Revoke the session and drop all in-memory state. */
export function signOut(): Promise<void> {
  return useAtlas().signOut();
}

/**
 * A running sign-in / sign-up attempt: a reactive `state` store plus `submit`.
 *
 * This is the imperative peer of React's `useFlow`. The whole flow is
 * server-driven — `advance` (from `@atlasauth/js`) owns the step-to-endpoint
 * mapping, so this controller never decides what comes next. It posts whatever
 * the current step needs, renders the status the server returned, and on
 * completion exchanges the one-time ticket for cookies then re-boots.
 */
export interface FlowController {
  state: Readable<FlowState>;
  submit(values: Record<string, string>): void;
  /** Stop the magic-link poll loop — call from `onDestroy`. */
  destroy(): void;
}

function createFlow(): FlowController {
  const atlas = useAtlas();
  const client = new FapiClient({
    publishableKey: atlas.publishableKey,
    baseUrl: atlas.frontendApi,
  });

  // Seeded from a redirect that came back mid-flow (e.g. OAuth needing a second
  // factor), so the user resumes at the demanded step instead of starting over.
  const state = writable<FlowState>(flowFromPending(atlas.pendingAttempt));
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  function stopPolling(): void {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  }

  /** §5.3: collect a sign-in completed by a link opened on another device. */
  function maybeStartPolling(): void {
    if (pollTimer || !shouldKeepPolling(get(state))) return;
    pollTimer = setInterval(() => {
      void (async () => {
        const { state: next, ticket } = await pollAttempt(client, get(state));
        state.set(next);
        if (!shouldKeepPolling(next)) stopPolling();
        if (!ticket || !next.attempt) return;

        // The ticket is exchanged by a normal request, so no session token has
        // ever appeared in a URL.
        await client.post('/v1/client/tickets/exchange', {
          attempt_id: (next.attempt as { id?: string }).id,
          ticket,
        });
        await atlas.reload();
      })();
    }, 2_000);
  }

  function submit(values: Record<string, string>): void {
    void (async () => {
      state.update((current) => ({ ...current, busy: true, errors: [] }));
      const next = await advance(client, get(state), values);
      state.set(next);

      // On completion the response carries a one-time ticket (§7.1). Exchange it
      // for cookies over a same-origin request — FAPI is cross-origin to the app
      // and cannot set the cookie on the completion response itself — THEN
      // re-boot so the rest of the app sees a signed-in user.
      if (next.attempt?.status === 'complete') {
        if (next.ticket) {
          await client.post('/v1/client/tickets/exchange', {
            attempt_id: (next.attempt as { id?: string }).id,
            ticket: next.ticket,
          });
        }
        await atlas.reload();
        return;
      }

      maybeStartPolling();
    })();
  }

  return { state: { subscribe: state.subscribe }, submit, destroy: stopPolling };
}

/** Start (or resume) a sign-in flow. Drives `<SignIn>`; usable standalone too. */
export function signIn(): FlowController {
  return createFlow();
}

/** Start a sign-up flow. Drives `<SignUp>`; usable standalone too. */
export function signUp(): FlowController {
  return createFlow();
}
