import { derived, get, readable, writable, type Readable } from 'svelte/store';
import {
  FapiClient,
  advanceWithCaptcha,
  atlasCaptchaLabels,
  createCaptchaController,
  createPasskeySignInController,
  createPasskeySignUp,
  createSignUp,
  finishPasskeySignUp,
  fetchInstanceSettings,
  fetchLastSignInMethod,
  startSignInWithAtlas,
  flowNeedsCaptcha,
  signInCaptchaOptions,
  flowFromPending,
  pollAttempt,
  prepareFactor,
  shouldKeepPolling,
  createOrganizationAuditLog,
  type OrganizationAuditLogOptions,
  type OrganizationAuditLogState,
  type CaptchaController,
  type FlowState,
  type InstanceSettings,
  type ProviderToken,
  type SignOutOptions,
  type SignOutResult,
  createMfaEnrollment,
  acknowledgeRecoveryCodes,
  pendingRecoveryCodes,
  mfaChoicesFrom,
  prepareSecondFactorCode,
  resendSignUpVerification,
  PolicyAcceptanceController,
  loadPolicies as loadPolicyList,
  initialFlow as emptyFlow,
  type MfaChoices,
  type MfaEnrollmentController,
  type MfaEnrollmentState,
  type PasskeySignInController,
} from '@atlasauth/js';
import { useAtlas, type AuthStatus } from './context';
import { translate } from './i18n';
import { evaluate, type ProtectCondition } from './protect';
import type { AtlasOrganizationMembership, AtlasSession, AtlasUser } from './types';
import { ATLAS_SVELTE_SDK } from './version';

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
  /** Three-state auth status (`loading` | `signed_in` | `signed_out`); same source as isLoaded/isSignedIn. */
  status: AuthStatus;
  /** The active session, or null while loading or signed out. */
  session: AtlasSession | null;
  userId: string | null;
  sessionId: string | null;
  orgId: string | null;
  orgRole: string | null;
  /** Always fresh: refreshes first if the cached token is close to expiry. */
  getToken(): Promise<string | null>;
  /** §6.6 the user's own live access token at a connected social provider. */
  getProviderToken(provider: string): Promise<ProviderToken | null>;
  /**
   * Revoke the session and drop all in-memory state. Resolves
   * `{ revoked, activeSessionId? }`; `{ strict: true }` rejects with a
   * `SignOutError` when the server could not confirm the revoke.
   */
  signOut(options?: SignOutOptions): Promise<SignOutResult>;
  /** Mirrors `<Protect>`, for logic that is not a render decision. */
  has(condition: ProtectCondition): boolean;
}

export function getAuth(): Readable<UseAuth> {
  const atlas = useAtlas();
  return derived([atlas.status, atlas.session, atlas.claims], ([$status, $session, $claims]) => ({
    isLoaded: $status !== 'loading',
    isSignedIn: $status === 'signed_in',
    status: $status,
    session: $session,
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

/**
 * The active organization's audit trail, for its admins: a store of
 * `{ entries, loading, forbidden, hasMore }` (one page at a time, newest first)
 * with `loadMore()` and `reload()`. `action` narrows it (exact, or a prefix
 * ending in `.`). `forbidden` is true when the signed-in member may not read it.
 * Follows the active organization while it has subscribers.
 */
export interface OrganizationAuditLogStore extends Readable<OrganizationAuditLogState> {
  loadMore(): Promise<void>;
  reload(): Promise<void>;
}

export function getOrganizationAuditLog(options: OrganizationAuditLogOptions = {}): OrganizationAuditLogStore {
  const atlas = useAtlas();
  const organization = getOrganization();
  const log = createOrganizationAuditLog(
    new FapiClient({
      publishableKey: atlas.publishableKey,
      baseUrl: atlas.frontendApi,
      locale: atlas.locale,
      sdk: ATLAS_SVELTE_SDK,
    }),
    options,
  );
  const state = readable(log.getState(), (set) => {
    const offState = log.subscribe(set);
    let shown: string | null | undefined;
    const offOrganization = organization.subscribe(($org) => {
      const id = $org.organization?.id ?? null;
      if (id === shown) return;
      shown = id;
      void log.load(id);
    });
    return () => {
      offOrganization();
      offState();
    };
  });
  return { subscribe: state.subscribe, loadMore: log.loadMore, reload: log.reload };
}

/* ------------------------------------------------------------------ actions */

/** Refresh-if-stale, then hand over the JWT. The `useAuth().getToken` shortcut. */
export function getToken(): Promise<string | null> {
  return useAtlas().getToken();
}

/**
 * Revoke the session and drop all in-memory state. Resolves
 * `{ revoked, activeSessionId? }`; `{ strict: true }` rejects with a
 * `SignOutError` (after the local sign-out) when the revoke was not confirmed.
 */
export function signOut(options?: SignOutOptions): Promise<SignOutResult> {
  return useAtlas().signOut(options);
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
  /**
   * Create an account (`POST /v1/client/sign_ups`) from a create-account form's
   * values — email, password and any configured sign-up fields — carrying the
   * sign-up captcha's token when the instance requires one. The emailed code is
   * then posted with {@link submit}.
   */
  create(values: Record<string, string>, consent?: boolean): void;
  /** Start a passkey-only sign-up (`POST /v1/client/sign_ups/passkey`): no password. */
  createWithPasskey(values: Record<string, string>, consent?: boolean): void;
  /** The passkey-only sign-up's last step: create the passkey, and with it the account. */
  createPasskey(): void;
  /**
   * "Email me a code instead" at the second factor (the instance's
   * `account.emailSecondFactor`): mails a code to the account's verified email;
   * it is then posted with {@link submit} like any 2FA code.
   */
  sendEmailSecondFactor(): Promise<{ sentTo?: string; error?: string }>;
  /**
   * "Text me a code instead" at the second factor (where the app offers texted
   * codes, `mfaChoices().sms`): texts a code to the account's enrolled phone;
   * it is then posted with {@link submit}.
   */
  sendSmsSecondFactor(): Promise<{ sentTo?: string; error?: string }>;
  /** What the app lets the MFA steps offer (from {@link settings}). */
  mfaChoices(): MfaChoices;
  /**
   * The MFA enrolment step (`needs_mfa_enrollment`): the authenticator app's
   * setup (QR code, setup key) or a texted code. Started and reset with the flow.
   */
  enrollment: MfaEnrollmentController;
  /** {@link enrollment}'s state as a store. */
  enrollmentState: Readable<MfaEnrollmentState>;
  /**
   * "I've saved my codes": after an enrolment the flow holds its one-time
   * recovery codes (`pendingRecoveryCodes($state)`, in memory only) and waits
   * for this before exchanging the ticket and finishing the sign-in.
   */
  saveRecoveryCodes(): void;
  /** Resend a sign-up's emailed code / link (the earlier one stops working). Resolves whether it was sent. */
  resendSignUp(): Promise<boolean>;
  /**
   * Ask the server to email a sign-in code or link on the first-factor step
   * (`POST …/prepare_first_factor`). Resolves true once it was sent; the code is
   * then posted with {@link submit}, a link is collected by polling.
   */
  prepare(strategy: 'email_code' | 'email_link'): Promise<boolean>;
  /**
   * The instance's public sign-in / sign-up settings (captcha, sign-up fields,
   * legal consent, email delivery) from `GET /v1/appearance`; null until loaded
   * or when the server could not be reached.
   */
  settings: Readable<InstanceSettings | null>;
  /**
   * The method this browser last signed in with (`password`, `oauth_github`, …)
   * for the "Last used" hint; null when none, or the instance turned it off.
   */
  lastMethod: Readable<string | null>;
  /** The sign-in captcha (identifier step / `needs_captcha` challenge). */
  captcha: CaptchaController;
  /** The sign-up captcha (the create-account step). */
  signUpCaptcha: CaptchaController;
  /**
   * The instance's policies (terms, privacy, …) for the create-account form:
   * `create` sends their acceptances and reloads them after a refusal.
   */
  policies: PolicyAcceptanceController;
  /** Load the sign-up's policies into {@link policies} (`<SignUp>` calls it on mount). */
  loadPolicies(): Promise<void>;
  /** The user declined a policy a sign-in was waiting on: cancels the attempt and says why. */
  declinePolicy(title: string): void;
  /**
   * "Continue with Atlas" (when `settings.signInWithAtlas` is set): starts the
   * SSO sign-in and sends the browser to Atlas. Resolves the server's message
   * when it could not start.
   */
  signInWithAtlas(connectionId: string): Promise<{ error?: string }>;
  /**
   * Passkey sign-in (the "Sign in with a passkey" button and passkey autofill on
   * the identifier field), offered when `settings.passkeySignIn` is on. The
   * outcome goes through the same completion as every sign-in.
   */
  passkey: PasskeySignInController;
  /** Stop the magic-link poll loop and remove the captcha widgets — call from `onDestroy`. */
  destroy(): void;
}

function createFlow(): FlowController {
  const atlas = useAtlas();
  const client = new FapiClient({
    publishableKey: atlas.publishableKey,
    baseUrl: atlas.frontendApi,
    locale: atlas.locale,
    sdk: ATLAS_SVELTE_SDK,
  });

  // Seeded from a redirect that came back mid-flow (e.g. OAuth needing a second
  // factor), so the user resumes at the demanded step instead of starting over.
  const state = writable<FlowState>(flowFromPending(atlas.pendingAttempt));
  const settings = writable<InstanceSettings | null>(null);
  const lastMethod = writable<string | null>(null);
  const t = (key: string) => translate(atlas.catalog, key);

  // §5 the per-flow captcha, driven by the instance's settings so turning it on
  // in the dashboard needs no code change. Kept in step with the settings and
  // the flow's step synchronously, before the components re-render.
  // The Atlas captcha's words follow the form's catalog.
  const captchaSettings = { atlasLabels: () => atlasCaptchaLabels(t) };
  const captcha = createCaptchaController(undefined, captchaSettings);
  const signUpCaptcha = createCaptchaController(undefined, captchaSettings);
  let identifier = '';
  const unsubscribeCaptcha = derived([settings, state], (pair) => pair).subscribe(
    ([current, flow]) => {
      captcha.configure(signInCaptchaOptions(current?.captchaFlows.signIn, flow, () => submit({})));
      const signUpFlow = current?.captchaFlows.signUp;
      signUpCaptcha.configure({ flow: signUpFlow, active: !flow.attempt && flowNeedsCaptcha(signUpFlow) });
    },
  );
  if (typeof window !== 'undefined') {
    void fetchInstanceSettings(client).then((loaded) => {
      if (loaded) settings.set(loaded);
      if (loaded?.account.lastSignInMethod) {
        void fetchLastSignInMethod(client).then((m) => lastMethod.set(m));
      }
    });
  }
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
        const res = await client.post('/v1/client/tickets/exchange', {
          attempt_id: (next.attempt as { id?: string }).id,
          ticket,
        });
        const kept = res.ok && (await atlas.reload());
        state.update((current) => ({ ...current, sessionKept: kept }));
      })();
    }, 2_000);
  }

  // On completion the response carries a one-time ticket (§7.1). Exchange it
  // for cookies over a same-origin request — FAPI is cross-origin to the app
  // and cannot set the cookie on the completion response itself — THEN
  // re-boot so the rest of the app sees a signed-in user.
  // Stays busy until this browser actually holds the session: the completion
  // alone says nothing about whether the cookie was kept.
  async function finish(next: FlowState): Promise<void> {
    // An enrolment's recovery codes are shown first; `saveRecoveryCodes` finishes.
    if (pendingRecoveryCodes(next)) {
      state.set({ ...next, busy: false });
      return;
    }
    if (next.attempt?.status === 'complete') {
      state.set({ ...next, busy: true });
      let exchanged = true;
      if (next.ticket) {
        const res = await client.post('/v1/client/tickets/exchange', {
          attempt_id: (next.attempt as { id?: string }).id,
          ticket: next.ticket,
        });
        exchanged = res.ok;
      }
      const kept = exchanged && (await atlas.reload());
      state.set({ ...next, busy: false, sessionKept: kept });
      return;
    }
    state.set(next);
    maybeStartPolling();
  }

  function submit(values: Record<string, string>): void {
    void (async () => {
      state.update((current) => ({ ...current, busy: true, errors: [] }));
      const out = await advanceWithCaptcha(client, get(state), values, { captcha, identifier, t });
      identifier = out.identifier;
      await finish(out.state);
    })();
  }

  const policies = new PolicyAcceptanceController([]);
  async function loadPolicies(): Promise<void> {
    policies.setPolicies(await loadPolicyList(client, { locale: atlas.locale ?? undefined }));
  }
  function declinePolicy(title: string): void {
    state.set({ ...emptyFlow, errors: [{ code: 'POLICY_DECLINED', message: translate(atlas.catalog, 'policy.declined', { policy: title }) }] });
  }

  function create(values: Record<string, string>, consent = true): void {
    void (async () => {
      state.update((current) => ({ ...current, busy: true, errors: [] }));
      await finish(await createSignUp(client, values, { consent, captcha: signUpCaptcha, t, policies }));
    })();
  }

  function createWithPasskey(values: Record<string, string>, consent = true): void {
    void (async () => {
      state.update((current) => ({ ...current, busy: true, errors: [] }));
      await finish(await createPasskeySignUp(client, values, { consent, captcha: signUpCaptcha, t, policies }));
    })();
  }

  async function sendSecondFactorCode(strategy: 'sms' | 'email_code'): Promise<{ sentTo?: string; error?: string }> {
    const id = get(state).attempt?.id;
    if (!id) return { error: t('error.generic') };
    try {
      return await prepareSecondFactorCode(client, id, strategy);
    } catch (error) {
      return { error: error instanceof Error ? error.message : t('error.generic') };
    }
  }
  const sendEmailSecondFactor = () => sendSecondFactorCode('email_code');
  const sendSmsSecondFactor = () => sendSecondFactorCode('sms');

  // The MFA enrolment step: started while the flow is at needs_mfa_enrollment.
  const mfaChoices = () => mfaChoicesFrom(get(settings)?.account);
  const enrollment = createMfaEnrollment(client, mfaChoices);
  const enrollmentState = writable<MfaEnrollmentState>(enrollment.state);
  const unsubscribeEnrollment = enrollment.subscribe((next) => enrollmentState.set(next));
  let enrollingFor: string | null = null;
  const unsubscribeEnrollmentStep = state.subscribe((flow) => {
    const id = flow.attempt?.status === 'needs_mfa_enrollment' ? (flow.attempt.id ?? null) : null;
    if (id === enrollingFor) return;
    enrollingFor = id;
    if (id) enrollment.start(id);
    else enrollment.reset();
  });

  function saveRecoveryCodes(): void {
    void finish(acknowledgeRecoveryCodes(get(state)));
  }

  async function resendSignUp(): Promise<boolean> {
    state.update((current) => ({ ...current, busy: true, errors: [] }));
    const next = await resendSignUpVerification(client, get(state));
    state.set(next);
    return next.errors.length === 0;
  }

  function createPasskey(): void {
    void (async () => {
      state.update((current) => ({ ...current, busy: true, errors: [] }));
      await finish(await finishPasskeySignUp(client, get(state), { t }));
    })();
  }

  async function prepare(strategy: 'email_code' | 'email_link'): Promise<boolean> {
    state.update((current) => ({ ...current, busy: true, errors: [] }));
    const next = await prepareFactor(client, get(state), strategy);
    state.set({ ...next, busy: false });
    maybeStartPolling();
    return next.errors.length === 0;
  }

  const passkey = createPasskeySignInController({
    client,
    onStart: () => state.set({ ...get(state), busy: true, errors: [] }),
    onResult: finish,
    captcha: () => captcha,
    cancelledMessage: () => t('signIn.passkeyCancelled'),
  });

  function destroy(): void {
    passkey.stopAutofill();
    stopPolling();
    unsubscribeCaptcha();
    unsubscribeEnrollment();
    unsubscribeEnrollmentStep();
    captcha.destroy();
    signUpCaptcha.destroy();
  }

  async function signInWithAtlas(connectionId: string): Promise<{ error?: string }> {
    if (typeof window === 'undefined') return {};
    const started = await startSignInWithAtlas(client, connectionId, window.location.href);
    if ('url' in started) {
      window.location.assign(started.url);
      return {};
    }
    return { error: started.error };
  }

  return {
    state: { subscribe: state.subscribe },
    submit,
    create,
    createWithPasskey,
    createPasskey,
    sendEmailSecondFactor,
    sendSmsSecondFactor,
    mfaChoices,
    enrollment,
    enrollmentState: { subscribe: enrollmentState.subscribe },
    saveRecoveryCodes,
    resendSignUp,
    prepare,
    settings: { subscribe: settings.subscribe },
    lastMethod: { subscribe: lastMethod.subscribe },
    captcha,
    signUpCaptcha,
    policies,
    loadPolicies,
    declinePolicy,
    signInWithAtlas,
    passkey,
    destroy,
  };
}

/** Start (or resume) a sign-in flow. Drives `<SignIn>`; usable standalone too. */
export function signIn(): FlowController {
  return createFlow();
}

/**
 * Start a sign-up flow. Drives `<SignUp>`; usable standalone too:
 * `create(values)` posts `/v1/client/sign_ups` (the account is created there),
 * then `submit({ code })` verifies the emailed code and completes the session.
 */
export function signUp(): FlowController {
  return createFlow();
}
