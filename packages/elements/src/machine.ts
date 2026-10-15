/**
 * @atlasauth/elements — the PURE, framework-free core.
 *
 * `@atlasauth/elements` is the Atlas peer of `@clerk/elements`: headless,
 * unstyled, composable React primitives that let a team build a fully custom
 * sign-in / sign-up UI on top of the Atlas attempt flow. The React components in
 * the sibling files are deliberately thin — every decision that could be *wrong*
 * (which step is current, which field an error belongs to, which attempt method
 * an `<Action>` fires) is made here, as a plain function with no React and no
 * DOM, so it can be unit-tested exactly the way `@atlasauth/react` tests its own
 * flow helpers (see `packages/react/src/flow.test.ts`).
 *
 * The one rule this package inherits from `@atlasauth/js` (see `attempt.ts`):
 * the CLIENT NEVER PICKS THE STEP. The server returns a `status`; we render
 * whatever step that status maps to. Adding a step is therefore a server change,
 * and a client that is one version behind degrades to an honest `error` step
 * rather than a blank screen — the `nextStep` mapping already guarantees this and
 * we layer the Clerk-Elements step *names* on top of it here.
 */

import {
  nextStep,
  errorsFor,
  offeredFirstFactors,
  type AttemptView,
  type EmailDelivery,
  type FieldError,
} from '@atlasauth/js';

/** Which flow a primitive belongs to. */
export type FlowMode = 'sign-in' | 'sign-up';

/**
 * The Clerk-Elements step vocabulary, as Atlas resolves it. Every value is the
 * image of exactly one `nextStep(...).kind` (plus `start` for the pre-attempt
 * identifier entry), so a `<SignIn.Step name=...>` maps 1:1 onto a server status.
 *
 * - `start` — the first screen: collect the identifier (and social / passkey
 *   strategies live here). Also the home for a captcha challenge, which gates the
 *   identifier POST rather than being a screen of its own.
 * - `first-factor` — a password or emailed-code first factor.
 * - `second-factor` — a 2FA code for a user who already has a factor.
 * - `mfa-enrollment` — the user must enrol a second factor before continuing.
 * - `verifications` — an emailed verification code (the usual sign-up step).
 * - `reset-password` — choose a new password (the forgot-password tail).
 * - `sso-callback` — an OAuth/magic-link hand-off is in flight.
 * - `complete` — the attempt finished; a session ticket is in hand.
 * - `error` — a status this SDK version does not understand, or an abandoned
 *   attempt. Rendered as something the user can act on, never as a blank box.
 */
export type StepName =
  | 'start'
  | 'first-factor'
  | 'second-factor'
  | 'mfa-enrollment'
  | 'verifications'
  | 'reset-password'
  | 'sso-callback'
  | 'complete'
  | 'error';

/**
 * The canonical step for an attempt — the single place the Clerk-Elements step
 * name is derived from the server `status`. A `null` attempt is the pre-flight
 * identifier screen (`start`). Everything else is routed through the exhaustive
 * `nextStep` mapping in `@atlasauth/js`, so an unknown/abandoned status lands on
 * `error` rather than silently matching nothing.
 */
export function stepForAttempt(attempt: AttemptView | null): StepName {
  if (!attempt) return 'start';

  const step = nextStep(attempt);
  switch (step.kind) {
    case 'collect_identifier':
    case 'collect_captcha':
      return 'start';
    case 'collect_first_factor':
      return 'first-factor';
    case 'collect_second_factor':
      return 'second-factor';
    case 'enroll_second_factor':
      return 'mfa-enrollment';
    case 'collect_email_code':
      return 'verifications';
    case 'collect_new_password':
      return 'reset-password';
    case 'await_oauth':
      return 'sso-callback';
    case 'done':
      return 'complete';
    case 'restart':
    case 'unknown':
      return 'error';
    default:
      // `nextStep` is exhaustive; this keeps us honest if a kind is ever added.
      return 'error';
  }
}

/**
 * Whether a `<Step name>` should render for the current attempt. The whole
 * contract of the headless flow: a Step renders only when its name is the one the
 * server's status resolves to — so exactly one Step is ever live at a time.
 */
export function stepMatches(attempt: AttemptView | null, name: StepName): boolean {
  return stepForAttempt(attempt) === name;
}

/**
 * The single field error for a field, or `null`. `<Field.Error>` reads this so a
 * message sits next to the input it belongs to (by the server's `param`), instead
 * of being dumped in a form-level banner. Mirrors `@atlasauth/js`'s `errorsFor`.
 */
export function fieldError(errors: readonly FieldError[], name: string): FieldError | null {
  return errorsFor(errors, name)[0] ?? null;
}

/**
 * Whether a given sign-in *strategy* is offered for the current attempt, so a
 * `<SignIn.Strategy name>` renders only when that strategy applies:
 *
 * - On the `start` screen (identifier entry, incl. a captcha gate) the social /
 *   OIDC strategies (`oauth_<provider>`) and `passkey` are offered — these begin
 *   their own ceremony from the first screen, not from the server's factor list.
 * - On a `first-factor` step the offered strategies are EXACTLY the server's
 *   `supported_first_factors` (e.g. `password`, `email_code`, `passkey`) — never
 *   a client-side guess, because §13.2 keeps that list uniform for unknown
 *   identifiers and filtering it would reintroduce the enumeration leak.
 *
 * - The email-delivery facts (`instanceSettings.emailDelivery`, pass them as
 *   `delivery`) narrow that by what the APP can do, never by the identifier:
 *   `email_code` / `email_link` are not offered while email can't be delivered
 *   (`available === false`), and the `reset_password` pseudo-strategy — wrap
 *   your "Forgot password?" link in `<SignIn.Strategy name="reset_password">` —
 *   is offered on a first-factor step that lists `password` only while reset
 *   emails can be delivered (`passwordReset !== false`).
 *
 * Any other step offers no strategy picker.
 */
export function strategyAvailable(
  attempt: AttemptView | null,
  strategy: string,
  delivery?: EmailDelivery | null,
): boolean {
  const step = attempt ? nextStep(attempt) : ({ kind: 'collect_identifier' } as const);

  if (step.kind === 'collect_identifier' || step.kind === 'collect_captcha') {
    return strategy.startsWith('oauth_') || strategy === 'passkey';
  }
  if (step.kind === 'collect_first_factor') {
    if (strategy === RESET_PASSWORD_STRATEGY) {
      return step.strategies.includes('password') && delivery?.passwordReset !== false;
    }
    return offeredFirstFactors(step.strategies, delivery).includes(strategy);
  }
  return false;
}

/** The pseudo-strategy that gates a "Forgot password?" control (see {@link strategyAvailable}). */
export const RESET_PASSWORD_STRATEGY = 'reset_password';

/**
 * Whether email + password sign-up cannot complete because the app can't
 * deliver the verification email — what `<SignUp.EmailUnavailable>` shows for.
 * False until the settings have loaded, and on an older server that does not say.
 */
export function signUpEmailUnavailable(delivery: EmailDelivery | null | undefined): boolean {
  return delivery?.passwordSignUp === false;
}

/** The provider key an `oauth_<provider>` strategy name points at, or `null`. */
export function oauthProviderOf(strategy: string): string | null {
  return strategy.startsWith('oauth_') ? strategy.slice('oauth_'.length) : null;
}

/** What a `<SignIn.Action>` / `<SignUp.Action>` does. */
export type ActionName = 'submit' | 'resend' | 'navigate';

/**
 * The imperative surface an `<Action>` drives. Kept as an interface (rather than
 * reaching into the React context directly) so {@link runAction} — the "which
 * attempt method does this action fire?" decision — is a pure function unit tests
 * can exercise with a plain mock, the way the flow helpers are tested in
 * `@atlasauth/react`.
 */
export interface FlowActions {
  /** Advance the attempt with the currently-collected field values. */
  submit(): void | Promise<void>;
  /** Re-send the current step's code / link (e.g. an emailed verification code). */
  resend(): void | Promise<void>;
  /** Client-side navigation to another route (e.g. the forgot-password page). */
  navigate(to: string): void;
}

/**
 * Fire the attempt method an `<Action name>` names. The one place the action →
 * method mapping lives, so a component can never wire `resend` to `submit`.
 * `navigate` is a no-op without a target (nothing to navigate to).
 */
export function runAction(actions: FlowActions, name: ActionName, navigateTo?: string): void {
  switch (name) {
    case 'submit':
      void actions.submit();
      return;
    case 'resend':
      void actions.resend();
      return;
    case 'navigate':
      if (navigateTo) actions.navigate(navigateTo);
      return;
  }
}

/** The props a bound `<Field.Input>` applies to its DOM `<input>`. */
export interface FieldBinding {
  name: string;
  value: string;
  error: FieldError | null;
  onChange(next: string): void;
}

/**
 * Bind a field name to the flow's collected values + errors. Pure: it reads the
 * current value (defaulting to `''` so the input is always controlled), finds the
 * field's error, and returns an `onChange` that writes straight back through
 * `setValue`. `<Field.Input>` spreads the result onto a bare `<input>`.
 */
export function bindField(
  name: string,
  values: Record<string, string>,
  setValue: (name: string, value: string) => void,
  errors: readonly FieldError[],
): FieldBinding {
  return {
    name,
    value: values[name] ?? '',
    error: fieldError(errors, name),
    onChange: (next: string) => setValue(name, next),
  };
}
