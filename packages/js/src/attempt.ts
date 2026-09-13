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
  | { kind: 'done'; sessionId: string | null }
  | { kind: 'restart'; reason: 'abandoned' }
  | { kind: 'unknown'; status: string };

export interface AttemptView {
  status: string;
  supported_first_factors?: string[];
  created_session_id?: string | null;
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
}

export function fieldErrors(body: unknown): FieldError[] {
  if (!body || typeof body !== 'object') return [];
  const errors = (body as { errors?: unknown }).errors;
  if (!Array.isArray(errors)) return [];

  return errors
    .filter((error): error is FieldError => {
      return Boolean(error) && typeof (error as FieldError).message === 'string';
    })
    .map((error) => ({ code: error.code, message: error.message, param: error.param }));
}

/** Errors for one field, so a form can render them inline. */
export function errorsFor(errors: readonly FieldError[], param: string): FieldError[] {
  return errors.filter((error) => error.param === param);
}

/** Errors with no field, which belong in a form-level banner. */
export function formErrors(errors: readonly FieldError[]): FieldError[] {
  return errors.filter((error) => !error.param);
}
