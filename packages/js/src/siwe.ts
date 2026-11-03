/**
 * §6 Sign-in with Ethereum (SIWE, EIP-4361) — the client half.
 *
 * Two steps, both pure shapers (the app owns fetch):
 *   1. POST `/v1/oauth/siwe/nonce` (no body) and read the nonce with
 *      `parseSiweNonceResponse`.
 *   2. Have the wallet sign an EIP-4361 message carrying that nonce, then POST
 *      `siweVerifyBody({ message, signature })` to `/v1/oauth/siwe/verify` and
 *      read the result with the shared `parseNativeSignInResponse`.
 */

export interface SiweVerifyBody {
  message: string;
  signature: string;
}

/** Build the POST body for `/v1/oauth/siwe/verify`. */
export function siweVerifyBody(input: { message: string; signature: string }): SiweVerifyBody {
  return { message: input.message, signature: input.signature };
}

/** The single-use nonce returned by `/v1/oauth/siwe/nonce`, or null if malformed. */
export function parseSiweNonceResponse(body: unknown): { nonce: string } | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as { nonce?: unknown };
  if (typeof b.nonce !== 'string' || b.nonce.length === 0) return null;
  return { nonce: b.nonce };
}
