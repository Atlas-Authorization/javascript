/**
 * @atlasauth/expo-passkeys — passkey register / sign-in for Expo & React Native.
 *
 * Passkeys on native are a two-call dance that mirrors the web (see
 * `@atlasauth/js`'s `createPasskey` / `getPasskeyAssertion`): the server's
 * `begin` response describes the ceremony, the platform authenticator performs
 * it, and the result is POSTed to `finish`. The browser runs the ceremony with
 * `navigator.credentials`; on native there is no `navigator`, so this helper
 * delegates the ceremony to `react-native-passkey` (an optional peer, passed in)
 * and owns only the two HTTP calls and the body mapping between them.
 *
 *   register: POST /v1/client/me/passkeys/begin → Passkey.create → /finish
 *   sign in : POST /v1/client/sign_ins/passkey/begin → Passkey.get → /finish
 */

import {
  beginPasskeySignIn,
  fetchInstanceSettings,
  type FieldError,
  type FlowCaptcha,
  type PasskeyAssertionBody,
  type PasskeyRegistrationBody,
} from '@atlasauth/js';
import { createFapiClient, type AtlasFapiConfig } from './client';
import type {
  PasskeyCreateResult,
  PasskeyGetResult,
  ReactNativePasskey,
} from './passkey-native';

export * from './client';
export * from './passkey-native';

/* ── pure body mapping (unit-tested without a device) ──────────────────────── */

/** Map a `begin` response + a `Passkey.create` result to the `/finish` body. */
export function toRegistrationFinishBody(
  begin: Record<string, unknown>,
  credential: PasskeyCreateResult,
  name?: string,
): PasskeyRegistrationBody {
  return {
    // Echo the server's challenge string — the server matched/stored it.
    challenge: begin.challenge as string,
    attestation_object: credential.response.attestationObject,
    client_data_json: credential.response.clientDataJSON,
    ...(name ? { name } : {}),
  };
}

/** Map a `begin` response + a `Passkey.get` result to the `/finish` body. */
export function toAssertionFinishBody(
  begin: Record<string, unknown>,
  assertion: PasskeyGetResult,
): PasskeyAssertionBody {
  return {
    handle: begin.handle as string,
    challenge: begin.challenge as string,
    credential_id: assertion.rawId ?? assertion.id ?? '',
    authenticator_data: assertion.response.authenticatorData,
    client_data_json: assertion.response.clientDataJSON,
    signature: assertion.response.signature,
  };
}

/* ── the two ceremonies ────────────────────────────────────────────────────── */

export interface RegisterPasskeyResult {
  ok: boolean;
  errors: FieldError[];
}

/**
 * Register a passkey for the signed-in user. Requires `config.getToken` (the
 * `/me/*` route is authenticated). Runs begin → platform ceremony → finish.
 */
export async function registerPasskey(opts: {
  config: AtlasFapiConfig;
  passkey: ReactNativePasskey;
  /** A human label for the credential (shown in the user's device list). */
  name?: string;
}): Promise<RegisterPasskeyResult> {
  const client = createFapiClient(opts.config);

  const begin = await client.post<Record<string, unknown>>('/v1/client/me/passkeys/begin', {});
  if (!begin.ok || !begin.data) return { ok: false, errors: begin.errors };

  const credential = await opts.passkey.create(begin.data);
  const body = toRegistrationFinishBody(begin.data, credential, opts.name);

  const finish = await client.post('/v1/client/me/passkeys/finish', body);
  return { ok: finish.ok, errors: finish.errors };
}

export interface PasskeySignInResult {
  status: 'complete' | 'needs_more' | 'error';
  /** Present when complete — exchange it for a session token. */
  ticket?: string;
  attemptId?: string;
  attemptStatus?: string;
  errors: FieldError[];
}

/** What {@link authenticateWithPasskey}'s `getCaptchaToken` is asked for. */
export interface PasskeyCaptchaTokenRequest {
  /** Always `signIn`: the passkey begin takes the sign-in challenge. */
  flow: 'signIn';
  /**
   * The instance's public sign-in captcha settings (provider, site key, widget
   * mode) from `GET /v1/appearance`; null if they could not be read.
   */
  captcha: FlowCaptcha | null;
  /** The refusal that prompted the ask. */
  refused: 'CAPTCHA_REQUIRED' | 'CAPTCHA_FAILED';
}

/**
 * Sign in with a passkey. Runs begin → platform ceremony → finish and returns
 * the attempt outcome: `complete` carries a one-time `ticket` to exchange for a
 * session (hand it to `@atlasauth/expo`), `needs_more` means a factor is still
 * owed.
 *
 * When the instance challenges every sign-in (an always-on sign-in captcha, or
 * a force-challenge switch) the begin needs a `captcha_token`. Pass a solved
 * `captchaToken` up front, and/or a `getCaptchaToken` callback: after a
 * `CAPTCHA_REQUIRED` / `CAPTCHA_FAILED` refusal it is asked for a FRESH token
 * (run the provider's challenge, e.g. in a WebView, with `captcha.siteKey`) and
 * the begin is retried once. Without either, the refusal comes back as the
 * result's error.
 */
export async function authenticateWithPasskey(opts: {
  config: AtlasFapiConfig;
  passkey: ReactNativePasskey;
  /** A solved sign-in captcha token, sent on the first begin. */
  captchaToken?: string;
  /** Asked for a fresh token after a captcha refusal; the begin is then retried once. */
  getCaptchaToken?: (request: PasskeyCaptchaTokenRequest) => Promise<string | null>;
}): Promise<PasskeySignInResult> {
  const client = createFapiClient(opts.config);
  const { captchaToken, getCaptchaToken } = opts;

  const begin = await beginPasskeySignIn(client, {
    captcha:
      captchaToken || getCaptchaToken
        ? async ({ retry, refused }) => {
            if (!retry) return captchaToken ?? null;
            if (!getCaptchaToken) return null;
            const settings = await fetchInstanceSettings(client);
            return getCaptchaToken({
              flow: 'signIn',
              captcha: settings?.captchaFlows.signIn ?? null,
              refused: refused ?? 'CAPTCHA_REQUIRED',
            });
          }
        : null,
  });
  if (!begin.ok || !begin.data) return { status: 'error', errors: begin.errors };

  const assertion = await opts.passkey.get(begin.data);
  const body = toAssertionFinishBody(begin.data, assertion);

  const finish = await client.post<{ id?: string; status?: string; ticket?: string }>(
    '/v1/client/sign_ins/passkey/finish',
    body,
  );
  if (!finish.ok || !finish.data) return { status: 'error', errors: finish.errors };

  return {
    status: finish.data.ticket ? 'complete' : 'needs_more',
    ...(finish.data.ticket ? { ticket: finish.data.ticket } : {}),
    ...(finish.data.id ? { attemptId: finish.data.id } : {}),
    ...(finish.data.status ? { attemptStatus: finish.data.status } : {}),
    errors: [],
  };
}
