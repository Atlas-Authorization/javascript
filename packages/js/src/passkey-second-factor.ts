/**
 * Finish a sign-in that stopped at `needs_second_factor` with a passkey, given
 * only the attempt id. Works for an attempt your own code started (password,
 * email code, native sign-in), not just one run by `createSignInFlow`.
 *
 *   POST /v1/client/sign_ins/{id}/prepare_second_factor { strategy: 'passkey' }
 *   → the platform passkey prompt
 *   → POST /v1/client/sign_ins/{id}/attempt_second_factor { strategy: 'passkey', … }
 */
import type { FieldError } from './attempt';
import type { FapiClient } from './fapi';
import { getPasskeyAssertion, type WebAuthnHost } from './passkey';

/** The signed assertion `attempt_second_factor` checks. */
export interface PasskeySecondFactorAssertion {
  challenge: string;
  credential_id: string;
  authenticator_data: string;
  client_data_json: string;
  signature: string;
}

/**
 * Runs the passkey prompt for a second-factor challenge. Browsers use WebAuthn
 * by default; React Native passes `nativePasskeyAssertion(Passkey)` from
 * `@atlasauth/expo-passkeys`.
 */
export type PasskeyAssertionProvider = (challenge: Record<string, unknown>) => Promise<PasskeySecondFactorAssertion>;

export type PasskeySecondFactorResult =
  | {
      ok: true;
      /** The attempt status after the passkey: `complete`, or a later step still owed. */
      status: string;
      attemptId: string;
      /** One-time ticket to exchange for a session, present when `status` is `complete`. */
      ticket: string | null;
    }
  | { ok: false; errors: FieldError[]; status: number };

/** Prompt for the passkey with the given provider, or WebAuthn when there is none. */
export async function passkeySecondFactorAssertion(
  challenge: Record<string, unknown>,
  opts: { passkeyAssertion?: PasskeyAssertionProvider; host?: WebAuthnHost } = {},
): Promise<PasskeySecondFactorAssertion> {
  if (opts.passkeyAssertion) return opts.passkeyAssertion(challenge);
  const a = await getPasskeyAssertion(challenge, opts.host ? { host: opts.host } : {});
  return {
    challenge: a.challenge,
    credential_id: a.credential_id,
    authenticator_data: a.authenticator_data,
    client_data_json: a.client_data_json,
    signature: a.signature,
  };
}

/** The `attempt_second_factor` body for a passkey assertion. */
export function passkeySecondFactorBody(a: PasskeySecondFactorAssertion, rememberDevice?: boolean): Record<string, string> {
  return {
    strategy: 'passkey',
    challenge: a.challenge,
    credential_id: a.credential_id,
    authenticator_data: a.authenticator_data,
    client_data_json: a.client_data_json,
    signature: a.signature,
    ...(rememberDevice ? { remember_device: 'true' } : {}),
  };
}

/**
 * Complete the second factor of an existing sign-in attempt with a passkey the
 * user holds. A cancelled prompt answers `passkey_cancelled`; a wrong or foreign
 * passkey answers the server's refusal.
 */
export async function completePasskeySecondFactor(
  client: FapiClient,
  attemptId: string,
  opts: { passkeyAssertion?: PasskeyAssertionProvider; host?: WebAuthnHost; rememberDevice?: boolean } = {},
): Promise<PasskeySecondFactorResult> {
  const path = `/v1/client/sign_ins/${encodeURIComponent(attemptId)}`;
  const prepared = await client.post<Record<string, unknown>>(`${path}/prepare_second_factor`, { strategy: 'passkey' });
  if (!prepared.ok || !prepared.data) return { ok: false, errors: prepared.errors, status: prepared.status };

  let assertion: PasskeySecondFactorAssertion;
  try {
    assertion = await passkeySecondFactorAssertion(prepared.data, opts);
  } catch (e) {
    return {
      ok: false,
      status: 0,
      errors: [{ code: 'passkey_cancelled', message: e instanceof Error ? e.message : 'The passkey prompt was cancelled.', reason: 'passkey_cancelled' }],
    };
  }

  const res = await client.post<{ id?: string; status?: string; ticket?: string }>(
    `${path}/attempt_second_factor`,
    passkeySecondFactorBody(assertion, opts.rememberDevice),
  );
  if (!res.ok || !res.data) return { ok: false, errors: res.errors, status: res.status };
  return { ok: true, status: res.data.status ?? 'unknown', attemptId: res.data.id ?? attemptId, ticket: res.data.ticket ?? null };
}
