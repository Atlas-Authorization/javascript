/**
 * §5.4 Password reset ("forgot password").
 *
 * A standalone flow, separate from sign-in: the user proves control of their
 * inbox with an emailed code, clears any second factor (a reset must NOT bypass
 * MFA), then sets a new password and ends up signed in. It drives the
 * `/v1/client/password_resets/*` endpoints, which mirror the sign-in steps but on
 * their own attempt, so it cannot be expressed through the sign-in `advance`.
 *
 * Statuses, in order: `needs_email_verification` → (`needs_second_factor`) →
 * `needs_new_password` → `complete` (carrying a session ticket, so a completed
 * reset signs the user in through the normal cookie exchange).
 */
import type { FieldError } from './attempt';
import type { FapiClient } from './fapi';

export interface ResetAttempt {
  id: string;
  status: string;
}

export interface ResetFlowState {
  attempt: ResetAttempt | null;
  errors: FieldError[];
  busy: boolean;
  /** Present once the reset completes — exchange it for session cookies. */
  ticket: string | null;
}

export const initialResetFlow: ResetFlowState = {
  attempt: null,
  errors: [],
  busy: false,
  ticket: null,
};

/** Begin a reset: email the code. Returns a flow parked at `needs_email_verification`. */
export async function startPasswordReset(
  client: FapiClient,
  email: string,
  captchaToken?: string,
): Promise<ResetFlowState> {
  const res = await client.post<ResetAttempt>('/v1/client/password_resets', {
    email_address: email,
    captcha_token: captchaToken,
  });
  if (!res.ok || !res.data) return { ...initialResetFlow, errors: res.errors };
  return { attempt: res.data, errors: [], busy: false, ticket: null };
}

/**
 * Advance the reset by one step, routing on the current status: the emailed code
 * → verification, a 2FA code → second factor, a new password → set-password. On
 * completion the returned state carries a ticket to exchange for cookies.
 */
export async function advancePasswordReset(
  client: FapiClient,
  state: ResetFlowState,
  values: { code?: string; password?: string },
): Promise<ResetFlowState> {
  const attempt = state.attempt;
  if (!attempt) return state;

  let path: string | null = null;
  let body: Record<string, unknown> = {};
  switch (attempt.status) {
    case 'needs_email_verification':
      path = `/v1/client/password_resets/${attempt.id}/attempt_verification`;
      body = { code: values.code ?? '' };
      break;
    case 'needs_second_factor':
      path = `/v1/client/password_resets/${attempt.id}/attempt_second_factor`;
      body = { code: values.code ?? '' };
      break;
    case 'needs_new_password':
      path = `/v1/client/password_resets/${attempt.id}/set_new_password`;
      body = { password: values.password ?? '' };
      break;
    default:
      return state;
  }

  const res = await client.post<ResetAttempt & { ticket?: string }>(path, body);
  if (!res.ok || !res.data) {
    // Keep the attempt on failure (a wrong code must not drop the whole flow),
    // exactly like the sign-in advance.
    return { ...state, busy: false, errors: res.errors };
  }
  return {
    attempt: { id: res.data.id, status: res.data.status },
    errors: [],
    busy: false,
    ticket: res.data.ticket ?? null,
  };
}

/** The step a reset flow is on — what the UI should collect next. */
export type ResetStep =
  | 'request'
  | 'collect_email_code'
  | 'collect_second_factor'
  | 'collect_new_password'
  | 'done'
  | 'unknown';

export function resetStep(state: ResetFlowState): ResetStep {
  const status = state.attempt?.status;
  if (!status) return 'request';
  switch (status) {
    case 'needs_email_verification':
      return 'collect_email_code';
    case 'needs_second_factor':
      return 'collect_second_factor';
    case 'needs_new_password':
      return 'collect_new_password';
    case 'complete':
      return 'done';
    default:
      return 'unknown';
  }
}
