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
import type { FapiClient, FapiResponse } from './fapi';
import { isCaptchaError } from './captcha-widget';

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
