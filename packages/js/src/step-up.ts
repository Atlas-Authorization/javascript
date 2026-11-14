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
 *   phone_code    POST /v1/client/me/step_up/phone_code, then { strategy: 'phone_code', code }
 *   passkey       POST /v1/client/me/step_up/passkey (challenge), then the assertion
 *   push          POST /v1/client/me/step_up/push (number to show), then { strategy: 'push' } until the device answers
 *   duo           POST /v1/client/me/step_up/duo (address to send the user to), then { strategy: 'duo' }
 *   yubikey       POST /v1/client/me/step_up { strategy: 'yubikey', code } (a Yubico OTP)
 *
 * With `policy`, the server takes only the methods that named step-up policy accepts, and `withStepUp(policy, fn)`
 * does the whole retry for you.
 */
import type { FieldError } from './attempt';
import type { FapiClient, FapiResponse } from './fapi';

export type StepUpInput = (
  | { strategy: 'password'; password: string }
  | { strategy: 'totp' | 'backup_code' | 'email_code' | 'phone_code' | 'yubikey'; code: string }
  | { strategy: 'push' | 'duo' }
  | {
      strategy: 'passkey';
      challenge: string;
      credential_id: string;
      authenticator_data: string;
      client_data_json: string;
      signature: string;
    }
) & {
  /** The named step-up policy this re-authentication is for. */
  policy?: string;
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

/** The challenge a push step-up starts: show `number_match` on this screen; the user taps it on their device. */
export interface StepUpPushChallenge {
  object: 'step_up_challenge';
  strategy: 'push';
  challenge_id: string;
  number_match: string;
  expires_at: number;
}

/** Send the signed-in session a push step-up prompt (429 LOCKED while the user's prompts are paused after denials). Then `stepUp(client, { strategy: 'push' })` until it answers. */
export function startStepUpPush(client: FapiClient): Promise<FapiResponse<StepUpPushChallenge>> {
  return client.post<StepUpPushChallenge>('/v1/client/me/step_up/push', {});
}

/** Start a Duo step-up: send the browser to `authorization_url`, which returns to `returnUrl` (one of the app's origins). Then `stepUp(client, { strategy: 'duo' })`. */
export function startStepUpDuo(client: FapiClient, returnUrl?: string): Promise<FapiResponse<{ object: 'step_up_challenge'; strategy: 'duo'; authorization_url: string }>> {
  return client.post('/v1/client/me/step_up/duo', returnUrl ? { return_url: returnUrl } : {});
}

/** What a named step-up policy asks of the user, for building the prompt before the refusal. */
export interface StepUpPolicyRequirement {
  object: 'step_up_policy_requirement';
  name: string;
  description: string | null;
  max_age_seconds: number;
  phishing_resistant: boolean;
  accepted_factors: string[];
}

export function getStepUpPolicy(client: FapiClient, name: string): Promise<FapiResponse<StepUpPolicyRequirement>> {
  return client.get<StepUpPolicyRequirement>(`/v1/client/me/step_up/policies/${encodeURIComponent(name)}`);
}

/** Email a one-time step-up code to the user's primary address (then `stepUp({ strategy: 'email_code', code })`). */
export function sendStepUpEmailCode(client: FapiClient): Promise<FapiResponse<unknown>> {
  return client.post('/v1/client/me/step_up/email_code', {});
}

/** Text a one-time step-up code to the user's verified SMS factor or primary verified phone (then `stepUp({ strategy: 'phone_code', code })`). */
export function sendStepUpPhoneCode(client: FapiClient): Promise<FapiResponse<unknown>> {
  return client.post('/v1/client/me/step_up/phone_code', {});
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
  /** The named step-up policy the refusal came from (`wire_transfer`, …); null for a built-in action. */
  policy?: string | null;
  /** The factor strategies `stepUp()` accepts for it, e.g. `password`, `passkey`, `totp`. */
  acceptedFactors: string[];
  /** How recent the proof must be, in seconds; null when any multi-factor sign-in on the session counts. */
  maxAgeSeconds: number | null;
}

const DEFAULT_FACTORS = ['password', 'passkey', 'totp', 'backup_code', 'email_code', 'phone_code', 'push', 'duo', 'yubikey'] as const;

/** The step-up a refusal asks for, or null when `errors` holds no STEP_UP_REQUIRED. */
export function stepUpRequirement(errors: readonly FieldError[]): StepUpRequirement | null {
  const error = errors.find((e) => e.code === 'STEP_UP_REQUIRED');
  if (!error) return null;
  const meta = error.meta ?? {};
  const factors = Array.isArray(meta.accepted_factors) ? meta.accepted_factors.filter((f): f is string => typeof f === 'string') : [];
  return {
    action: typeof meta.action === 'string' ? meta.action : null,
    policy: typeof meta.policy === 'string' ? meta.policy : null,
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
  /** Text the step-up code (for the `phone_code` factor). */
  sendPhoneCode(): Promise<FapiResponse<unknown>>;
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
  /** push and duo answer "not yet" until the user acts on their device: how often to ask again (default 2000 ms) and for how long (default 120000 ms). */
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
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
    const input = await opts.prompt({ ...base, action: base.action ?? action, error, sendEmailCode: () => sendStepUpEmailCode(opts.client), sendPhoneCode: () => sendStepUpPhoneCode(opts.client) });
    if (!input) throw new StepUpCancelledError();
    const send = base.policy ? { ...input, policy: base.policy } : input;
    let res = await stepUp(opts.client, send);
    // push and duo: 202 means the user has not answered yet. Nothing was spent; ask again until they do.
    const until = Date.now() + (opts.pollTimeoutMs ?? 120_000);
    while (res.ok && res.status === 202 && Date.now() < until) {
      await new Promise((r) => setTimeout(r, opts.pollIntervalMs ?? 2000));
      res = await stepUp(opts.client, send);
    }
    if (res.ok && res.status === 202) {
      error = { code: 'step_up_timeout', message: 'The request was not answered in time.' };
      continue;
    }
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

/** How {@link withStepUp} recognises a refusal. */
export interface WithStepUpOptions extends Omit<RequireStepUpOptions, 'requirement'> {
  /**
   * Read a STEP_UP_REQUIRED refusal out of what `fn` returned or threw, or null when it is not one. The default
   * understands an Atlas `FapiResponse`, a fetch `Response` (403 with an `errors` body, read from a clone), and an
   * error carrying `code: 'STEP_UP_REQUIRED'` with `meta` or `errors`.
   */
  detect?: (outcome: { value: unknown } | { error: unknown }) => StepUpRequirement | null | Promise<StepUpRequirement | null>;
}

const isFieldErrors = (v: unknown): v is FieldError[] => Array.isArray(v) && v.every((e) => typeof e === 'object' && e !== null && 'code' in e);

/** The default refusal reader of {@link withStepUp}. */
export async function detectStepUpRefusal(outcome: { value: unknown } | { error: unknown }): Promise<StepUpRequirement | null> {
  if ('error' in outcome) {
    const e = outcome.error as { code?: unknown; meta?: unknown; errors?: unknown; body?: { errors?: unknown } } | null;
    if (!e || typeof e !== 'object') return null;
    const errors = [e.errors, e.body?.errors].find(isFieldErrors);
    if (errors) return stepUpRequirement(errors);
    if (e.code === 'STEP_UP_REQUIRED') return stepUpRequirement([{ code: 'STEP_UP_REQUIRED', message: '', meta: (e.meta as Record<string, unknown> | undefined) ?? {} } as FieldError]);
    return null;
  }
  const v = outcome.value as { ok?: unknown; errors?: unknown; status?: unknown; clone?: () => { json(): Promise<unknown> } } | null;
  if (!v || typeof v !== 'object') return null;
  if (v.ok === false && isFieldErrors(v.errors)) return stepUpRequirement(v.errors);
  if (v.status === 403 && typeof v.clone === 'function') {
    try {
      const body = (await v.clone().json()) as { errors?: unknown; error?: { code?: unknown; meta?: Record<string, unknown> } };
      if (isFieldErrors(body?.errors)) return stepUpRequirement(body.errors);
      if (body?.error?.code === 'STEP_UP_REQUIRED') return stepUpRequirement([{ code: 'STEP_UP_REQUIRED', message: '', meta: body.error.meta ?? {} } as FieldError]);
    } catch {
      /* not JSON: not a step-up refusal */
    }
  }
  return null;
}

/**
 * Run `fn`; when your backend refuses it with 403 STEP_UP_REQUIRED for the named policy (the answer `requireStepUp`
 * in `@atlasauth/backend` builds from `POST /v1/step_up/assert`), re-authenticate with {@link requireStepUp} using
 * only the methods that policy accepts, then run `fn` once more. Any other outcome, a thrown error included, is
 * returned or rethrown as it is.
 *
 *   await withStepUp('wire_transfer', () => fetch('/api/transfers', { method: 'POST', body }), { client, prompt });
 */
export async function withStepUp<T>(policy: string, fn: () => Promise<T>, opts: WithStepUpOptions): Promise<T> {
  const detect = opts.detect ?? detectStepUpRefusal;
  const refusal = async (outcome: { value: unknown } | { error: unknown }): Promise<StepUpRequirement | null> => {
    const r = await detect(outcome);
    return r ? { ...r, policy: r.policy ?? policy } : null;
  };
  let requirement: StepUpRequirement | null;
  try {
    const first = await fn();
    requirement = await refusal({ value: first });
    if (!requirement) return first;
  } catch (error) {
    requirement = await refusal({ error });
    if (!requirement) throw error;
  }
  await requireStepUp(requirement.action ?? 'policy', { ...opts, requirement });
  return fn();
}
