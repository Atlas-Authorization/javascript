/**
 * Step-up with no DOM: re-authenticate a signed-in session (cookie or bearer)
 * by asking YOUR code for a credential, then retry the call that was refused.
 *
 * `createStepUp({ client, choose })` returns `withStepUp(call)`: it runs `call`,
 * and when the server refuses it with STEP_UP_REQUIRED it asks `choose` for one
 * of the factors the account holds (and the refusal accepts), re-verifies with
 * `POST /v1/client/me/step_up`, and runs `call` once more. A passkey is run by
 * `passkeyAssertion` (React Native: `nativePasskeyAssertion(Passkey)` from
 * `@atlasauth/expo-passkeys`); everything else is a code or password you collect.
 */
import type { FieldError } from './attempt';
import type { FapiClient, FapiResponse } from './fapi';
import { passkeySecondFactorAssertion, type PasskeyAssertionProvider } from './passkey-second-factor';
import { requireStepUp, retryWithStepUp, startStepUpDuo, startStepUpPush, withStepUp as withNamedStepUp, type StepUpInput, type StepUpPrompt, type StepUpResult } from './step-up';

export type StepUpFactor = 'password' | 'passkey' | 'totp' | 'backup_code' | 'email_code' | 'phone_code' | 'push' | 'duo' | 'yubikey';

/** What the person picked. A passkey needs no input here: the platform prompt runs next. */
export type StepUpChoice =
  | { strategy: 'password'; password: string }
  | { strategy: 'totp' | 'backup_code' | 'email_code' | 'phone_code' | 'yubikey'; code: string }
  | { strategy: 'passkey' }
  /** The prompt is sent to the user's device; `onPushStarted` shows the number. */
  | { strategy: 'push' }
  /** The browser is sent to Duo (`onDuoRedirect`). */
  | { strategy: 'duo' };

/** What `choose` is asked for. */
export interface StepUpRequest {
  /** The refused action (`email_change`, …), when the server named it. */
  action: string | null;
  /** The factors to offer: held by the account and accepted for this action. Never empty. */
  factors: StepUpFactor[];
  maxAgeSeconds: number | null;
  /** The previous try failed (wrong code, cancelled passkey): show it and ask again. */
  error: FieldError | null;
  /** Email the step-up code (for the `email_code` factor). */
  sendEmailCode(): Promise<FapiResponse<unknown>>;
  /** Text the step-up code (for the `phone_code` factor). */
  sendPhoneCode(): Promise<FapiResponse<unknown>>;
}

export interface StepUpFlowOptions {
  client: FapiClient;
  /** Ask the person which factor to use and collect it; return null to cancel. */
  choose: (request: StepUpRequest) => Promise<StepUpChoice | null> | StepUpChoice | null;
  /** Runs the passkey prompt where there is no WebAuthn. Without it the browser's WebAuthn is used. */
  passkeyAssertion?: PasskeyAssertionProvider;
  /** Wrong credentials allowed before the last error is thrown. Default 3. */
  maxAttempts?: number;
  /** Show the number the user must tap on their device after a push step-up is sent. Without it `push` is not offered. */
  onPushStarted?: (challenge: { numberMatch: string; expiresAt: number }) => void;
  /** Send the browser to Duo (usually `window.location.assign(url)`). Without it `duo` is not offered. */
  onDuoRedirect?: (authorizationUrl: string) => void;
  /** Where Duo returns the browser; one of the app's own origins. */
  duoReturnUrl?: string;
}

/**
 * The step-up factors the signed-in account holds, or null when that cannot be
 * read (the caller then offers everything the refusal accepts).
 * `email_code` is always held: it goes to the primary address. `phone_code` is held with a verified phone.
 */
export async function heldStepUpFactors(client: FapiClient): Promise<StepUpFactor[] | null> {
  const [me, mfa, passkeys] = await Promise.all([
    client.get<{ has_password?: unknown; phone_numbers?: Array<{ verified?: boolean }> }>('/v1/client/me'),
    client.get<{ data?: Array<{ type?: string; verified?: boolean }>; backup_codes_remaining?: number }>('/v1/client/me/mfa'),
    client.get<{ data?: unknown[] }>('/v1/client/me/passkeys'),
  ]);
  if (!me.ok || !mfa.ok) return null;
  const held: StepUpFactor[] = [];
  if (me.data?.has_password === true) held.push('password');
  if (passkeys.ok && (passkeys.data?.data?.length ?? 0) > 0) held.push('passkey');
  if (mfa.data?.data?.some((f) => f.type === 'totp' && f.verified !== false)) held.push('totp');
  if (mfa.data?.data?.some((f) => f.type === 'push' && f.verified !== false)) held.push('push');
  if (mfa.data?.data?.some((f) => f.type === 'duo' && f.verified !== false)) held.push('duo');
  if (mfa.data?.data?.some((f) => f.type === 'yubikey' && f.verified !== false)) held.push('yubikey');
  if ((mfa.data?.backup_codes_remaining ?? 0) > 0) held.push('backup_code');
  held.push('email_code');
  // A texted code needs a verified SMS factor or a verified phone number.
  if (mfa.data?.data?.some((f) => f.type === 'sms' && f.verified !== false) || me.data?.phone_numbers?.some((n) => n.verified === true)) held.push('phone_code');
  return held;
}

const KNOWN: StepUpFactor[] = ['password', 'passkey', 'totp', 'backup_code', 'email_code', 'phone_code', 'push', 'duo', 'yubikey'];

export function createStepUp(opts: StepUpFlowOptions) {
  const { client } = opts;

  /** Passkey step-up: the server's challenge, the platform prompt, the assertion body. Returns the input, or the error to show. */
  const passkeyInput = async (): Promise<StepUpInput | FieldError> => {
    const started = await client.post<Record<string, unknown>>('/v1/client/me/step_up/passkey', {});
    if (!started.ok || !started.data) return started.errors[0] ?? { code: 'UNAUTHENTICATED', message: 'Could not start the passkey check.' };
    try {
      const a = await passkeySecondFactorAssertion(started.data, opts.passkeyAssertion ? { passkeyAssertion: opts.passkeyAssertion } : {});
      return { strategy: 'passkey', challenge: a.challenge, credential_id: a.credential_id, authenticator_data: a.authenticator_data, client_data_json: a.client_data_json, signature: a.signature };
    } catch (e) {
      return { code: 'passkey_cancelled', reason: 'passkey_cancelled', message: e instanceof Error ? e.message : 'The passkey prompt was cancelled.' };
    }
  };

  /** One prompt per refusal: the held factors are read once, then every retry of the prompt reuses them. */
  const makePrompt = () => {
    let held: Promise<StepUpFactor[] | null> | undefined;
    return async (p: StepUpPrompt): Promise<StepUpInput | null> => {
      held ??= heldStepUpFactors(client);
      const mine = await held;
      // push needs somewhere to show the number and duo somewhere to send the browser: without one they are not offered.
      const accepted = p.acceptedFactors.filter(
        (f): f is StepUpFactor => KNOWN.includes(f as StepUpFactor) && (f !== 'push' || Boolean(opts.onPushStarted)) && (f !== 'duo' || Boolean(opts.onDuoRedirect)),
      );
      const narrowed = mine ? accepted.filter((f) => mine.includes(f)) : accepted;
      // Never trap the person with nothing to pick: if the read and the refusal disagree, offer what the refusal accepts.
      const factors = narrowed.length ? narrowed : accepted;
      let error = p.error;
      for (;;) {
        const choice = await opts.choose({ action: p.action, factors, maxAgeSeconds: p.maxAgeSeconds, error, sendEmailCode: p.sendEmailCode, sendPhoneCode: p.sendPhoneCode });
        if (!choice) return null;
        if (choice.strategy === 'push') {
          const started = await startStepUpPush(client);
          if (started.ok && started.data) {
            opts.onPushStarted?.({ numberMatch: started.data.number_match, expiresAt: started.data.expires_at });
            return choice;
          }
          error = started.errors[0] ?? { code: 'UNAUTHENTICATED', message: 'Could not send the push prompt.' };
          continue;
        }
        if (choice.strategy === 'duo') {
          const started = await startStepUpDuo(client, opts.duoReturnUrl);
          if (started.ok && started.data) {
            opts.onDuoRedirect?.(started.data.authorization_url);
            return choice;
          }
          error = started.errors[0] ?? { code: 'UNAUTHENTICATED', message: 'Could not start Duo.' };
          continue;
        }
        if (choice.strategy !== 'passkey') return choice;
        const input = await passkeyInput();
        if ('strategy' in input) return input;
        error = input;
      }
    };
  };

  return {
    /** Run `call`; on STEP_UP_REQUIRED re-authenticate and run it once more. Throws `StepUpCancelledError` when `choose` returns null. */
    withStepUp<T>(call: () => Promise<FapiResponse<T>>): Promise<FapiResponse<T>> {
      return retryWithStepUp(call, { client, prompt: makePrompt(), ...(opts.maxAttempts ? { maxAttempts: opts.maxAttempts } : {}) });
    },
    /**
     * Run `fn`; when your backend refuses it with 403 STEP_UP_REQUIRED for the named policy, re-authenticate with only
     * the factors that policy accepts and run `fn` once more. `fn` may return an Atlas response, a fetch `Response`
     * or throw an error carrying the refusal.
     */
    withPolicy<T>(policy: string, fn: () => Promise<T>): Promise<T> {
      return withNamedStepUp(policy, fn, { client, prompt: makePrompt(), ...(opts.maxAttempts ? { maxAttempts: opts.maxAttempts } : {}) });
    },
    /** Re-authenticate now (for example before opening a security page). */
    reauthenticate(action = 'sensitive_action'): Promise<StepUpResult> {
      return requireStepUp(action, { client, prompt: makePrompt(), ...(opts.maxAttempts ? { maxAttempts: opts.maxAttempts } : {}) });
    },
  };
}
