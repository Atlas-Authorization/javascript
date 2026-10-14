/**
 * PKCE (RFC 7636, S256) for the native authorization-code flow.
 *
 * A first-party native/Capacitor client is a PUBLIC client — it ships no secret
 * — so it proves possession of its own authorization request with PKCE: it keeps
 * a random `verifier`, sends only `code_challenge = base64url(SHA-256(verifier))`
 * on the authorize URL, and presents the `verifier` when it redeems the code. A
 * code intercepted on the deep-link callback is inert without the verifier, which
 * never leaves the app.
 *
 * Uses only Web Crypto globals (`crypto.getRandomValues`, `crypto.subtle`), which
 * every Capacitor target provides — the iOS/Android system WebView and the web
 * build alike — so there is no `node:crypto` import. Mirrors `createPkcePair`
 * from `@atlasauth/backend`'s handshake, here on the client side of the exchange.
 */

/** base64url, no padding — the encoding PKCE and OAuth use for these values. */
function base64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export interface PkcePair {
  /** Kept in the app; presented only when the code is redeemed, never on the URL. */
  verifier: string;
  /** base64url(SHA-256(verifier)); the only half that rides the authorize URL. */
  challenge: string;
}

/**
 * Generate a PKCE S256 pair. The verifier is 32 random bytes, base64url-encoded
 * (43 chars — within RFC 7636's 43–128 range); the challenge is its SHA-256
 * digest, base64url-encoded.
 */
export async function createPkcePair(): Promise<PkcePair> {
  const raw = new Uint8Array(32);
  crypto.getRandomValues(raw);
  const verifier = base64url(raw);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return { verifier, challenge: base64url(new Uint8Array(digest)) };
}

/**
 * Mint a random `state` value for CSRF binding of the authorize request. Sent on
 * the authorize URL and checked against the value echoed back on the deep-link
 * callback, so an unsolicited callback (a deep link we did not initiate) is
 * rejected.
 */
export function createState(): string {
  const raw = new Uint8Array(16);
  crypto.getRandomValues(raw);
  return base64url(raw);
}
