/**
 * §5: "the client reads `status` and renders whatever the server demands next;
 * it never picks the step itself."
 *
 * This is the client half of that contract, and it is written as an exhaustive
 * mapping rather than a chain of ifs on purpose. An `if (status === ...)` ladder
 * silently falls through when the server introduces a status the client has not
 * seen — and "falls through" in a sign-in flow means a blank screen with no
 * error, which is the single worst failure mode a login box has.
 *
 * Here an unknown status maps to an explicit `unknown` step that a UI can render
 * as "this needs an update", which is honest and actionable.
 */

export type AttemptStatus =
  | 'needs_identifier'
  | 'needs_first_factor'
  | 'needs_second_factor'
  /** §11.1 MFA policy `required`, for a user who has no second factor yet. */
  | 'needs_mfa_enrollment'
  | 'needs_email_verification'
  | 'needs_oauth_callback'
  | 'needs_new_password'
  /** §5 the server is asking the identifier step to clear a captcha challenge. */
  | 'needs_captcha'
  /**
   * Every factor passed, but the user must accept the current version of one
   * or more policies (`pending_policies`) before a session is issued. Accept
   * with `acceptAttemptPolicies` (POST /v1/client/sign_ins/:id/accept_policies).
   */
  | 'needs_policy_acceptance'
  /**
   * Every factor passed, but the user owes a required action
   * (`pending_required_actions`: a new password, profile fields, a verified
   * address, an application step). Finish one with `completeRequiredAction`
   * (POST /v1/client/sign_ins/:id/required_actions).
   */
  | 'needs_required_action'
  | 'complete'
  | 'abandoned';

export type Step =
  | { kind: 'collect_identifier' }
  | { kind: 'collect_first_factor'; strategies: string[] }
  | { kind: 'collect_second_factor' }
  | { kind: 'enroll_second_factor' }
  | { kind: 'collect_email_code' }
  | { kind: 'collect_captcha' }
  | { kind: 'await_oauth' }
  | { kind: 'collect_new_password' }
  /** Show `policies` (GET /v1/client/policies has their content) and submit acceptances. */
  | { kind: 'accept_policies'; policies: PendingPolicy[] }
  /** Collect what `actions[0]` needs (a password, name fields, an emailed code) or send the user to its `url`. */
  | { kind: 'complete_required_action'; actions: PendingRequiredAction[] }
  | { kind: 'done'; sessionId: string | null }
  | { kind: 'restart'; reason: 'abandoned' }
  | { kind: 'unknown'; status: string };

/** One action an attempt waits on (`pending_required_actions`). */
export interface PendingRequiredAction {
  id: string;
  /** `update_password`, `verify_email`, `update_profile`, `complete_profile` or `journey_form` (see `fields`), `identity_verification` (see `AttemptView.identity_verification`), or `custom` (see `url`). */
  action: string;
  /** `custom` only: where to send the user; the application closes the action. */
  url: string | null;
  reason: string | null;
  /** `complete_profile` (progressive profiling) and `journey_form`: the fields asked for. */
  fields?: ProfileCompletionField[];
  /** `journey_form` (a server-driven step of the sign-in journey): its heading and introduction. */
  title?: string | null;
  intro?: string | null;
}

/** One field of progressive profiling (`pending_required_actions[].fields`, `getProfileCompletion`). */
export interface ProfileCompletionField {
  key: string;
  label: string;
  type: string;
  required: boolean;
  placeholder: string | null;
  options: string[];
}

/** One policy an attempt waits on (`pending_policies`). */
export interface PendingPolicy {
  /** The policy key (`tos`, `privacy`, …). */
  policy: string;
  policy_id: string;
  title: string;
  display: 'checkbox' | 'scroll' | 'link' | (string & {});
  version_id: string;
  version: string;
  /** SHA-256 of the sanitised HTML to show; send it back in the acceptance. */
  content_sha256: string;
  /** The user accepted an earlier version: show `summary_of_changes`. */
  reaccept: boolean;
  summary_of_changes: string | null;
}

/** The identity check an `identity_verification` required action started (`step: 'start'`) or read. */
export interface AttemptIdentityVerification {
  status: 'pending' | 'approved' | 'declined' | 'needs_review';
  /** The verification service's hosted page, while pending. */
  url: string | null;
  reason: string | null;
}

export interface AttemptView {
  /**
   * The attempt id — what the next submit targets and what a completion's ticket
   * exchange is keyed on, so consumers read `attempt.id` directly rather than
   * casting it on. It is a string on every real attempt; it is `null` ONLY on the
   * pre-attempt captcha challenge marker (§15.4), where no attempt row exists yet
   * (the server's `SignInChallengeView`). Typed `string | null` for that one case
   * rather than pretending it is always present.
   */
  id: string | null;
  /** The resource type the server stamps on every attempt view. */
  object?: 'sign_in_attempt' | 'sign_up_attempt';
  status: string;
  /** The identifier the attempt was started with; `null` before one is collected. */
  identifier?: string | null;
  supported_first_factors?: string[];
  /** `passkey` on a passkey-only sign-up (see `awaitingPasskey`). */
  strategy?: string;
  created_session_id?: string | null;
  /** Attempt expiry (epoch ms); `null` on the pre-attempt challenge marker. */
  expires_at?: number | null;
  /** While `needs_policy_acceptance`: what to accept. */
  pending_policies?: PendingPolicy[];
  /** While held on the `identity_verification` required action: the check started or read by the last submit. */
  identity_verification?: AttemptIdentityVerification;
  /**
   * While `needs_policy_acceptance`, on the response that put it there only:
   * the one-time token to send with the acceptances.
   */
  policy_acceptance_token?: string;
  /** While `needs_required_action`: what the user owes. */
  pending_required_actions?: PendingRequiredAction[];
  /**
   * While `needs_required_action`, on the response that put it there only:
   * the one-time token to send with the action.
   */
  required_action_token?: string;
}

export function nextStep(attempt: AttemptView): Step {
  switch (attempt.status as AttemptStatus) {
    case 'needs_identifier':
      return { kind: 'collect_identifier' };

    case 'needs_first_factor':
      return {
        kind: 'collect_first_factor',
        // The server's list, never a client-side guess. §13.2 makes this list
        // identical for unknown identifiers, so a client that filtered it by
        // "what this user probably has" would reintroduce the enumeration leak
        // the uniform response exists to close.
        strategies: attempt.supported_first_factors ?? [],
      };

    case 'needs_second_factor':
      return { kind: 'collect_second_factor' };

    /**
     * Distinct from `collect_second_factor`, and the difference matters: this
     * user has NO factor to be asked for. Rendering a "enter your code" box
     * here would ask for something that does not exist, and the person would
     * have no way past it.
     */
    case 'needs_mfa_enrollment':
      return { kind: 'enroll_second_factor' };

    case 'needs_email_verification':
      return { kind: 'collect_email_code' };

    case 'needs_captcha':
      return { kind: 'collect_captcha' };

    case 'needs_oauth_callback':
      return { kind: 'await_oauth' };

    case 'needs_new_password':
      return { kind: 'collect_new_password' };

    case 'needs_policy_acceptance':
      return { kind: 'accept_policies', policies: attempt.pending_policies ?? [] };

    case 'needs_required_action':
      return { kind: 'complete_required_action', actions: attempt.pending_required_actions ?? [] };

    case 'complete':
      return { kind: 'done', sessionId: attempt.created_session_id ?? null };

    case 'abandoned':
      return { kind: 'restart', reason: 'abandoned' };

    default:
      /**
       * A status this SDK version does not know. Rendering nothing would be a
       * blank login box with no error; saying so lets the app show something a
       * user can act on.
       */
      return { kind: 'unknown', status: attempt.status };
  }
}

/** Whether the flow can still progress, for deciding whether to keep polling. */
export function isTerminal(attempt: AttemptView): boolean {
  return attempt.status === 'complete' || attempt.status === 'abandoned';
}

/**
 * §9.1 error envelope, reduced to what a form needs.
 *
 * The API writes messages for humans, so they are surfaced verbatim. The `param`
 * is what lets a form attach the message to the right field instead of dumping
 * everything in a banner at the top, which is how "password too short" ends up
 * appearing next to the email input.
 */
export interface FieldError {
  code: string;
  message: string;
  param?: string;
  /**
   * The server's stable, machine-readable reason for this error
   * (`form_password_incorrect`, `too_many_attempts`, …), finer-grained than
   * `code`. Prebuilt UIs look it up as the catalog key `error.<reason>` to show
   * the message in the app's language; see `localizedErrorMessage`. Absent on
   * servers that predate it and on errors raised client-side.
   */
  reason?: string;
  /**
   * Extra machine-readable detail the server attached (`min_length`,
   * `providers`, …); also the interpolation values for `error.<reason>`.
   */
  meta?: Record<string, unknown>;
}

export function fieldErrors(body: unknown): FieldError[] {
  if (!body || typeof body !== 'object') return [];
  const errors = (body as { errors?: unknown }).errors;
  if (!Array.isArray(errors)) return [];

  return errors
    .filter((error): error is FieldError => {
      return Boolean(error) && typeof (error as FieldError).message === 'string';
    })
    .map((error) => {
      const out: FieldError = { code: error.code, message: error.message, param: error.param };
      const reason = (error as { reason?: unknown }).reason;
      if (typeof reason === 'string' && reason !== '') out.reason = reason;
      const meta = (error as { meta?: unknown }).meta;
      if (meta && typeof meta === 'object' && !Array.isArray(meta)) out.meta = meta as Record<string, unknown>;
      return out;
    });
}

/** Errors for one field, so a form can render them inline. */
export function errorsFor(errors: readonly FieldError[], param: string): FieldError[] {
  return errors.filter((error) => error.param === param);
}

/** Errors with no field, which belong in a form-level banner. */
export function formErrors(errors: readonly FieldError[]): FieldError[] {
  return errors.filter((error) => !error.param);
}
