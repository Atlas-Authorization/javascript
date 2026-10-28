/**
 * Check an emailed one-time code WITHOUT using it up.
 *
 * Every email-code step has a `check` endpoint beside its `attempt` endpoint:
 * the server answers whether the code is right and still live (and until when),
 * and leaves it redeemable, so a form can show "code accepted" as the user
 * types and only submit the step when they confirm. A wrong code spends one of
 * the code's attempts exactly like a submission — checking is no way around the
 * lockout — and the check endpoints share the credential-verify rate budget.
 *
 *   sign-in first factor   POST /v1/client/sign_ins/:id/check_first_factor
 *   sign-in second factor  POST /v1/client/sign_ins/:id/check_second_factor
 *   sign-up verification   POST /v1/client/sign_ups/:id/check_verification
 *   step-up                POST /v1/client/me/step_up/check
 *   add-email verification POST /v1/client/me/email_addresses/:id/check_verification
 */
import type { FapiClient, FapiResponse } from './fapi';
import { nextStep, type AttemptView } from './attempt';

/** A right, live code. */
export interface EmailCodeCheck {
  object: 'email_code_check';
  valid: true;
  /** When the code stops working (ISO 8601). */
  expires_at: string;
  /** Wrong entries left before the code is locked. */
  attempts_remaining: number;
}

/** Where the code being checked belongs. */
export type EmailCodeTarget =
  | { kind: 'sign_in_first_factor'; attemptId: string }
  | { kind: 'sign_in_second_factor'; attemptId: string }
  | { kind: 'sign_up_verification'; attemptId: string }
  | { kind: 'step_up' }
  | { kind: 'email_address'; emailAddressId: string };

/** The check endpoint and body for a target. */
export function emailCodeCheckRequest(target: EmailCodeTarget, code: string): { path: string; body: Record<string, unknown> } {
  const id = (v: string) => encodeURIComponent(v);
  switch (target.kind) {
    case 'sign_in_first_factor':
      return { path: `/v1/client/sign_ins/${id(target.attemptId)}/check_first_factor`, body: { strategy: 'email_code', code } };
    case 'sign_in_second_factor':
      return { path: `/v1/client/sign_ins/${id(target.attemptId)}/check_second_factor`, body: { strategy: 'email_code', code } };
    case 'sign_up_verification':
      return { path: `/v1/client/sign_ups/${id(target.attemptId)}/check_verification`, body: { strategy: 'email_code', code } };
    case 'step_up':
      return { path: '/v1/client/me/step_up/check', body: { strategy: 'email_code', code } };
    case 'email_address':
      return { path: `/v1/client/me/email_addresses/${id(target.emailAddressId)}/check_verification`, body: { code } };
  }
}

/**
 * Check a code. `ok` with `data` for a right, live code; otherwise the server's
 * errors — `VERIFICATION_FAILED` (wrong, expired or unknown) or
 * `TOO_MANY_ATTEMPTS` (the code is locked; request a new one).
 */
export function checkEmailCode(client: FapiClient, target: EmailCodeTarget, code: string): Promise<FapiResponse<EmailCodeCheck>> {
  const { path, body } = emailCodeCheckRequest(target, code);
  return client.post<EmailCodeCheck>(path, body);
}

/**
 * The check target for the code step a flow is on, or null when the current
 * step takes no emailed code. An emailed code on the first-factor step, the
 * email second factor, and sign-up verification are covered.
 */
export function emailCodeTargetForAttempt(attempt: AttemptView | null | undefined): EmailCodeTarget | null {
  if (!attempt?.id) return null;
  switch (nextStep(attempt).kind) {
    case 'collect_first_factor':
      return { kind: 'sign_in_first_factor', attemptId: attempt.id };
    case 'collect_second_factor':
      return { kind: 'sign_in_second_factor', attemptId: attempt.id };
    case 'collect_email_code':
      return { kind: 'sign_up_verification', attemptId: attempt.id };
    default:
      return null;
  }
}
