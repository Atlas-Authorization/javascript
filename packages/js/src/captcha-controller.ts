import { nextStep, type FieldError } from './attempt';
import { advance, startSignUp, type FapiClient, type FlowState } from './fapi';
import { toSignUpInput } from './instance-settings';
import type { AtlasCaptchaLabels } from './atlas-captcha';
import {
  flowNeedsCaptcha,
  isCaptchaError,
  isRenderableCaptcha,
  renderCaptchaWidget,
  type CaptchaWidgetHandle,
  type FlowCaptcha,
} from './captcha-widget';

/**
 * The captcha half of a prebuilt sign-in / sign-up form, without a framework.
 *
 * The Vue, Svelte, Angular, Solid and Elements bindings each hold one of these
 * per form; React's `useCaptcha` hook is the same lifecycle. It is driven by the
 * instance's settings (`captchaFlows` from `/v1/appearance`), so switching
 * captcha on in the dashboard makes the forms render it with no code change.
 *
 * Lifecycle: a visible/managed widget is drawn as soon as its slot is attached,
 * so the user can solve it while filling in the form; an invisible one is
 * executed only when the form is submitted ({@link CaptchaController.getToken}).
 * Tokens are single-use, so after a submit spent one the caller
 * {@link CaptchaController.reset}s, which draws a fresh widget.
 */
export interface CaptchaControllerOptions {
  /** The flow's captcha settings (`captchaFlows.signUp`, …). */
  flow: FlowCaptcha | null | undefined;
  /** Render at all — the caller's "this flow requires a token here" decision. */
  active: boolean;
  /** Draw the widget as soon as the slot is attached. Default: unless invisible. */
  eager?: boolean;
  /** Called with the token when an eagerly drawn widget is solved. */
  onSolved?: (token: string) => void;
}

export interface CaptchaController {
  /** Whether the current settings render a widget at all. */
  readonly needed: boolean;
  /** Replace the settings; redraws an attached widget only when they changed. */
  configure(options: CaptchaControllerOptions): void;
  /** Attach the element the widget draws into (null detaches and removes it). */
  attach(el: HTMLElement | null): void;
  /**
   * The solved token, rendering/executing the widget first if needed. Null when
   * no captcha is needed, or the provider failed (the server then refuses with
   * CAPTCHA_REQUIRED, which the caller turns into a message).
   */
  getToken(): Promise<string | null>;
  /** Drop the (spent) widget and, for an eager one, draw a fresh one. */
  reset(): void;
  /** Remove the widget for good (component teardown). */
  destroy(): void;
}

/** Settings that hold for the controller's whole life. */
export interface CaptchaControllerSettings {
  /**
   * The Atlas captcha's words in the form's language, read each time a widget
   * is drawn (so a locale switch applies to the next one). See
   * `atlasCaptchaLabels(t)`.
   */
  atlasLabels?: () => Partial<AtlasCaptchaLabels>;
}

export function createCaptchaController(
  initial?: CaptchaControllerOptions,
  settings: CaptchaControllerSettings = {},
): CaptchaController {
  let options: CaptchaControllerOptions = initial ?? { flow: undefined, active: false };
  let container: HTMLElement | null = null;
  let handle: CaptchaWidgetHandle | null = null;
  // The handle whose token a submit already took: the next getToken() draws a
  // fresh widget instead of replaying it.
  let spent: CaptchaWidgetHandle | null = null;
  // The settings the current widget was drawn with, so a redraw happens only
  // when they actually change.
  let drawnKey: string | null = null;

  const needed = () =>
    options.active && !!options.flow && isRenderableCaptcha(options.flow.provider);
  const eager = () => options.eager ?? options.flow?.widget !== 'invisible';
  const key = () => {
    const f = options.flow;
    return `${needed()}|${f?.provider ?? ''}|${f?.siteKey ?? ''}|${f?.widget ?? ''}|${eager()}`;
  };

  const remove = () => {
    handle?.remove();
    handle = null;
    drawnKey = null;
  };

  const mount = (): CaptchaWidgetHandle | null => {
    remove();
    const flow = options.flow;
    if (!needed() || !flow || !container) return null;
    const h = renderCaptchaWidget(flow, container, {
      atlas: settings.atlasLabels ? { labels: settings.atlasLabels() } : undefined,
    });
    handle = h;
    drawnKey = key();
    // Swallow here so a removed / failed widget is never an unhandled
    // rejection; getToken() reads the same promise and reports it.
    h.token.then(
      (token) => {
        if (handle === h) options.onSolved?.(token);
      },
      () => undefined,
    );
    return h;
  };

  const reset = () => {
    remove();
    if (needed() && eager()) mount();
  };

  return {
    get needed() {
      return needed();
    },
    configure(next) {
      options = next;
      if (!container) return;
      if (!needed() || !eager()) remove();
      else if (drawnKey !== key()) mount();
    },
    attach(el) {
      if (el === container) return;
      remove();
      container = el;
      if (el && needed() && eager()) mount();
    },
    async getToken() {
      if (!needed()) return null;
      let h = handle;
      if (!h || spent === h || h.stale?.()) h = mount();
      if (!h) return null;
      try {
        const token = await h.token;
        spent = h;
        return token;
      } catch {
        // The provider errored / timed out: start over with a fresh widget.
        if (handle === h) reset();
        return null;
      }
    },
    reset,
    destroy() {
      remove();
      container = null;
    },
  };
}

/**
 * Swap the server's captcha refusals (CAPTCHA_REQUIRED / CAPTCHA_FAILED, which
 * the server ties to the `captcha_token` param) for a localized, form-level
 * message — there is no `captcha_token` input to hang a field error on. `t`
 * resolves the `captcha.required` / `captcha.failed` catalog keys.
 */
export function localizeCaptchaErrors(
  errors: FieldError[],
  t: (key: string) => string,
): { errors: FieldError[]; captchaRejected: boolean } {
  let captchaRejected = false;
  const out = errors.map((error) => {
    if (!isCaptchaError(error)) return error;
    captchaRejected = true;
    return {
      code: error.code,
      message: t(error.code === 'CAPTCHA_REQUIRED' ? 'captcha.required' : 'captcha.failed'),
    };
  });
  return { errors: out, captchaRejected };
}

/**
 * The sign-in captcha settings for the flow's current step: drawn on the
 * identifier step when the instance ALWAYS requires one for sign-in (so the
 * first POST already carries the token), and on the `needs_captcha` challenge
 * step the server answers with when it withheld the attempt (always-on, or
 * risk-triggered) — where it is drawn at once (even an invisible one) and
 * solving it calls `onChallengeSolved`, which should resubmit.
 */
export function signInCaptchaOptions(
  flow: FlowCaptcha | null | undefined,
  state: FlowState,
  onChallengeSolved: () => void,
): CaptchaControllerOptions {
  const kind = state.attempt ? nextStep(state.attempt).kind : 'collect_identifier';
  const challenged = kind === 'collect_captcha';
  return {
    flow,
    active: challenged || (kind === 'collect_identifier' && flowNeedsCaptcha(flow)),
    ...(challenged ? { eager: true, onSolved: () => onChallengeSolved() } : {}),
  };
}

/**
 * {@link advance} with the sign-in captcha folded in — what a prebuilt sign-in
 * form calls on submit. On the identifier / `needs_captcha` step it adds the
 * widget's token (re-issuing the identifier POST the challenge marker withheld);
 * a token the provider rejected comes back as the same challenge, so it reports
 * CAPTCHA_FAILED and draws a fresh widget (tokens are single-use). Captcha
 * refusals are localized through `t`.
 *
 * `identifier` is the last identifier the user typed (the challenge marker
 * carries none to re-send); the returned one is what to keep for next time.
 */
export async function advanceWithCaptcha(
  client: FapiClient,
  state: FlowState,
  values: Record<string, string>,
  opts: { captcha?: CaptchaController | null; identifier?: string; t: (key: string) => string },
): Promise<{ state: FlowState; identifier: string }> {
  const { captcha, t } = opts;
  const kind = state.attempt ? nextStep(state.attempt).kind : 'collect_identifier';
  let identifier = opts.identifier ?? '';
  let input = values;
  let sentToken = false;

  if (kind === 'collect_identifier' || kind === 'collect_captcha') {
    if (values.identifier) identifier = values.identifier;
    if (captcha?.needed) {
      const token = await captcha.getToken();
      if (token) {
        input = {
          ...values,
          identifier:
            identifier || ((state.attempt as { identifier?: string | null } | null)?.identifier ?? ''),
          captcha_token: token,
        };
        sentToken = true;
      } else if (kind === 'collect_captcha') {
        // Nothing to send until the widget yields a token.
        return {
          state: {
            ...state,
            busy: false,
            errors: [{ code: 'CAPTCHA_REQUIRED', message: t('captcha.required') }],
          },
          identifier,
        };
      }
    }
  }

  let next = await advance(client, state, input);
  const rechallenged = !!next.attempt && nextStep(next.attempt).kind === 'collect_captcha';
  if (sentToken && rechallenged) {
    next = { ...next, errors: [{ code: 'CAPTCHA_FAILED', message: t('captcha.failed') }] };
  }
  next = { ...next, errors: localizeCaptchaErrors(next.errors, t).errors };
  if (sentToken && (rechallenged || next.errors.length > 0)) captcha?.reset();
  return { state: next, identifier };
}

/**
 * Create the account from a prebuilt create-account form: takes the sign-up
 * captcha's token (when one is needed), POSTs `/v1/client/sign_ups` via
 * {@link startSignUp}, localizes captcha refusals and, when the create was
 * refused, draws a fresh widget (the token was spent either way).
 */
export async function createSignUp(
  client: FapiClient,
  values: Record<string, string>,
  opts: { consent: boolean; captcha?: CaptchaController | null; t: (key: string) => string },
): Promise<FlowState> {
  const token = opts.captcha ? await opts.captcha.getToken() : null;
  let next = await startSignUp(client, toSignUpInput(values, opts.consent, token));
  next = { ...next, errors: localizeCaptchaErrors(next.errors, opts.t).errors };
  if (next.errors.length > 0 && opts.captcha?.needed) opts.captcha.reset();
  return next;
}
