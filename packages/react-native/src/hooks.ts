import { useCallback, useEffect, useMemo, useReducer, useState } from 'react';
import {
  PolicyAcceptanceController,
  PolicyGateController,
  controllerForPending,
  hasFromClaims,
  loadPolicies,
  type EmailDelivery,
  type FapiClient,
  type MyPolicyStatus,
  type PolicyAcceptance,
  type PolicyAcceptancePayload,
  type ProtectCondition,
  type ProviderToken,
  type SignOutOptions,
  type SignOutResult,
} from '@atlasauth/js';
import { useAtlasState, useAtlasStore } from './AtlasProvider';
import type { AtlasSession, AtlasUser, AuthStatus, FlowResult } from './types';

/**
 * The RN hook surface. Mirrors `@atlasauth/react` — `useAuth`, `useUser`,
 * `useSession`, `useSignIn`, `useSignUp` — minus the DOM-bound pieces (`<Protect>`
 * components, appearance, i18n). Each hook is a thin binding over `AtlasStore`;
 * every one reports `isLoaded` so a component can tell "still booting" from
 * "signed out" and avoid a flash of the sign-in screen on launch.
 */

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
  /**
   * Gate on an authorization condition (permission / role / anyPermission /
   * allPermissions) — the same `@atlasauth/authz` primitive React's `<Protect>` and
   * the backend's `has()` use, so a native app checks access identically. This
   * is a rendering aid, never a security boundary: the server must re-check.
   */
  has(condition?: ProtectCondition): boolean;
  getToken(): Promise<string | null>;
  getProviderToken(provider: string): Promise<ProviderToken | null>;
  /**
   * Revoke the session and sign out locally. Resolves `{ revoked, activeSessionId? }`;
   * `{ strict: true }` rejects with a `SignOutError` (after the local sign-out)
   * when the server could not confirm the revoke.
   */
  signOut(options?: SignOutOptions): Promise<SignOutResult>;
} {
  const store = useAtlasStore();
  const { status, session, claims } = useAtlasState();
  return {
    isLoaded: status !== 'loading',
    isSignedIn: status === 'signed_in',
    status,
    session,
    userId: claims?.sub ?? null,
    sessionId: claims?.sid ?? null,
    orgId: claims?.org_id ?? null,
    orgRole: claims?.org_role ?? null,
    has: (condition = {}) => hasFromClaims(claims, condition),
    getToken: store.getToken,
    getProviderToken: store.getProviderToken,
    signOut: store.signOut,
  };
}

export function useUser(): {
  isLoaded: boolean;
  isSignedIn: boolean;
  user: AtlasUser | null;
  /** The signed-in user's own live token at a connected provider (§6.6). */
  getProviderToken(provider: string): Promise<ProviderToken | null>;
} {
  const store = useAtlasStore();
  const { status, user } = useAtlasState();
  return {
    isLoaded: status !== 'loading',
    isSignedIn: status === 'signed_in',
    user,
    getProviderToken: store.getProviderToken,
  };
}

export function useSession(): { isLoaded: boolean; session: AtlasSession | null } {
  const { status, session } = useAtlasState();
  return { isLoaded: status !== 'loading', session };
}

export function useSignIn(): {
  signInWithPassword(input: {
    identifier: string;
    password: string;
    captchaToken?: string;
  }): Promise<FlowResult>;
  attemptSecondFactor(input: {
    attemptId: string;
    status: string;
    code: string;
  }): Promise<FlowResult>;
  startOAuth(input: {
    provider: string;
    redirectUrl: string;
  }): Promise<{
    authorizationUrl: string | null;
    errors: Array<{ code: string; message: string; param?: string }>;
  }>;
  completeOAuthRedirect(callbackUrl: string): Promise<FlowResult>;
  /**
   * Continue an attempt the server holds at `needs_policy_acceptance` (a
   * `FlowResult` with that `attemptStatus`): send `controller.build()` with the
   * result's `policyToken`. See `usePendingPolicies()` for the UI.
   */
  acceptPolicies(input: {
    attemptId: string;
    acceptances: PolicyAcceptance[];
    policyToken?: string;
    pollSecret?: string;
  }): Promise<FlowResult>;
} {
  const store = useAtlasStore();
  return {
    signInWithPassword: store.signInWithPassword,
    attemptSecondFactor: store.attemptSecondFactor,
    startOAuth: store.startOAuth,
    completeOAuthRedirect: store.completeOAuthRedirect,
    acceptPolicies: store.acceptPolicies,
  };
}

export function useSignUp(): {
  signUpWithPassword(input: {
    emailAddress: string;
    password: string;
    firstName?: string;
    lastName?: string;
    fields?: Record<string, string>;
    consent?: boolean;
    captchaToken?: string;
    /** The policies the user accepted: `usePolicies().build()`. */
    policyAcceptances?: PolicyAcceptance[];
  }): Promise<FlowResult>;
  verifyEmailCode(input: { attemptId: string; code: string }): Promise<FlowResult>;
} {
  const store = useAtlasStore();
  return {
    signUpWithPassword: store.signUpWithPassword,
    verifyEmailCode: store.verifyEmailCode,
  };
}

/**
 * Whether the app can deliver email (`InstanceSettings.emailDelivery`), for an
 * app drawing its own sign-in / sign-up screens: hide "Forgot password?" when
 * `passwordReset` is false, show `EMAIL_UNAVAILABLE_MESSAGE` instead of the
 * email + password sign-up form when `passwordSignUp` is false, and pass
 * `emailDelivery` to `offeredFirstFactors()` to drop email code / link. Null
 * until loaded; everything reads as available if the settings can't be read.
 */
export function useEmailDelivery(): { isLoaded: boolean; emailDelivery: EmailDelivery | null } {
  const store = useAtlasStore();
  const [emailDelivery, setEmailDelivery] = useState<EmailDelivery | null>(null);
  useEffect(() => {
    let live = true;
    void store.getEmailDelivery().then((delivery) => {
      if (live) setEmailDelivery(delivery);
    });
    return () => {
      live = false;
    };
  }, [store]);
  return { isLoaded: emailDelivery !== null, emailDelivery };
}

/** Re-render when a policy controller changes (a tick, a document opened, a refresh). */
export function useControllerTick(controller: PolicyAcceptanceController | null): void {
  const [, force] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    if (!controller) return undefined;
    return controller.subscribe(() => force());
  }, [controller]);
}

/** What {@link usePolicies} returns. */
export interface UsePoliciesResult {
  /** The state machine behind the policy UI; pass it to `<PolicyConsent>`. */
  controller: PolicyAcceptanceController;
  loading: boolean;
  /** Re-fetch (after a 422 `POLICY_ACCEPTANCE_REQUIRED`, say). */
  refresh(): Promise<void>;
  /** Whether the submit button may be enabled (required boxes ticked; `scroll` policies are read on submit). */
  canSubmit: boolean;
  /** The `policy_acceptances` for the current ticks. */
  build(): PolicyAcceptancePayload[];
}

/** The pieces a policy hook needs from whichever provider is in use. */
export interface PolicyHookEnv {
  client: FapiClient;
  locale?: string;
}

/**
 * {@link usePolicies} over an explicit client. The hooks of this package pass
 * their provider's client; the Expo package passes its own.
 */
export function usePoliciesWith(env: PolicyHookEnv, options: { combined?: boolean; signIn?: boolean } = {}): UsePoliciesResult {
  const { client, locale } = env;
  const controller = useMemo(
    () => new PolicyAcceptanceController([], { combined: options.combined }),
    [options.combined],
  );
  const [loading, setLoading] = useState(true);
  const signIn = options.signIn;
  const refresh = useCallback(async () => {
    controller.setPolicies(await loadPolicies(client, { locale, signIn }));
    setLoading(false);
  }, [client, controller, locale, signIn]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useControllerTick(controller);
  return { controller, loading, refresh, canSubmit: controller.canSubmit(), build: () => controller.build() };
}

/** {@link usePendingPolicies} over an explicit client. */
export function usePendingPoliciesWith(
  env: PolicyHookEnv,
  held: { pendingPolicies?: unknown } | null | undefined,
  options: { combined?: boolean } = {},
): { controller: PolicyAcceptanceController | null; loading: boolean } {
  const { client, locale } = env;
  const [controller, setController] = useState<PolicyAcceptanceController | null>(null);
  const [loading, setLoading] = useState(false);
  const pending = held?.pendingPolicies;
  const active = held !== null && held !== undefined;
  useEffect(() => {
    if (!active) {
      setController(null);
      return undefined;
    }
    let live = true;
    setLoading(true);
    void controllerForPending(client, { pending_policies: pending }, { combined: options.combined, locale }).then((c) => {
      if (!live) return;
      setController(c);
      setLoading(false);
    });
    return () => {
      live = false;
    };
  }, [client, locale, active, pending, options.combined]);
  useControllerTick(controller);
  return { controller, loading };
}

/** What {@link usePolicyGate} returns. */
export interface UsePolicyGateResult {
  loaded: boolean;
  /** The policies that need accepting (empty when none). */
  pending: MyPolicyStatus[];
  /** The soonest end of a grace window (ISO time), or null. */
  graceEndsAt: string | null;
  /** A controller over the pending policies' current versions, all required. */
  begin(): Promise<PolicyAcceptanceController>;
  /** Send the acceptance (`POST /v1/client/me/policies/accept`). */
  accept(controller: PolicyAcceptanceController): Promise<{ ok: boolean; errors: Array<{ code: string; message: string }> }>;
  reload(): Promise<void>;
}

/** {@link usePolicyGate} over an explicit client; `enabled` is "the user is signed in". */
export function usePolicyGateWith(env: PolicyHookEnv, enabled: boolean): UsePolicyGateResult {
  const { client, locale } = env;
  const gate = useMemo(() => new PolicyGateController(client, locale), [client, locale]);
  const [, force] = useReducer((n: number) => n + 1, 0);
  useEffect(() => gate.subscribe(() => force()), [gate]);
  useEffect(() => {
    if (enabled) void gate.load();
  }, [gate, enabled]);
  return {
    loaded: gate.loaded,
    pending: gate.pending,
    graceEndsAt: gate.graceEndsAt,
    begin: () => gate.begin(),
    accept: (controller) => gate.accept(controller),
    reload: () => gate.load(),
  };
}

function useEnv(): PolicyHookEnv {
  const store = useAtlasStore();
  return { client: store.fapi, locale: store.language };
}

/**
 * Load the instance's policies into a controller (`GET /v1/client/policies`) for
 * a sign-up form. `signIn` keeps only the policies that also apply at sign-in.
 * Draw them with `<PolicyConsent>` / `<PolicyClickwrap>`, enable the submit with
 * `canSubmit`, read any `scroll` policies with `<PolicyScrollHost>`, and send
 * `build()` as `policyAcceptances`.
 */
export function usePolicies(options: { combined?: boolean; signIn?: boolean } = {}): UsePoliciesResult {
  return usePoliciesWith(useEnv(), options);
}

/**
 * The controller for a held attempt: pass the `FlowResult` whose `attemptStatus`
 * is `needs_policy_acceptance` (or null). Fills in the content the attempt only
 * listed; a redirect resume (no list) shows every required policy.
 */
export function usePendingPolicies(
  held: { pendingPolicies?: unknown } | null | undefined,
  options: { combined?: boolean } = {},
): { controller: PolicyAcceptanceController | null; loading: boolean } {
  return usePendingPoliciesWith(useEnv(), held, options);
}

/**
 * In-app re-acceptance for the signed-in user: which policies need accepting
 * (`pending`, with the end of any grace window), a controller to show them
 * (`begin()`), and `accept(controller)` to send the result. `<PolicyGate>` is the
 * ready-made banner over this.
 */
export function usePolicyGate(): UsePolicyGateResult {
  const { status } = useAtlasState();
  return usePolicyGateWith(useEnv(), status === 'signed_in');
}
