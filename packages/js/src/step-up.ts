/**
 * Step-up: re-authenticate the signed-in user in place, without a new session.
 *
 * A sensitive action ("re-authenticated within 5 minutes") reads `auth_time`
 * on the session token: {@link authenticatedWithin} answers it. When it is too
 * old, prove a credential again with {@link stepUp}; the response carries a
 * fresh session token whose `auth_time` is now, `amr` names the method and
 * `acr` is `urn:atlas:acr:step_up`. The refresh token is not rotated.
 *
 *   password      POST /v1/client/me/step_up { strategy: 'password', password }
 *   totp          POST /v1/client/me/step_up { strategy: 'totp', code }
 *   backup_code   POST /v1/client/me/step_up { strategy: 'backup_code', code }
 *   email_code    POST /v1/client/me/step_up/email_code, then { strategy: 'email_code', code }
 *   passkey       POST /v1/client/me/step_up/passkey (challenge), then the assertion
 */
import type { FapiClient, FapiResponse } from './fapi';

export type StepUpInput =
  | { strategy: 'password'; password: string }
  | { strategy: 'totp' | 'backup_code' | 'email_code'; code: string }
  | {
      strategy: 'passkey';
      challenge: string;
      credential_id: string;
      authenticator_data: string;
      client_data_json: string;
      signature: string;
    };

export interface StepUpResult {
  object: 'client';
  stepped_up: true;
  /** Seconds since the epoch: the step-up just performed. */
  auth_time: number;
  amr: string[];
  acr: string;
  /** The re-minted session token carrying the fresh auth_time/amr/acr. */
  jwt: string;
  expires_in_seconds: number;
}

/** Prove a credential of the current session again. A wrong credential is a 401. */
export function stepUp(client: FapiClient, input: StepUpInput): Promise<FapiResponse<StepUpResult>> {
  return client.post<StepUpResult>('/v1/client/me/step_up', input);
}

/** Email a one-time step-up code to the user's primary address (then `stepUp({ strategy: 'email_code', code })`). */
export function sendStepUpEmailCode(client: FapiClient): Promise<FapiResponse<unknown>> {
  return client.post('/v1/client/me/step_up/email_code', {});
}

/**
 * Whether the token's `auth_time` (first-factor sign-in or the last step-up)
 * is within `maxAgeSeconds` of now. A token without `auth_time` never is.
 */
export function authenticatedWithin(claims: { auth_time?: unknown }, maxAgeSeconds: number, nowMs: number = Date.now()): boolean {
  const at = claims.auth_time;
  if (typeof at !== 'number' || !Number.isFinite(at)) return false;
  return nowMs / 1000 - at <= maxAgeSeconds;
}
