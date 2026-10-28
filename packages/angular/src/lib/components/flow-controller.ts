import { WritableSignal, signal } from '@angular/core';
import {
  FapiClient,
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
  flowNeedsCaptcha,
  signInCaptchaOptions,
  flowFromPending,
  initialFlow,
  nextStep,
  offeredFirstFactors,
  pollAttempt,
  prepareFactor,
  planFirstFactor,
  shouldKeepPolling,
  PolicyAcceptanceController,
  loadPolicies,
  type CaptchaController,
  type FlowState,
  type InstanceSettings,
  type MfaChoices,
  type MfaEnrollmentController,
  type MfaEnrollmentState,
} from '@atlasauth/js';
import { EN_US, translate } from '../i18n';

/**
 * The server-driven sign-in / sign-up engine, shared by `<atlas-sign-in>` and
 * `<atlas-sign-up>` — the Angular counterpart of React's `useFlow` hook.
 *
 * It owns no decision about what comes next: every status comes back from the
 * server via `advance`, and this controller only posts whatever the current step
 * needs and re-renders the returned status. State lives in a signal so templates
 * update whether the app runs zoned or zoneless.
 *
 * `<atlas-sign-up>` starts the attempt with {@link create}
 * (`POST /v1/client/sign_ups`); the emailed-code step then runs through the same
 * {@link submit}. Both flows draw the instance's captcha (from
 * {@link loadSettings}) when it is required.
 */
export class AtlasFlowController {
  readonly state: WritableSignal<FlowState>;
  /**
   * The instance's public sign-in / sign-up settings (captcha, sign-up fields,
   * legal consent) from `GET /v1/appearance`; null until {@link loadSettings}
   * resolves, or when the server could not be reached.
   */
  readonly settings = signal<InstanceSettings | null>(null);
  /**
   * The method this browser last signed in with (`password`, `oauth_github`, …)
   * for the "Last used" hint; null when none, or the instance turned it off.
   */
  readonly lastMethod = signal<string | null>(null);
  /** The sign-in captcha (identifier step / `needs_captcha` challenge). */
  readonly captcha: CaptchaController = createCaptchaController(undefined, {
    // The Atlas captcha's words follow the form's catalog (read when drawn).
    atlasLabels: () => atlasCaptchaLabels(this.t),
  });
  /** The sign-up captcha (the create-account step). */
  readonly signUpCaptcha: CaptchaController = createCaptchaController(undefined, {
    atlasLabels: () => atlasCaptchaLabels(this.t),
  });
  /** Whether {@link captcha} currently draws a widget (for templates). */
  readonly captchaDrawn = signal(false);
  /** Whether {@link signUpCaptcha} currently draws a widget (for templates). */
  readonly signUpCaptchaDrawn = signal(false);
  /**
   * The first factor the server was asked to send ({@link prepare}) on the
   * current `needs_first_factor` step — the form then collects its code. Null
   * otherwise.
   */
  readonly preparedFactor = signal<'email_code' | null>(null);
  /**
   * "Email me a code instead" at the second factor ({@link sendEmailSecondFactor}):
   * in flight, where the code went, or why it was not sent. Null until asked,
   * and again once the flow leaves that step.
   */
  readonly emailSecondFactor = signal<{ busy?: boolean; sentTo?: string; error?: string } | null>(null);
  /** "Text me a code instead" at the second factor ({@link sendSmsSecondFactor}): as {@link emailSecondFactor}. */
  readonly smsSecondFactor = signal<{ busy?: boolean; sentTo?: string; error?: string } | null>(null);
  /**
   * The MFA enrolment step (`needs_mfa_enrollment`): the authenticator app's
   * setup (QR code, setup key) or a texted code. Started and reset with the flow.
   */
  readonly enrollment: MfaEnrollmentController;
  /** {@link enrollment}'s state, for templates. */
  readonly enrollmentState: WritableSignal<MfaEnrollmentState>;
  /**
   * The instance's policies (terms, privacy, …) for the create-account form:
   * {@link create} sends their acceptances and reloads them after a refusal.
   */
  readonly policies = new PolicyAcceptanceController([]);
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private identifier = '';

  constructor(
    private readonly client: FapiClient,
    private readonly reload: () => Promise<boolean>,
    pending: { id: string; status: string } | null,
    /** Resolves the captcha messages' catalog keys. Defaults to en-US. */
    private readonly t: (key: string) => string = (key) => translate(EN_US, key),
  ) {
    // Seeded from a redirect that came back mid-flow (e.g. OAuth needing a second
    // factor) so the user resumes at the demanded step instead of starting over.
    this.state = signal<FlowState>(pending ? flowFromPending(pending) : initialFlow);
    this.enrollment = createMfaEnrollment(this.client, () => this.mfaChoices());
    this.enrollmentState = signal<MfaEnrollmentState>(this.enrollment.state);
    this.enrollment.subscribe((next) => this.enrollmentState.set(next));
    this.syncCaptcha();
    this.syncEnrollment();
  }

  /** What the app lets the MFA steps offer (from {@link settings}). */
  mfaChoices(): MfaChoices {
    return mfaChoicesFrom(this.settings()?.account);
  }

  /** Start the enrolment step for its attempt, or reset it once the flow leaves. */
  private syncEnrollment(): void {
    const attempt = this.state().attempt;
    if (attempt?.status === 'needs_mfa_enrollment' && attempt.id) this.enrollment.start(attempt.id);
    else this.enrollment.reset();
  }

  /** Fetch the instance's public settings and draw whatever captcha they require. */
  async loadSettings(): Promise<void> {
    const loaded = await fetchInstanceSettings(this.client);
    if (loaded) {
      this.settings.set(loaded);
      this.syncCaptcha();
      if (loaded.account.lastSignInMethod) this.lastMethod.set(await fetchLastSignInMethod(this.client));
    }
  }

  /**
   * The first factors to offer on a `needs_first_factor` step: the server's list
   * without email code / link while the app cannot deliver email
   * (`settings.emailDelivery.available === false`). Empty on any other step.
   */
  firstFactors(): string[] {
    const attempt = this.state().attempt;
    const step = attempt ? nextStep(attempt) : null;
    return step?.kind === 'collect_first_factor'
      ? offeredFirstFactors(step.strategies, this.settings()?.emailDelivery)
      : [];
  }

  /**
   * True when email + password sign-up cannot complete because the app cannot
   * send the verification email (`settings.emailDelivery.passwordSignUp === false`):
   * `<atlas-sign-up>` shows the "can't send email" notice instead of the form.
   */
  signUpEmailUnavailable(): boolean {
    return this.settings()?.emailDelivery.passwordSignUp === false;
  }

  /** False when a password reset email cannot be delivered — hide "Forgot password?". */
  passwordResetAvailable(): boolean {
    return this.settings()?.emailDelivery.passwordReset !== false;
  }

  /**
   * Ask the server to email a sign-in code for the current `needs_first_factor`
   * step (`POST …/prepare_first_factor`); the form then collects the code, which
   * {@link submit} posts as the `email_code` strategy.
   */
  async prepare(strategy: 'email_code'): Promise<void> {
    if (!this.firstFactors().includes(strategy)) return;
    this.state.update((current) => ({ ...current, busy: true, errors: [] }));
    const next = await prepareFactor(this.client, this.state(), strategy);
    this.setState(next);
    if (!next.errors.length) this.preparedFactor.set(strategy);
  }

  /** Keep both captchas in step with the settings and the flow's current step. */
  private syncCaptcha(): void {
    const settings = this.settings();
    const state = this.state();
    this.captcha.configure(
      signInCaptchaOptions(settings?.captchaFlows.signIn, state, () => void this.submit({})),
    );
    const signUpFlow = settings?.captchaFlows.signUp;
    this.signUpCaptcha.configure({
      flow: signUpFlow,
      active: !state.attempt && flowNeedsCaptcha(signUpFlow),
    });
    this.captchaDrawn.set(this.captcha.needed);
    this.signUpCaptchaDrawn.set(this.signUpCaptcha.needed);
  }

  private setState(next: FlowState): void {
    const previousId = this.state().attempt?.id ?? null;
    this.state.set(next);
    // A prepared factor belongs to the first-factor step it was sent for.
    if (next.attempt?.status !== 'needs_first_factor') this.preparedFactor.set(null);
    // An emailed second-factor code belongs to the second-factor step of this attempt.
    if (next.attempt?.status !== 'needs_second_factor' || (next.attempt?.id ?? null) !== previousId) {
      this.emailSecondFactor.set(null);
      this.smsSecondFactor.set(null);
    }
    this.syncCaptcha();
    this.syncEnrollment();
    this.autoSend();
  }

  private autoSentFor: string | null = null;
  /**
   * With no password on offer, email the code as soon as the server asks for a
   * first factor — once per attempt, so a failed send waits for the user's retry
   * (the "Email me a code" button) instead of looping.
   */
  private autoSend(): void {
    const id = this.state().attempt?.id ?? null;
    if (!id || this.autoSentFor === id || this.preparedFactor()) return;
    if (planFirstFactor(this.firstFactors()).autoSend !== 'email_code') return;
    this.autoSentFor = id;
    void this.prepare('email_code');
  }

  /**
   * Advance the flow with the values the user typed. On completion, exchange the
   * one-time ticket for cookies over a same-origin request (FAPI is cross-origin
   * and cannot set the cookie on its own response), then re-boot so the rest of
   * the app sees a signed-in user.
   */
  async submit(values: Record<string, string>): Promise<void> {
    this.state.update((current) => ({ ...current, busy: true, errors: [] }));

    const out = await advanceWithCaptcha(this.client, this.state(), values, {
      captcha: this.captcha,
      identifier: this.identifier,
      t: this.t,
    });
    this.identifier = out.identifier;
    await this.finish(out.state);
  }

  /** Load the sign-up's policies into {@link policies} (`<atlas-sign-up>` calls it on init). */
  async loadPolicies(locale?: string): Promise<void> {
    this.policies.setPolicies(await loadPolicies(this.client, { locale }));
  }

  /** The user declined a policy a sign-in was waiting on: cancel the attempt and say why. */
  declinePolicy(title: string): void {
    this.state.set({
      ...initialFlow,
      errors: [{ code: 'POLICY_DECLINED', message: this.t('policy.declined').replace('{policy}', title) }],
    });
  }

  /**
   * Create an account (`POST /v1/client/sign_ups`) from a create-account form's
   * values — email, password and any configured sign-up fields — carrying the
   * sign-up captcha's token when the instance requires one. The emailed code is
   * then posted with {@link submit}.
   */
  async create(values: Record<string, string>, consent = true): Promise<void> {
    this.state.update((current) => ({ ...current, busy: true, errors: [] }));
    const next = await createSignUp(this.client, values, {
      consent,
      captcha: this.signUpCaptcha,
      t: this.t,
      policies: this.policies,
    });
    await this.finish(next);
  }

  /**
   * "Email me a code instead" at the second factor (the instance's
   * `account.emailSecondFactor`): mails a code to the account's verified email;
   * it is then posted with {@link submit} like any 2FA code.
   */
  async sendEmailSecondFactor(): Promise<void> {
    await this.sendSecondFactorCode('email_code', this.emailSecondFactor);
  }

  /**
   * "Text me a code instead" at the second factor (where the app offers texted
   * codes, {@link mfaChoices}`().sms`): texts a code to the account's enrolled
   * phone; it is then posted with {@link submit} like any 2FA code.
   */
  async sendSmsSecondFactor(): Promise<void> {
    await this.sendSecondFactorCode('sms', this.smsSecondFactor);
  }

  private async sendSecondFactorCode(
    strategy: 'sms' | 'email_code',
    out: WritableSignal<{ busy?: boolean; sentTo?: string; error?: string } | null>,
  ): Promise<void> {
    const id = this.state().attempt?.id;
    if (!id) return;
    out.set({ busy: true });
    try {
      const { sentTo } = await prepareSecondFactorCode(this.client, id, strategy);
      out.set({ sentTo });
    } catch (error) {
      out.set({ error: error instanceof Error ? error.message : this.t('error.generic') });
    }
  }

  /** Resend a sign-up's emailed code / link (the earlier one stops working). */
  async resendSignUp(): Promise<void> {
    this.state.update((current) => ({ ...current, busy: true, errors: [] }));
    this.state.set(await resendSignUpVerification(this.client, this.state()));
  }

  /**
   * Start a passkey-only sign-up (`POST /v1/client/sign_ups/passkey`) from the
   * create-account form's values — no password. Offered when the instance's
   * `account.passkeySignUp` is set.
   */
  async createWithPasskey(values: Record<string, string>, consent = true): Promise<void> {
    this.state.update((current) => ({ ...current, busy: true, errors: [] }));
    await this.finish(await createPasskeySignUp(this.client, values, { consent, captcha: this.signUpCaptcha, t: this.t, policies: this.policies }));
  }

  /** The passkey-only sign-up's last step: create the passkey, and with it the account. */
  async createPasskey(): Promise<void> {
    this.state.update((current) => ({ ...current, busy: true, errors: [] }));
    await this.finish(await finishPasskeySignUp(this.client, this.state(), { t: this.t }));
  }

  /**
   * The recovery codes an MFA enrolment just completed the sign-in with, shown
   * once before it finishes ({@link saveRecoveryCodes}); null otherwise. They
   * live only in this controller's memory.
   */
  recoveryCodes(): string[] | null {
    return pendingRecoveryCodes(this.state());
  }

  /** "I've saved my codes": forget the recovery codes and finish the sign-in. */
  async saveRecoveryCodes(): Promise<void> {
    await this.finish(acknowledgeRecoveryCodes(this.state()));
  }

  private async finish(next: FlowState): Promise<void> {
    // An enrolment's recovery codes are shown first; `saveRecoveryCodes` finishes.
    if (pendingRecoveryCodes(next)) {
      this.setState({ ...next, busy: false });
      return;
    }
    if (next.attempt?.status === 'complete') {
      // Stays busy until this browser actually holds the session: the completion
      // alone says nothing about whether the cookie was kept.
      this.setState({ ...next, busy: true });
      let exchanged = true;
      if (next.ticket) {
        const res = await this.client.post('/v1/client/tickets/exchange', {
          attempt_id: (next.attempt as { id?: string }).id,
          ticket: next.ticket,
        });
        exchanged = res.ok;
      }
      const kept = exchanged && (await this.reload());
      this.setState({ ...next, busy: false, sessionKept: kept });
    } else {
      this.setState(next);
      // A magic-link step may now be pollable (a link opened on another device).
      this.syncPolling();
    }
  }

  /** Start/stop the §5.3 magic-link poll to match the current state. */
  syncPolling(): void {
    if (shouldKeepPolling(this.state())) {
      this.startPolling();
    } else {
      this.stopPolling();
    }
  }

  private startPolling(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => {
      void (async () => {
        const { state: next, ticket } = await pollAttempt(this.client, this.state());
        this.setState(next);
        // e.g. a passkey sign-up whose email was just proven: only this tab can go on.
        if (!ticket && !shouldKeepPolling(next)) this.stopPolling();
        if (!ticket || !next.attempt) return;

        // The ticket is exchanged by a normal request, so no session token ever
        // appears in a URL.
        const res = await this.client.post('/v1/client/tickets/exchange', {
          attempt_id: (next.attempt as { id?: string }).id,
          ticket,
        });
        const kept = res.ok && (await this.reload());
        this.setState({ ...this.state(), sessionKept: kept });
        this.stopPolling();
      })();
    }, 2_000);
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /** Release the poll timer and the captcha widgets — call from the component's `ngOnDestroy`. */
  destroy(): void {
    this.stopPolling();
    this.captcha.destroy();
    this.signUpCaptcha.destroy();
  }
}
