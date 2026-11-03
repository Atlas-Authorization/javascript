/**
 * App and device attestation — the client half.
 *
 * When an instance turns on `attackProtection.appAttestation`, sign-up, sign-in
 * and SMS-send calls must carry proof (header `Atlas-Attestation`) that the
 * request comes from your genuine app. The OS does the vouching; the app
 * supplies an {@link AttestationProvider} that wraps it:
 *
 *   - iOS (App Attest): `registerKey` once per install, then `assert(nonce)` per request.
 *   - Android (Play Integrity): `integrityToken(nonce)` per request.
 *
 * Pass the provider as `FapiClient` option `attestation`; the client fetches
 * a single-use nonce and attaches the header on the guarded calls itself.
 * Server routes: POST /v1/client/attestation/challenge and
 * POST /v1/client/attestation/app_attest/register.
 */
import type { FapiClient, FapiResponse } from './fapi';

export type AttestationProof =
  | { platform: 'ios'; assertion: string; receipt: string }
  | { platform: 'android'; integrityToken: string }
  /** iOS devices without App Attest: the base64 DCDevice token. */
  | { platform: 'ios_devicecheck'; deviceToken: string };

export interface AttestationProvider {
  /** Returns the OS proof for the single-use `nonce`. For App Attest, `assertion` is base64 and `receipt` comes from {@link registerAppAttestKey}. */
  prove(nonce: string): Promise<AttestationProof>;
}

/** The calls an instance may require attestation on. */
const GUARDED = [
  /^\/v1\/client\/sign_ups(\?|$)/,
  /^\/v1\/client\/sign_ins(\?|$)/,
  /^\/v1\/client\/me\/phone_numbers(\?|$)/,
  /^\/v1\/client\/me\/phone_numbers\/[^/]+\/prepare_verification(\?|$)/,
];

export const isAttestationGuarded = (path: string, method: string): boolean =>
  method === 'POST' && GUARDED.some((re) => re.test(path));

/** Builds the `Atlas-Attestation` header value from a fresh nonce and the provider's proof. */
export function encodeAttestationHeader(nonce: string, proof: AttestationProof): string {
  const body =
    proof.platform === 'ios'
      ? { p: 'ios', n: nonce, a: proof.assertion, r: proof.receipt }
      : proof.platform === 'ios_devicecheck'
        ? { p: 'ios_dc', n: nonce, t: proof.deviceToken }
        : { p: 'android', n: nonce, t: proof.integrityToken };
  return btoa(JSON.stringify(body)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Fetches a nonce, has the provider attest it, and returns the header value; null when no nonce could be fetched. */
export async function attestationHeaderFor(client: FapiClient, provider: AttestationProvider): Promise<string | null> {
  const challenge = await client.request<{ nonce: string }>('/v1/client/attestation/challenge', { method: 'POST', body: '{}' });
  if (!challenge.ok || !challenge.data) return null;
  return encodeAttestationHeader(challenge.data.nonce, await provider.prove(challenge.data.nonce));
}

/**
 * iOS: registers an App Attest key. `attest(challenge)` is the app's call to
 * `DCAppAttestService.attestKey` with SHA-256 of `challenge` as clientDataHash,
 * returning `{ keyId, attestation }` (both base64). Store the returned `receipt`
 * and hand it to {@link AttestationProvider.prove} with each assertion.
 */
export async function registerAppAttestKey(
  client: FapiClient,
  attest: (challenge: string) => Promise<{ keyId: string; attestation: string }>,
): Promise<FapiResponse<{ receipt: string; expires_at: number }>> {
  const challenge = await client.request<{ nonce: string }>('/v1/client/attestation/challenge', { method: 'POST', body: '{}' });
  if (!challenge.ok || !challenge.data) return challenge as unknown as FapiResponse<{ receipt: string; expires_at: number }>;
  const { keyId, attestation } = await attest(challenge.data.nonce);
  return client.request('/v1/client/attestation/app_attest/register', {
    method: 'POST',
    body: JSON.stringify({ nonce: challenge.data.nonce, key_id: keyId, attestation }),
  });
}
