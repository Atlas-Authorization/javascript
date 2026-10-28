import { onScopeDispose, shallowRef, watch, type ShallowRef } from 'vue';
import {
  advanceWithCaptcha,
  atlasCaptchaLabels,
  createCaptchaController,
  createPasskeySignUp,
  createSignUp,
  finishPasskeySignUp,
  fetchInstanceSettings,
  fetchLastSignInMethod,
  createMfaEnrollment,
  acknowledgeRecoveryCodes,
  pendingRecoveryCodes,
  mfaChoicesFrom,
  prepareSecondFactorCode,
  resendSignUpVerification,
  signInCaptchaOptions,
  PolicyAcceptanceController,
  loadPolicies as loadPolicyList,
  initialFlow as emptyFlow,
  flowNeedsCaptcha,
  type CaptchaController,
  type InstanceSettings,
  type MfaChoices,
  type MfaEnrollmentController,
  type MfaEnrollmentState,
} from '@atlasauth/js';
import {
  FapiClient,
  flowFromPending,
  pollAttempt,
  prepareFactor,
  shouldKeepPolling,
  type FlowState,
} from './fapi';
import { useAtlas } from './context';
import { translate } from './i18n';
import { ATLAS_VUE_SDK } from './version';

/**
 * §10.2 the server-driven sign-in / sign-up flow, as a composable.
 *
 * The Vue peer of the React SDK's internal `useFlow`. It never decides what
 * comes next — it drives the flow through `advance`, which owns the
 * step-to-endpoint mapping in `@atlasauth/js`, and renders whatever `status` the
 * server returned. Sign-in and sign-up share it: `<SignUp>` starts the attempt
 * with {@link FlowController.create} (`POST /v1/client/sign_ups`), then the
 * emailed-code step runs through the same `submit`, exactly as in React.
 */
export interface FlowController {
  /** The current server-driven attempt state. */
  state: ShallowRef<FlowState>;
  /** Post the current step's fields; the server decides the next status. */
  submit(values: Record<string, string>): void;
  /**
   * Create an account (`POST /v1/client/sign_ups`) from a create-account form's
   * values — email, password and any configured sign-up fields — carrying the
   * sign-up captcha's token when the instance requires one. The emailed code is
   * then posted with {@link submit}.
   */
  create(values: Record<string, string>, consent?: boolean): void;
  /**
   * Start a passkey-only sign-up (`POST /v1/client/sign_ups/passkey`) from the
   * create-account form's values — no password. Offered when the instance's
   * `account.passkeySignUp` is set.
   */
  createWithPasskey(values: Record<string, string>, consent?: boolean): void;
  /**
   * The passkey-only sign-up's last step (`awaitingPasskey(attempt)`): run the
   * browser ceremony; the server creates the account when it verifies.
   */
  createPasskey(): void;
  /**
   * "Email me a code instead" on the second-factor step (when the instance's
   * `account.emailSecondFactor` is on): mails a code to the account's verified
   * email; the code is then posted with {@link submit} like any 2FA code.
   */
  sendEmailSecondFactor(): Promise<{ sentTo?: string; error?: string }>;
  /**
   * "Text me a code instead" on the second-factor step (where the app offers
   * texted codes, `mfaChoices().sms`): texts a code to the account's enrolled
   * phone; the code is then posted with {@link submit}.
   */
  sendSmsSecondFactor(): Promise<{ sentTo?: string; error?: string }>;
  /** What the app lets the MFA steps offer (from {@link settings}). */
  mfaChoices(): MfaChoices;
  /**
   * The MFA enrolment step (`needs_mfa_enrollment`): the authenticator app's
   * setup (QR code, setup key) or a texted code. Started and reset with the flow.
   */
  enrollment: MfaEnrollmentController;
  /** {@link enrollment}'s state, for templates. */
  enrollmentState: ShallowRef<MfaEnrollmentState>;
  /**
   * "I've saved my codes": after an enrolment the flow holds its one-time
   * recovery codes (`pendingRecoveryCodes(state)`, in memory only) and waits
   * for this before exchanging the ticket and finishing the sign-in.
   */
  saveRecoveryCodes(): void;
  /** Resend a sign-up's emailed code / link (the earlier one stops working). Resolves whether it was sent. */
  resendSignUp(): Promise<boolean>;
  /**
   * Ask the server to email a sign-in code or link for the current first-factor
   * step (`prepare_first_factor`). Resolves whether it was sent; the code is then
   * posted with {@link submit}, and a link is collected by the poll.
   */
  prepare(strategy: 'email_code' | 'email_link'): Promise<boolean>;
  /**
   * The instance's public sign-in / sign-up settings (captcha, sign-up fields,
   * legal consent, `emailDelivery`) from `GET /v1/appearance`; null until loaded
   * or when the server could not be reached.
   */
  settings: ShallowRef<InstanceSettings | null>;
  /**
   * The method this browser last signed in with (`password`, `oauth_github`, …)
   * for the "Last used" hint; null when none, or the instance turned it off.
   */
  lastMethod: ShallowRef<string | null>;
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
}

export function useFlow(): FlowController {
  const atlas = useAtlas();
  // Seeded from a redirect that came back mid-flow (e.g. OAuth needing a second
  // factor), so the user resumes at the demanded step instead of starting over.
  const state = shallowRef<FlowState>(flowFromPending(atlas.pendingAttempt));
  const settings = shallowRef<InstanceSettings | null>(null);
  const lastMethod = shallowRef<string | null>(null);
  const t = (key: string) => translate(atlas.catalog, key);

  const client = new FapiClient({
    publishableKey: atlas.publishableKey,
    baseUrl: atlas.frontendApi,
    locale: atlas.locale,
    sdk: ATLAS_VUE_SDK,
  });

  // §5 the per-flow captcha, driven by the instance's settings so turning it on
  // in the dashboard needs no code change. The widgets draw into the slots the
  // components attach.
  // The Atlas captcha's words follow the form's catalog.
  const captchaSettings = { atlasLabels: () => atlasCaptchaLabels(t) };
  const captcha = createCaptchaController(undefined, captchaSettings);
  const signUpCaptcha = createCaptchaController(undefined, captchaSettings);
  let identifier = '';

  // On completion the response carries a one-time ticket (§7.1). Exchange it
  // for cookies over a same-origin request — FAPI is cross-origin to the app
  // and cannot set the cookie on the completion response itself — THEN
  // re-boot so the rest of the app sees a signed-in user.
  // Stays busy until this browser actually holds the session: the completion
  // alone says nothing about whether the cookie was kept.
  const finish = async (next: FlowState) => {
    // An enrolment's recovery codes are shown first; `saveRecoveryCodes` finishes.
    if (pendingRecoveryCodes(next)) {
      state.value = { ...next, busy: false };
      return;
    }
    if (next.attempt?.status !== 'complete') {
      state.value = next;
      return;
    }
    state.value = { ...next, busy: true };
    let exchanged = true;
    if (next.ticket) {
      const res = await client.post('/v1/client/tickets/exchange', {
        attempt_id: (next.attempt as { id?: string }).id,
        ticket: next.ticket,
      });
      exchanged = res.ok;
    }
    const kept = exchanged && (await atlas.reload());
    state.value = { ...next, busy: false, sessionKept: kept };
  };

  const submit = (values: Record<string, string>) => {
    void (async () => {
      state.value = { ...state.value, busy: true, errors: [] };
      const out = await advanceWithCaptcha(client, state.value, values, { captcha, identifier, t });
      identifier = out.identifier;
      await finish(out.state);
    })();
  };

  const policies = new PolicyAcceptanceController([]);
  const loadPolicies = async () => {
    policies.setPolicies(await loadPolicyList(client, { locale: atlas.locale ?? undefined }));
  };
  const declinePolicy = (title: string) => {
    state.value = { ...emptyFlow, errors: [{ code: 'POLICY_DECLINED', message: translate(atlas.catalog, 'policy.declined', { policy: title }) }] };
  };

  const create = (values: Record<string, string>, consent = true) => {
    void (async () => {
      state.value = { ...state.value, busy: true, errors: [] };
      await finish(await createSignUp(client, values, { consent, captcha: signUpCaptcha, t, policies }));
    })();
  };

  const createWithPasskey = (values: Record<string, string>, consent = true) => {
    void (async () => {
      state.value = { ...state.value, busy: true, errors: [] };
      await finish(await createPasskeySignUp(client, values, { consent, captcha: signUpCaptcha, t, policies }));
    })();
  };

  const createPasskey = () => {
    void (async () => {
      state.value = { ...state.value, busy: true, errors: [] };
      await finish(await finishPasskeySignUp(client, state.value, { t }));
    })();
  };

  const sendSecondFactorCode = async (strategy: 'sms' | 'email_code'): Promise<{ sentTo?: string; error?: string }> => {
    const id = state.value.attempt?.id;
    if (!id) return { error: t('error.generic') };
    try {
      return await prepareSecondFactorCode(client, id, strategy);
    } catch (error) {
      return { error: error instanceof Error ? error.message : t('error.generic') };
    }
  };
  const sendEmailSecondFactor = () => sendSecondFactorCode('email_code');
  const sendSmsSecondFactor = () => sendSecondFactorCode('sms');

  const mfaChoices = () => mfaChoicesFrom(settings.value?.account);
  const enrollment = createMfaEnrollment(client, mfaChoices);
  const enrollmentState = shallowRef<MfaEnrollmentState>(enrollment.state);
  const stopEnrollment = enrollment.subscribe((next) => {
    enrollmentState.value = next;
  });
  watch(
    [() => state.value.attempt?.id ?? null, () => state.value.attempt?.status],
    ([id, status]) => {
      if (id && status === 'needs_mfa_enrollment') enrollment.start(id);
      else enrollment.reset();
    },
    { immediate: true },
  );
  onScopeDispose(stopEnrollment);

  const saveRecoveryCodes = () => {
    void finish(acknowledgeRecoveryCodes(state.value));
  };

  const resendSignUp = async (): Promise<boolean> => {
    state.value = { ...state.value, busy: true, errors: [] };
    state.value = await resendSignUpVerification(client, state.value);
    return state.value.errors.length === 0;
  };

  const prepare = async (strategy: 'email_code' | 'email_link') => {
    state.value = { ...state.value, busy: true, errors: [] };
    const next = await prepareFactor(client, state.value, strategy);
    state.value = { ...next, busy: false };
    return next.errors.length === 0;
  };

  // Keep both captchas in step with the settings and the flow's current step.
  watch(
    [settings, state],
    ([current, flow]) => {
      captcha.configure(signInCaptchaOptions(current?.captchaFlows.signIn, flow, () => submit({})));
      const signUpFlow = current?.captchaFlows.signUp;
      signUpCaptcha.configure({ flow: signUpFlow, active: !flow.attempt && flowNeedsCaptcha(signUpFlow) });
    },
    { immediate: true },
  );
  if (typeof window !== 'undefined') {
    void fetchInstanceSettings(client).then((loaded) => {
      if (loaded) settings.value = loaded;
      if (loaded?.account.lastSignInMethod) {
        void fetchLastSignInMethod(client).then((m) => {
          lastMethod.value = m;
        });
      }
    });
  }
  onScopeDispose(() => {
    captcha.destroy();
    signUpCaptcha.destroy();
  });

  // §5.3: collect a sign-in completed by a link opened on another device. The
  // poll restarts whenever the flow state changes and only runs while the state
  // says it should — the Vue peer of React's polling effect.
  let poller: ReturnType<typeof setInterval> | null = null;
  const stopPolling = () => {
    if (poller) {
      clearInterval(poller);
      poller = null;
    }
  };

  watch(
    state,
    (current) => {
      stopPolling();
      if (!shouldKeepPolling(current)) return;

      poller = setInterval(() => {
        void (async () => {
          const { state: next, ticket } = await pollAttempt(client, state.value);
          state.value = next;
          if (!ticket || !next.attempt) return;

          // The ticket is exchanged by a normal request, so no session token has
          // ever appeared in a URL.
          const res = await client.post('/v1/client/tickets/exchange', {
            attempt_id: (next.attempt as { id?: string }).id,
            ticket,
          });
          const kept = res.ok && (await atlas.reload());
          state.value = { ...state.value, sessionKept: kept };
        })();
      }, 2_000);
    },
    { immediate: true },
  );

  onScopeDispose(stopPolling);

  return {
    state,
    submit,
    create,
    createWithPasskey,
    createPasskey,
    sendEmailSecondFactor,
    sendSmsSecondFactor,
    mfaChoices,
    enrollment,
    enrollmentState,
    saveRecoveryCodes,
    resendSignUp,
    prepare,
    settings,
    lastMethod,
    captcha,
    signUpCaptcha,
    policies,
    loadPolicies,
    declinePolicy,
  };
}

/** §10.2 `useSignIn()` — drive a sign-in attempt. */
export function useSignIn(): FlowController {
  return useFlow();
}

/**
 * §10.2 `useSignUp()` — drive a sign-up attempt: `create(values)` posts
 * `/v1/client/sign_ups` (the account is created there), then `submit({ code })`
 * verifies the emailed code and completes the session.
 */
export function useSignUp(): FlowController {
  return useFlow();
}
