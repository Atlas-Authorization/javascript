/**
 * Passkey-only sign-up: an account whose only credential is a passkey.
 *
 * The server binds the passkey to the sign-up ATTEMPT and creates the account
 * only when the registration ceremony verifies, so a user who walks away midway
 * leaves nothing behind. The flow:
 *
 *   1. {@link startPasskeySignUp} — POST /v1/client/sign_ups/passkey with the
 *      email (when the instance collects one), username and sign-up fields. The
 *      attempt comes back with a `poll_secret` this tab keeps.
 *   2. When the instance requires a verified email the attempt is
 *      `needs_email_verification`: the usual code step (`advance` posts it to
 *      `attempt_verification`) or, in link mode, polling (`pollAttempt`).
 *   3. Once {@link awaitingPasskey} is true, {@link registerSignUpPasskey} runs
 *      begin → navigator.credentials.create → finish and returns the completed
 *      flow with its one-time ticket for POST /v1/client/tickets/exchange.
 */
import { initialFlow, type FapiClient, type FlowState } from './fapi';
import type { AttemptView } from './attempt';
import type { PolicyAcceptance } from './policies';
import { createPasskey, type PasskeyExtensionOptions, type WebAuthnHost } from './passkey';

export interface PasskeySignUpInput {
  /** Collected when the instance's `account.passkeySignUp.email` is not `off`. */
  email?: string;
  /** The username to claim, when the instance offers usernames. */
  username?: string;
  /** The instance's configured sign-up fields. */
  fields?: Record<string, string>;
  /** The legal-consent tick (required only when the instance opts in). */
  consent?: boolean;
  /** The sign-up captcha token, when the instance requires one. */
  captchaToken?: string;
  /** The instance's policies the user accepted (`PolicyAcceptanceController.build()`). */
  policyAcceptances?: PolicyAcceptance[];
}

/** Start a passkey-only sign-up. No account exists until the passkey is registered. */
export async function startPasskeySignUp(client: FapiClient, input: PasskeySignUpInput): Promise<FlowState> {
  const hasFields = input.fields && Object.keys(input.fields).length > 0;
  const response = await client.post<AttemptView & { ticket?: string; poll_secret?: string }>('/v1/client/sign_ups/passkey', {
    ...(input.email ? { email: input.email } : {}),
    ...(input.username ? { username: input.username } : {}),
    ...(hasFields ? { fields: input.fields } : {}),
    ...(input.consent ? { consent: true } : {}),
    ...(input.captchaToken ? { captcha_token: input.captchaToken } : {}),
    ...(input.policyAcceptances && input.policyAcceptances.length > 0 ? { policy_acceptances: input.policyAcceptances } : {}),
  });
  if (!response.ok || !response.data) return { ...initialFlow, errors: response.errors };
  return {
    ...initialFlow,
    attempt: response.data,
    // Kept in memory only: the passkey steps (and link-mode polling) need it.
    pollSecret: response.data.poll_secret ?? null,
  };
}

/** True when a passkey-only sign-up is waiting for its passkey to be created. */
export function awaitingPasskey(attempt: AttemptView | null | undefined): boolean {
  return (
    !!attempt &&
    attempt.object === 'sign_up_attempt' &&
    attempt.status === 'needs_first_factor' &&
    (attempt.supported_first_factors ?? []).includes('passkey')
  );
}

/**
 * Create the passkey and, with it, the account: begin → the browser ceremony →
 * finish. Returns the flow completed (with its `ticket`), or the server's
 * errors with the attempt kept so the user can try again. A cancelled browser
 * prompt comes back as a `PASSKEY_CANCELLED` error, not a throw.
 */
export async function registerSignUpPasskey(
  client: FapiClient,
  state: FlowState,
  opts: { name?: string; host?: WebAuthnHost } & PasskeyExtensionOptions = {},
): Promise<FlowState> {
  const id = state.attempt?.id;
  if (!id || !state.pollSecret) {
    return { ...state, busy: false, errors: [{ code: 'INVALID_STATE', message: 'This sign-up cannot create a passkey.' }] };
  }
  const begin = await client.post<Record<string, unknown>>(`/v1/client/sign_ups/${id}/passkey/begin`, {
    poll_secret: state.pollSecret,
  });
  if (!begin.ok || !begin.data) return { ...state, busy: false, errors: begin.errors };

  let body;
  try {
    body = await createPasskey(begin.data, {
      host: opts.host,
      ...(opts.name ? { name: opts.name } : {}),
      // PRF (client-side keys): the salts go to the authenticator, the outputs to the app only.
      ...(opts.prf ? { prf: opts.prf } : {}),
      ...(opts.onExtensionResults ? { onExtensionResults: opts.onExtensionResults } : {}),
    });
  } catch (error) {
    return {
      ...state,
      busy: false,
      errors: [
        {
          code: 'PASSKEY_CANCELLED',
          // The browser's own text varies by vendor; a prebuilt form shows its catalog's.
          message: error instanceof Error && error.message ? error.message : 'The passkey was not created.',
        },
      ],
    };
  }

  const finish = await client.post<AttemptView & { ticket?: string }>(`/v1/client/sign_ups/${id}/passkey/finish`, {
    poll_secret: state.pollSecret,
    ...body,
  });
  if (!finish.ok || !finish.data) return { ...state, busy: false, errors: finish.errors };
  return {
    ...state,
    attempt: finish.data,
    errors: [],
    busy: false,
    ticket: finish.data.ticket ?? null,
  };
}
