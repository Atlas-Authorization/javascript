/**
 * Cross-property SSO handshake — the second property's server-side redeem step.
 *
 * When a satellite (a property on a DIFFERENT registrable domain than the main
 * app) has no local session, the SDK middleware bounces the browser through
 * `GET {fapiOrigin}/v1/client/handshake`, which — if the user has an Atlas
 * session — redirects back with `?__atlas_hs=ok&__atlas_hu=<userId>&__atlas_hn=
 * <nonce>`. This helper exchanges that single-use nonce for a fresh session,
 * server-to-server, so the tokens are returned in the response BODY (never a
 * URL). The caller sets them as its OWN first-party cookies:
 *
 *   const s = await redeemHandshake({ fapiOrigin, publishableKey, userId, nonce });
 *   if (s) {
 *     res.cookies.set('__session', s.jwt, { path: '/', sameSite: 'lax', secure: true });
 *     res.cookies.set('__atlas_rt', s.refreshToken, { path: '/', httpOnly: true, sameSite: 'lax', secure: true });
 *   }
 *
 * (Same-registrable-domain SUBDOMAINS don't need this — the handshake sets a
 * parent-domain cookie directly; this is only the cross-domain path.)
 */

export interface RedeemHandshakeOptions {
  /** Origin of the Atlas Frontend API, e.g. `https://id.atlasauth.net`. */
  fapiOrigin: string;
  /** The instance publishable key (`pk_…`). */
  publishableKey: string;
  /**
   * The `__atlas_hu` value from the return URL. Advisory only — the server
   * issues the session for the subject the nonce was bound to, not this value.
   */
  userId: string;
  /** The single-use `__atlas_hn` nonce from the return URL. */
  nonce: string;
  /**
   * The PKCE `code_verifier` this server generated (with {@link createPkcePair})
   * BEFORE bouncing the browser to the handshake, stashed server-side (a
   * short-lived HttpOnly cookie). Proves possession of the challenge the nonce
   * was bound to — a stolen nonce without it is inert.
   */
  codeVerifier: string;
  fetchImpl?: typeof fetch;
}

const base64url = (bytes: Uint8Array): string => {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  // btoa is available in every SDK runtime (edge, workers, browser, Node ≥16).
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

export interface PkcePair {
  /** Kept server-side; never leaves the redeeming server. */
  verifier: string;
  /** base64url(SHA-256(verifier)); the only half that reaches the handshake. */
  challenge: string;
}

/**
 * Generate a PKCE (RFC 7636, S256) pair for a cross-domain handshake. Uses only
 * Web Crypto globals so it runs unchanged on the edge/worker runtimes the SDK
 * middleware targets — no `node:crypto`. Send `challenge` on the handshake URL
 * as `code_challenge`; stash `verifier` server-side and pass it to
 * {@link redeemHandshake}.
 */
export async function createPkcePair(): Promise<PkcePair> {
  const raw = new Uint8Array(32);
  crypto.getRandomValues(raw);
  const verifier = base64url(raw);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return { verifier, challenge: base64url(new Uint8Array(digest)) };
}

export interface HandshakeSession {
  /** The `__session` JWT value to set as a cookie (script-readable, short-lived). */
  jwt: string;
  /** The `__atlas_rt` refresh value to set as an HttpOnly cookie. */
  refreshToken: string;
  sessionId: string;
  /** Seconds until the `__session` JWT expires. */
  expiresIn: number;
}

/**
 * Redeem a handshake nonce for a fresh session. Returns `null` when the nonce is
 * missing/expired/already used (the caller should then fall back to sign-in).
 * Never throws on an auth failure — a bad nonce is a signed-out signal, not an
 * error that should take the page down.
 */
export async function redeemHandshake(options: RedeemHandshakeOptions): Promise<HandshakeSession | null> {
  const doFetch = options.fetchImpl ?? fetch;
  const url = new URL('/v1/client/handshake/redeem', options.fapiOrigin).toString();

  let res: Response;
  try {
    res = await doFetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-publishable-key': options.publishableKey,
      },
      body: JSON.stringify({
        user_id: options.userId,
        nonce: options.nonce,
        code_verifier: options.codeVerifier,
      }),
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;

  const data = (await res.json().catch(() => null)) as {
    jwt?: string;
    refresh_token?: string;
    session_id?: string;
    expires_in?: number;
  } | null;
  if (!data?.jwt || !data.refresh_token) return null;

  return {
    jwt: data.jwt,
    refreshToken: data.refresh_token,
    sessionId: data.session_id ?? '',
    expiresIn: data.expires_in ?? 0,
  };
}

/** Extract the handshake params from a return URL (or its query string). */
export function readHandshakeParams(urlOrSearch: string): { userId: string; nonce: string } | null {
  const q = urlOrSearch.includes('?') ? urlOrSearch.slice(urlOrSearch.indexOf('?')) : urlOrSearch;
  const params = new URLSearchParams(q.startsWith('?') ? q : `?${q}`);
  if (params.get('__atlas_hs') !== 'ok') return null;
  const userId = params.get('__atlas_hu');
  const nonce = params.get('__atlas_hn');
  return userId && nonce ? { userId, nonce } : null;
}
