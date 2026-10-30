/**
 * Passkey sign-in's ceremony start, with the bot challenge folded in.
 *
 * Passwordless passkey sign-in has no identifier step, so when the instance
 * challenges every sign-in (the always-on sign-in captcha, or a force-challenge
 * switch) `POST /v1/client/sign_ins/passkey/begin` is where the captcha is
 * taken: the token rides in its body as `captcha_token`, and without one the
 * server answers `400 CAPTCHA_REQUIRED` (or `CAPTCHA_FAILED` for a token it
 * refused).
 *
 * {@link beginPasskeySignIn} asks the caller's token source first (it returns a
 * token only when the client already knows one is needed, e.g. an always-on
 * sign-in captcha), and on a captcha refusal asks once more for a FRESH token
 * (tokens are single-use) and retries once. The caller still runs the browser
 * ceremony (`getPasskeyAssertion`) and the `finish` POST.
 */
import type { AttemptView } from './attempt';
import type { FapiClient, FapiResponse, FlowState } from './fapi';
import { isCaptchaError } from './captcha-widget';
import { conditionalUiAvailable, getPasskeyAssertion, passkeysSupported, type PasskeyExtensionOptions, type WebAuthnHost } from './passkey';

/** What a passkey begin's token source is asked for. */
export interface PasskeyCaptchaRequest {
  /**
   * False on the first ask: return a token only when one is known to be needed
   * (null to send none). True after the server refused the begin: a fresh token,
   * rendering the challenge even if the flow's always-on flag is off.
   */
  retry: boolean;
  /** On a retry, the refusal that prompted it. */
  refused?: 'CAPTCHA_REQUIRED' | 'CAPTCHA_FAILED';
}

/** Supplies the `captcha_token` for a passkey begin; null/undefined sends none. */
export type PasskeyCaptchaSource = (request: PasskeyCaptchaRequest) => Promise<string | null | undefined>;

export const PASSKEY_SIGN_IN_BEGIN_PATH = '/v1/client/sign_ins/passkey/begin';

const ask = async (source: PasskeyCaptchaSource, request: PasskeyCaptchaRequest): Promise<string | null> => {
  try {
    return (await source(request)) || null;
  } catch {
    // A provider that failed to load / timed out: send none; the server decides.
    return null;
  }
};

/**
 * `POST /v1/client/sign_ins/passkey/begin`, carrying the captcha token when the
 * instance challenges sign-ins, and retrying ONCE with a fresh token after a
 * `CAPTCHA_REQUIRED` / `CAPTCHA_FAILED` refusal. Returns the (last) response;
 * on success its `data` is the `getPasskeyAssertion` input.
 */
export async function beginPasskeySignIn(
  client: FapiClient,
  opts: { captcha?: PasskeyCaptchaSource | null } = {},
): Promise<FapiResponse<Record<string, unknown>>> {
  const post = (token: string | null) =>
    client.post<Record<string, unknown>>(PASSKEY_SIGN_IN_BEGIN_PATH, token ? { captcha_token: token } : {});

  const source = opts.captcha ?? null;
  const first = source ? await ask(source, { retry: false }) : null;
  const response = await post(first);
  if (response.ok || !source) return response;

  const refusal = response.errors.find((error) => isCaptchaError(error));
  if (!refusal) return response;
  const fresh = await ask(source, {
    retry: true,
    refused: refusal.code === 'CAPTCHA_FAILED' ? 'CAPTCHA_FAILED' : 'CAPTCHA_REQUIRED',
  });
  // No token to retry with: report the refusal (the caller localizes it).
  if (!fresh) return response;
  return post(fresh);
}

export const PASSKEY_SIGN_IN_FINISH_PATH = '/v1/client/sign_ins/passkey/finish';

/** Options for {@link signInWithPasskey}. */
export interface PasskeySignInOptions extends PasskeyExtensionOptions {
  /** The sign-in captcha's token source, when the instance challenges sign-ins (see {@link beginPasskeySignIn}). */
  captcha?: PasskeyCaptchaSource | null;
  /** `conditional` for autofill UI (see {@link startConditionalPasskeySignIn}). */
  mediation?: 'optional' | 'conditional';
  signal?: AbortSignal;
  host?: WebAuthnHost;
}

type FinishView = AttemptView & { created_session_id?: string | null; ticket?: string };

/**
 * Usernameless passkey sign-in, start to finish: begin (with the captcha when
 * the instance challenges sign-ins) → the browser ceremony → finish.
 *
 * The finish sets the session cookies itself, so a `complete` result carries no
 * ticket to exchange: the caller re-boots, exactly as after any sign-in. A
 * passkey that proved presence only, on an account that owes MFA, returns the
 * attempt at its second-factor step instead; continue there like any sign-in.
 * A cancelled browser prompt is a `PASSKEY_CANCELLED` error, never a throw.
 * PRF outputs (`prf` / `onExtensionResults`) go to the app only, never to Atlas.
 */
export async function signInWithPasskey(client: FapiClient, opts: PasskeySignInOptions = {}): Promise<FlowState> {
  const base: FlowState = { attempt: null, errors: [], busy: false, pollSecret: null, ticket: null };
  const begin = await beginPasskeySignIn(client, { captcha: opts.captcha ?? null });
  if (!begin.ok || !begin.data) return { ...base, errors: begin.errors };

  let body;
  try {
    body = await getPasskeyAssertion(begin.data, {
      ...(opts.host ? { host: opts.host } : {}),
      ...(opts.mediation ? { mediation: opts.mediation } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(opts.prf ? { prf: opts.prf } : {}),
      ...(opts.onExtensionResults ? { onExtensionResults: opts.onExtensionResults } : {}),
    });
  } catch (error) {
    return {
      ...base,
      errors: [
        {
          code: 'PASSKEY_CANCELLED',
          message: error instanceof Error && error.message ? error.message : 'Passkey sign-in was cancelled.',
        },
      ],
    };
  }

  const done = await client.post<FinishView>(PASSKEY_SIGN_IN_FINISH_PATH, body);
  if (!done.ok || !done.data) return { ...base, errors: done.errors };
  return { ...base, attempt: done.data, ticket: done.data.ticket ?? null };
}

/**
 * Conditional (autofill) passkey sign-in: when the browser supports conditional
 * mediation, run a background passkey request so saved passkeys appear in the
 * autofill of an input with `autocomplete="username webauthn"`. `onResult` gets
 * the outcome only when the user picks a passkey; a cancelled or aborted
 * request is silent. Abort `signal` the moment the user does anything else
 * (submits the form, presses the passkey button). Resolves false when it was
 * not armed (unsupported browser, or `skip`).
 *
 * No captcha: an instance that challenges every sign-in refuses the begin, and
 * the autofill stays off quietly; the button and the email step take the
 * challenge instead.
 */
export async function startConditionalPasskeySignIn(
  client: FapiClient,
  opts: PasskeyExtensionOptions & { signal: AbortSignal; onResult: (next: FlowState) => void; host?: WebAuthnHost },
): Promise<boolean> {
  // An injected host (tests, embedded webviews) stands in for the global WebAuthn API.
  if (!opts.host && !passkeysSupported()) return false;
  let available = false;
  try {
    available = await conditionalUiAvailable();
  } catch {
    available = false;
  }
  if (!available || opts.signal.aborted) return false;
  const next = await signInWithPasskey(client, { ...opts, mediation: 'conditional' });
  if (opts.signal.aborted) return true;
  // A refused begin or a dismissed autofill is not an error the user caused.
  if (!next.attempt && next.errors.length > 0) return true;
  opts.onResult(next);
  return true;
}

/** The captcha a sign-in form holds: an always-on sign-in captcha's token rides in the passkey begin. */
export interface PasskeySignInCaptcha {
  readonly needed: boolean;
  getToken(): Promise<string | null>;
  reset(): void;
}

/**
 * The passkey half of a prebuilt sign-in form, for the framework SDKs that draw
 * their own UI (Vue, Svelte, Solid, Angular): `signIn()` for the
 * "Sign in with a passkey" button, `armAutofill()` when the first step shows
 * (conditional mediation for the `autocomplete="username webauthn"` field) and
 * `stopAutofill()` when the user submits an identifier or the form goes away.
 * `onResult` gets every outcome — the form treats it like any sign-in result:
 * a `complete` attempt re-boots (the finish already set the cookie), a pending
 * one continues at its step, errors show on the form. A cancelled prompt is a
 * `PASSKEY_CANCELLED` error carrying `cancelledMessage` when given.
 */
export interface PasskeySignInController {
  signIn(): Promise<void>;
  armAutofill(): void;
  stopAutofill(): void;
}

export function createPasskeySignInController(opts: {
  client: FapiClient;
  onResult: (next: FlowState) => void | Promise<void>;
  /** Called before a button-started ceremony (show busy). */
  onStart?: () => void;
  captcha?: () => PasskeySignInCaptcha | null | undefined;
  cancelledMessage?: () => string;
  host?: WebAuthnHost;
} & PasskeyExtensionOptions): PasskeySignInController {
  let autofill: AbortController | null = null;
  const extensions = (): PasskeyExtensionOptions & { host?: WebAuthnHost } => ({
    ...(opts.host ? { host: opts.host } : {}),
    ...(opts.prf ? { prf: opts.prf } : {}),
    ...(opts.onExtensionResults ? { onExtensionResults: opts.onExtensionResults } : {}),
  });
  const localized = (next: FlowState): FlowState =>
    opts.cancelledMessage
      ? { ...next, errors: next.errors.map((e) => (e.code === 'PASSKEY_CANCELLED' ? { ...e, message: opts.cancelledMessage!() } : e)) }
      : next;
  const stopAutofill = () => {
    autofill?.abort();
    autofill = null;
  };
  return {
    stopAutofill,
    armAutofill() {
      stopAutofill();
      // An always-on sign-in captcha needs the user to act: the button takes it instead.
      if (opts.captcha?.()?.needed) return;
      const controller = new AbortController();
      autofill = controller;
      void startConditionalPasskeySignIn(opts.client, {
        signal: controller.signal,
        ...extensions(),
        onResult: (next) => void opts.onResult(localized(next)),
      });
    },
    async signIn() {
      stopAutofill();
      opts.onStart?.();
      const captcha = opts.captcha?.() ?? null;
      let spent = false;
      const next = await signInWithPasskey(opts.client, {
        captcha: captcha?.needed
          ? async () => {
              const token = await captcha.getToken();
              if (token) spent = true;
              return token;
            }
          : null,
        ...extensions(),
      });
      if (spent) captcha?.reset();
      await opts.onResult(localized(next));
    },
  };
}
