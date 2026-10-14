import { WritableSignal, signal } from '@angular/core';
import {
  FapiClient,
  advanceWithCaptcha,
  createCaptchaController,
  createSignUp,
  fetchInstanceSettings,
  flowNeedsCaptcha,
  signInCaptchaOptions,
  flowFromPending,
  initialFlow,
  pollAttempt,
  shouldKeepPolling,
  type CaptchaController,
  type FlowState,
  type InstanceSettings,
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
  /** The sign-in captcha (identifier step / `needs_captcha` challenge). */
  readonly captcha: CaptchaController = createCaptchaController();
  /** The sign-up captcha (the create-account step). */
  readonly signUpCaptcha: CaptchaController = createCaptchaController();
  /** Whether {@link captcha} currently draws a widget (for templates). */
  readonly captchaDrawn = signal(false);
  /** Whether {@link signUpCaptcha} currently draws a widget (for templates). */
  readonly signUpCaptchaDrawn = signal(false);
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private identifier = '';

  constructor(
    private readonly client: FapiClient,
    private readonly reload: () => Promise<void>,
    pending: { id: string; status: string } | null,
    /** Resolves the captcha messages' catalog keys. Defaults to en-US. */
    private readonly t: (key: string) => string = (key) => translate(EN_US, key),
  ) {
    // Seeded from a redirect that came back mid-flow (e.g. OAuth needing a second
    // factor) so the user resumes at the demanded step instead of starting over.
    this.state = signal<FlowState>(pending ? flowFromPending(pending) : initialFlow);
    this.syncCaptcha();
  }

  /** Fetch the instance's public settings and draw whatever captcha they require. */
  async loadSettings(): Promise<void> {
    const loaded = await fetchInstanceSettings(this.client);
    if (loaded) {
      this.settings.set(loaded);
      this.syncCaptcha();
    }
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
    this.state.set(next);
    this.syncCaptcha();
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
    });
    await this.finish(next);
  }

  private async finish(next: FlowState): Promise<void> {
    this.setState(next);

    if (next.attempt?.status === 'complete') {
      if (next.ticket) {
        await this.client.post('/v1/client/tickets/exchange', {
          attempt_id: (next.attempt as { id?: string }).id,
          ticket: next.ticket,
        });
      }
      await this.reload();
    } else {
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
        if (!ticket || !next.attempt) return;

        // The ticket is exchanged by a normal request, so no session token ever
        // appears in a URL.
        await this.client.post('/v1/client/tickets/exchange', {
          attempt_id: (next.attempt as { id?: string }).id,
          ticket,
        });
        await this.reload();
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
