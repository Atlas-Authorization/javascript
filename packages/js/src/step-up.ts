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
import type { FieldError } from './attempt';
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

/** What a STEP_UP_REQUIRED refusal asks for, read off the refusal alone. */
export interface StepUpRequirement {
  /** The action that was refused (`email_change`, `api_key_create`, …), when the server named it. */
  action: string | null;
  /** The factor strategies `stepUp()` accepts for it, e.g. `password`, `passkey`, `totp`. */
  acceptedFactors: string[];
  /** How recent the proof must be, in seconds; null when any multi-factor sign-in on the session counts. */
  maxAgeSeconds: number | null;
}

const DEFAULT_FACTORS = ['password', 'passkey', 'totp', 'backup_code', 'email_code'] as const;

/** The step-up a refusal asks for, or null when `errors` holds no STEP_UP_REQUIRED. */
export function stepUpRequirement(errors: readonly FieldError[]): StepUpRequirement | null {
  const error = errors.find((e) => e.code === 'STEP_UP_REQUIRED');
  if (!error) return null;
  const meta = error.meta ?? {};
  const factors = Array.isArray(meta.accepted_factors) ? meta.accepted_factors.filter((f): f is string => typeof f === 'string') : [];
  return {
    action: typeof meta.action === 'string' ? meta.action : null,
    acceptedFactors: factors.length ? factors : [...DEFAULT_FACTORS],
    maxAgeSeconds: typeof meta.max_age_seconds === 'number' ? meta.max_age_seconds : null,
  };
}

/** What your prompt is asked to collect. */
export interface StepUpPrompt extends StepUpRequirement {
  /** The previous credential was wrong: show this error and ask again. */
  error: FieldError | null;
  /** Email the step-up code (for the `email_code` factor). */
  sendEmailCode(): Promise<FapiResponse<unknown>>;
}

/** Thrown by {@link requireStepUp} when the prompt gives up (returns null). */
export class StepUpCancelledError extends Error {
  readonly code = 'STEP_UP_CANCELLED';
  constructor() {
    super('The re-authentication was cancelled.');
    this.name = 'StepUpCancelledError';
  }
}

export interface RequireStepUpOptions {
  client: FapiClient;
  /** Ask the person for a credential; return null to cancel. */
  prompt: (request: StepUpPrompt) => Promise<StepUpInput | null> | StepUpInput | null;
  /** The refusal that triggered this, so the prompt knows the factors and window. */
  requirement?: StepUpRequirement;
  /** Wrong credentials allowed before the last error is thrown. Default 3. */
  maxAttempts?: number;
}

/**
 * Re-authenticate for `action`: ask `prompt` for a credential, send it to
 * `POST /v1/client/me/step_up`, and resolve once the server accepts it. A wrong
 * credential asks again (up to `maxAttempts`). Throws {@link StepUpCancelledError}
 * when the prompt returns null.
 */
export async function requireStepUp(action: string, opts: RequireStepUpOptions): Promise<StepUpResult> {
  const base: StepUpRequirement = opts.requirement ?? { action, acceptedFactors: [...DEFAULT_FACTORS], maxAgeSeconds: null };
  let error: FieldError | null = null;
  for (let attempt = 0; attempt < (opts.maxAttempts ?? 3); attempt++) {
    const input = await opts.prompt({ ...base, action: base.action ?? action, error, sendEmailCode: () => sendStepUpEmailCode(opts.client) });
    if (!input) throw new StepUpCancelledError();
    const res = await stepUp(opts.client, input);
    if (res.ok && res.data) return res.data;
    error = res.errors[0] ?? { code: 'UNAUTHENTICATED', message: 'Re-authentication failed.' };
  }
  throw Object.assign(new Error(error?.message ?? 'Re-authentication failed.'), { code: error?.code, reason: error?.reason });
}

/**
 * Run `call`; if the server refuses it with STEP_UP_REQUIRED, re-authenticate
 * with {@link requireStepUp} (using the refusal's own factors and window) and
 * run it once more. Any other outcome is returned as is.
 */
export async function retryWithStepUp<T>(
  call: () => Promise<FapiResponse<T>>,
  opts: Omit<RequireStepUpOptions, 'requirement'>,
): Promise<FapiResponse<T>> {
  const first = await call();
  const requirement = first.ok ? null : stepUpRequirement(first.errors);
  if (!requirement) return first;
  await requireStepUp(requirement.action ?? 'sensitive_action', { ...opts, requirement });
  return call();
}
