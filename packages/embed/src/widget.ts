import {
  initialFlow,
  BehaviorRecorder,
  type FapiClient,
  type FlowState,
  type ResetFlowState,
} from '@atlasauth/js';
import {
  cssVariables,
  textOnPrimary,
  orderedProviders,
  resolveSocialButtons,
  resolveCodeInput,
  resolveInteraction,
  resolveTokens,
  MOTION_MS,
  type CodeInputStyle,
  type AppearanceResponse,
  type CaptchaFlowKey,
  type FlowCaptcha,
  type PublicAppearance,
  type PublicSignUpField,
  type ResolvedSocialButtons,
  type ResolvedInteraction,
  type WidgetAppearance,
} from './appearance';
import { createClient, fetchAppearance } from './client';
import { injectStyles } from './styles';
import { applyAppearanceToDom, instanceDesignFrom, type AppliedAppearance, type InstanceDesign } from '@atlasauth/design/runtime';
import { widgetDesign, type WidgetDesign } from './design';
import { render, renderLoading } from './widget/render';
import { handleRedirectLanding } from './widget/flow';
import { startConditionalPasskey } from './widget/passkey';

/**
 * The framework-agnostic sign-in panel.
 *
 * It renders in the HOST DOM — never an iframe — for the same reasons the React
 * SDK does (§10.3): password managers, autofill and the tenant's own CSS all
 * need real, same-document markup. It drives the SAME FAPI endpoints as the
 * React `<SignIn/>` and the hosted page, through the shared `@atlasauth/js` flow
 * driver, so the three surfaces cannot diverge in what the server sees.
 */
export interface WidgetOptions {
  /** Publishable key (`pk_…`) identifying the instance. */
  publishableKey: string;
  /** The instance's FAPI origin the widget calls cross-origin. */
  frontendApi: string;
  mode?: 'sign-in' | 'sign-up';
  /** Where to go on success. Validated: same-origin or an absolute https URL. */
  redirect?: string;
  /**
   * Preview mode: run the whole sign-in flow (every provider and factor) but
   * NEVER exchange the ticket for a session cookie, so a "test your login"
   * preview embedded in another app cannot clobber that app's own session. The
   * `atlas:complete` event still fires; no redirect happens.
   */
  preview?: boolean;
  /** Inline appearance override, merged over the tenant's public appearance. */
  appearance?: WidgetAppearance;
  /** Injected in tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

export class AtlasWidget {
  readonly client: FapiClient;
  readonly mode: 'sign-in' | 'sign-up';
  appearance: PublicAppearance | null = null;
  /** The design-system layer (dashboard design + inline preset/design), when any. */
  design: WidgetDesign | null = null;
  private appliedDesign?: AppliedAppearance;
  providers: string[] = [];
  /** Providers that render the official native button (Google GSI), by client_id. */
  nativeProviders: { provider: string; client_id: string }[] = [];
  /** "Sign in with Atlas" state — the preset OIDC connection, when enabled. */
  signInWithAtlas: { enabled: boolean; connection_id?: string } = { enabled: false };
  /** How the social buttons are drawn — resolved from tenant default + inline override. */
  social: ResolvedSocialButtons = resolveSocialButtons(undefined, undefined);
  /** How a verification code is entered — segmented `boxes` (default) or `single`. */
  codeInputStyle: CodeInputStyle = 'boxes';
  /** How controls feel — button style/effect, shadow, density, input style, motion. */
  interaction: ResolvedInteraction = resolveInteraction(undefined, undefined);
  /**
   * §5.3 second-factor fallback: when the user chose "use a backup code", the 2FA
   * step renders a single free-text field (recovery codes are alphanumeric and
   * variable-length, so they can't go in fixed digit boxes) instead of the OTP
   * boxes. Reset whenever a fresh flow starts.
   */
  backupCodeMode = false;
  /**
   * The email/username the user typed at the identifier step, kept so later steps
   * can show it as context ("Enter the code we sent to you@example.com") — the
   * server's attempt view does not echo it back.
   */
  enteredIdentifier: string | null = null;
  /** The step shown on the previous render — so the spawn animation plays only on a real step change. */
  lastStepKind: string | null = null;
  /** §5 the tenant's configured extra sign-up fields (name, company, custom…). */
  signUpFields: PublicSignUpField[] = [];
  /** Whether password is an enabled first factor — drives single-screen sign-in. */
  passwordEnabled = true;
  /** §5.5 whether the instance offers passkeys — gates the "Sign in with a passkey" button. */
  passkeyEnabled = false;
  /** Whether "Forgot password?" can work (the app can deliver the reset email). */
  passwordResetEnabled = true;
  /** Whether the email + password sign-up form can complete (verification email deliverable, or not required). */
  passwordSignUpEnabled = true;
  /** §5.5 aborts the background conditional-UI passkey ceremony when the user acts otherwise. */
  conditionalAbort?: AbortController;
  /** §7.5 whether the instance offers a "Remember me" checkbox at sign-in. */
  rememberMeEnabled = false;
  /** The current Remember-me choice — ticked by default (persistent session). */
  remember = true;
  /** §5.3 whether the instance offers a "Remember this device" checkbox at 2FA. */
  trustedDeviceEnabled = false;
  /** The current Remember-this-device choice — UNticked by default (opt-in). */
  rememberDevice = false;
  /**
   * §5 per-flow captcha the server asks this widget to render, keyed by flow.
   * Empty when the instance has no captcha configured. A flow with a renderable
   * provider draws its challenge and attaches the token to that flow's request.
   */
  captchaFlows: Partial<Record<CaptchaFlowKey, FlowCaptcha>> = {};
  /** Lazily-created host element the captcha widget renders into. */
  captchaHost?: HTMLElement;
  state: FlowState = initialFlow;
  /**
   * §5.4 "Forgot password" sub-flow. Null when signing in normally; set to a reset
   * flow state when the user starts a reset (email → code → new password → signed
   * in), which takes over the panel until it completes or the user goes back.
   */
  resetFlow: ResetFlowState | null = null;
  /**
   * A one-time confirmation shown above the sign-in box — e.g. after a
   * force-login password reset ("Password updated. Sign in with your new
   * password."). Cleared on the next submit.
   */
  flash: string | null = null;
  /** Set to a provider key when a handle-first provider (Bluesky) is awaiting the
   *  user's handle before the redirect; drives the handle-prompt sub-screen. */
  handlePrompt: string | null = null;
  busy = false;
  /** §bot — passive behavioural recorder started at mount (best-effort). */
  recorder?: BehaviorRecorder;

  constructor(
    readonly root: HTMLElement,
    readonly options: WidgetOptions,
  ) {
    this.mode = options.mode ?? 'sign-in';
    // Resolve the interaction config from the inline override up front so the very
    // first loading paint (before /v1/appearance resolves) already honours an
    // inline `loading` style; the tenant's server config is layered in at mount.
    this.interaction = resolveInteraction(undefined, options.appearance?.interaction);
    this.client = createClient({
      publishableKey: options.publishableKey,
      frontendApi: options.frontendApi,
      fetchImpl: options.fetchImpl,
    });
  }

  /** Boot: handle any redirect landing, fetch appearance, then render. */
  async mount(): Promise<void> {
    injectStyles(this.root.ownerDocument ?? document);
    this.root.classList.add('atlas-embed-root');
    // An inline preset/design themes the very first (loading) paint.
    this.resolveDesign(null);
    this.applyTheme();
    this.applyInteraction();
    renderLoading(this);

    // A completed sign-in (OAuth/hosted handoff) redirected back to this page:
    // exchange the one-time ticket for cookies, scrub the URL, and finish.
    const handled = await handleRedirectLanding(this);
    if (handled) return;

    const data: AppearanceResponse | null = await fetchAppearance(this.client);
    if (data) {
      this.appearance = data.appearance;
      // §6.5 keep only providers scoped to THIS screen. A provider with no
      // scope entry is unscoped (shows on both). The resolver enforces the
      // same, so a hidden provider could never have completed here anyway.
      const scopes = data.provider_scopes ?? {};
      const allowedForMode = (id: string): boolean => {
        const s = scopes[id];
        if (!s) return true;
        return this.mode === 'sign-up' ? s.sign_up : s.sign_in;
      };
      this.providers = orderedProviders(data.providers ?? [], data.appearance).filter(
        allowedForMode,
      );
      this.nativeProviders = (data.native_providers ?? []).filter((n) => allowedForMode(n.provider));
      // Whether to show the password field on the identifier screen (single-screen
      // sign-in). Default true when we can't tell — password is the common case.
      this.passwordEnabled = data.strategies?.password ?? true;
      this.passkeyEnabled = data.strategies?.passkey ?? false;
      // An app that cannot send email can't send a reset code or a sign-up
      // verification code: hide what would only end in an error.
      this.passwordResetEnabled = data.email_delivery?.password_reset ?? true;
      this.passwordSignUpEnabled = data.email_delivery?.password_sign_up ?? true;
      this.signInWithAtlas = data.sign_in_with_atlas ?? { enabled: false };
      this.rememberMeEnabled = data.rememberMe === true;
      this.trustedDeviceEnabled = data.rememberDevice === true;
      this.captchaFlows = data.captchaFlows ?? {};
      this.resolveDesign(instanceDesignFrom(data));
      this.applyTheme();
    }
    // Social-button look: tenant server default (if any) overlaid by the inline
    // appearance override the embedding page passed.
    // A design's social layout sits over the tenant's default (inline still wins).
    this.social = resolveSocialButtons(
      this.design
        ? { ...this.appearance?.socialButtons, ...this.design.socialButtons }
        : this.appearance?.socialButtons,
      this.options.appearance?.socialButtons,
    );
    this.codeInputStyle = resolveCodeInput(
      this.appearance?.codeInput,
      this.options.appearance?.codeInput,
    );
    this.interaction = resolveInteraction(
      this.design
        ? { ...this.appearance?.interaction, ...this.design.interaction }
        : this.appearance?.interaction,
      this.options.appearance?.interaction,
    );
    this.applyInteraction();
    this.signUpFields = this.appearance?.signUpFields ?? [];
    // §bot — begin passive behavioural collection once the form is up. Never
    // throws; captures timings/counts only, no field content.
    try {
      this.recorder = new BehaviorRecorder(this.root.ownerDocument ?? document);
    } catch {
      /* telemetry is best-effort */
    }
    render(this);
    // §5.5 passkey autofill (conditional UI): once the sign-in form is up, quietly
    // arm a discoverable-credential ceremony so the browser can offer saved
    // passkeys in the email field. Best-effort and abortable — never blocks.
    void startConditionalPasskey(this);
  }

  private applyTheme(): void {
    // With a design (dashboard or inline preset/design) the tokens come from it;
    // otherwise exactly as before: tenant branding, then the inline variables.
    const tokens = this.design?.tokens ?? resolveTokens(this.appearance, this.options.appearance);
    const vars = cssVariables(tokens);
    for (const [key, value] of Object.entries(vars)) this.root.style.setProperty(key, value);
    // Derived, not a token: the primary button's label follows the primary's contrast.
    this.root.style.setProperty('--atlas-embed-color-text-on-primary', textOnPrimary(tokens.colorPrimary));
    if (this.design) {
      this.appliedDesign = applyAppearanceToDom(
        this.root.ownerDocument ?? document,
        this.root,
        this.design.render,
        this.appliedDesign,
      );
    }
  }

  /** Resolve the design layer (null when there is none). */
  private resolveDesign(instance: InstanceDesign | null): void {
    const win = this.root.ownerDocument?.defaultView ?? (typeof window !== 'undefined' ? window : null);
    let prefersDark = false;
    try {
      prefersDark = !!win?.matchMedia?.('(prefers-color-scheme: dark)').matches;
    } catch {
      /* no media queries: light */
    }
    this.design = widgetDesign(instance, this.options.appearance, {
      frontendApi: this.options.frontendApi,
      prefersDark,
    });
  }

  /**
   * Reflect the resolved interaction config onto the root as data-attributes (the
   * stylesheet keys off them) plus the motion-tempo variable. Turning animations
   * off zeroes the tempo so transitions are instant; the stylesheet's
   * prefers-reduced-motion block still forces 0s on top of this.
   */
  private applyInteraction(): void {
    const i = this.interaction;
    this.root.setAttribute('data-button-style', i.buttonStyle);
    this.root.setAttribute('data-button-effect', i.buttonEffect);
    this.root.setAttribute('data-shadow', i.shadow);
    this.root.setAttribute('data-density', i.density);
    this.root.setAttribute('data-input-style', i.inputStyle);
    const ms = i.animations ? MOTION_MS[i.motionSpeed] : 0;
    this.root.style.setProperty('--atlas-embed-motion', `${ms}ms`);
  }
}
