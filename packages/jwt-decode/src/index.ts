/**
 * `@atlasauth/jwt-decode` — a tiny, zero-dependency helper to DECODE (never
 * verify) a JWT in the browser or on the server. The Atlas peer of Auth0's
 * `jwt-decode`.
 *
 * DECODE-ONLY, by design. Nothing here checks a signature, so a decoded payload
 * is UNTRUSTED input — anyone can mint a token with any claims. Use it only to
 * read a token you already hold for display or routing (e.g. show the signed-in
 * user, or read `exp` to schedule a refresh). To TRUST a token's claims, verify
 * it with `@atlasauth/backend` (`new AtlasBackend({ jwksUrl, issuer })` →
 * `verify` / `authenticateRequest`), which checks the RS256 signature against
 * your instance JWKS.
 */

/** Thrown for any malformed input — not a string, wrong segment count, or a
 *  segment that is not valid base64url-encoded JSON. */
export class InvalidTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidTokenError';
    // Restore the prototype chain for instanceof across the ES5 target.
    Object.setPrototypeOf(this, InvalidTokenError.prototype);
  }
}

/** The protected header of a JWT (the first segment). */
export interface JwtHeader {
  /** Signing algorithm, e.g. `RS256`. `none` means the token is unsigned. */
  alg: string;
  /** Media type, typically `JWT` (or `logout+jwt` for a logout token). */
  typ?: string;
  /** Key id — which instance signing key to verify against. */
  kid?: string;
  [key: string]: unknown;
}

/**
 * The decoded payload (the second segment), typed with Atlas's standard session
 * claim names (see `@atlas/core`'s `SessionClaims`). Every field is optional —
 * a decoder cannot assume any claim is present — and an index signature carries
 * registered claims (`exp`, `iat`, `nbf`, `jti`) and any custom/template claims.
 */
export interface AtlasJwtPayload {
  /** Issuer — the instance Frontend-API origin. */
  iss?: string;
  /** Subject — the signed-in user's id (`user_…`). */
  sub?: string;
  /** Session id (`sess_…`). */
  sid?: string;
  /** Audience — the instance id the token is for. */
  aud?: string | string[];
  /** Authorized party — the origin the token was minted for. */
  azp?: string;
  /** Active organization id, present only when a session has one set. */
  org_id?: string;
  org_slug?: string;
  org_role?: string;
  org_permissions?: string[];
  /** Roles, when a JWT template surfaces them flat. */
  roles?: string[];
  /** Sessions version; bumped on sign-out-everywhere. */
  sv?: number;
  /** Whether a second factor was passed for this session. */
  mfa?: boolean;
  /** Authentication context (RFC 8176 / OIDC core). */
  auth_time?: number;
  amr?: string[];
  acr?: string;
  /** Expiry — seconds since the Unix epoch. */
  exp?: number;
  /** Issued-at — seconds since the Unix epoch. */
  iat?: number;
  /** Not-before — seconds since the Unix epoch. */
  nbf?: number;
  /** JWT id. */
  jti?: string;
  [claim: string]: unknown;
}

/** The three decoded parts of a JWT. `signature` is the raw (still base64url)
 *  third segment — this package never decodes or verifies it. */
export interface DecodedJwt<P = AtlasJwtPayload> {
  header: JwtHeader;
  payload: P;
  /** The raw base64url signature segment, or `''` for an unsecured JWT. */
  signature: string;
}

/**
 * Decode a base64url segment to its UTF-8 string, working in both the browser
 * (`atob`) and Node (`Buffer`) with no polyfill and no dependency.
 */
function base64UrlToString(segment: string): string {
  if (!/^[A-Za-z0-9_-]*$/.test(segment)) {
    throw new InvalidTokenError('Token segment is not valid base64url.');
  }
  // base64url -> base64, then pad to a multiple of 4.
  let b64 = segment.replace(/-/g, '+').replace(/_/g, '/');
  const remainder = b64.length % 4;
  if (remainder === 1) {
    throw new InvalidTokenError('Token segment has an invalid length.');
  }
  if (remainder) b64 += '='.repeat(4 - remainder);

  // Decode to raw bytes, then UTF-8 decode so multibyte claims survive.
  let bytes: Uint8Array;
  const g = globalThis as {
    atob?: (data: string) => string;
    Buffer?: { from(data: string, enc: string): { [i: number]: number; length: number } };
  };
  try {
    if (typeof g.atob === 'function') {
      const binary = g.atob(b64);
      bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    } else if (typeof g.Buffer !== 'undefined') {
      const buf = g.Buffer.from(b64, 'base64');
      bytes = new Uint8Array(buf.length);
      for (let i = 0; i < buf.length; i++) bytes[i] = buf[i] as number;
    } else {
      throw new InvalidTokenError('No base64 decoder (atob/Buffer) is available.');
    }
  } catch (err) {
    if (err instanceof InvalidTokenError) throw err;
    throw new InvalidTokenError('Token segment could not be base64url-decoded.');
  }

  if (typeof TextDecoder !== 'undefined') {
    return new TextDecoder('utf-8').decode(bytes);
  }
  // Fallback: Latin-1-safe reconstruction (no multibyte), good enough for ASCII.
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i] as number);
  return out;
}

function parseSegment(segment: string, what: string): Record<string, unknown> {
  const json = base64UrlToString(segment);
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new InvalidTokenError(`Token ${what} is not valid JSON.`);
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InvalidTokenError(`Token ${what} is not a JSON object.`);
  }
  return value as Record<string, unknown>;
}

/**
 * Decode a JWT into its `{ header, payload, signature }` parts WITHOUT verifying
 * the signature. Throws {@link InvalidTokenError} when `token` is not a string
 * or does not have three `.`-separated segments, or when the header/payload is
 * not base64url-encoded JSON.
 *
 * The signature is returned as its raw base64url segment, never decoded.
 */
export function decodeJwt<P = AtlasJwtPayload>(token: string): DecodedJwt<P> {
  if (typeof token !== 'string') {
    throw new InvalidTokenError('Token must be a string.');
  }
  const parts = token.split('.');
  // A JWS has three segments (header.payload.signature). An unsecured JWT
  // (alg:none) carries an empty third segment, which still splits to three.
  if (parts.length !== 3) {
    throw new InvalidTokenError(
      `Token must have 3 segments separated by '.', found ${parts.length}.`,
    );
  }
  const [headerSeg, payloadSeg, signatureSeg] = parts as [string, string, string];
  if (headerSeg === '' || payloadSeg === '') {
    throw new InvalidTokenError('Token header and payload must not be empty.');
  }

  const header = parseSegment(headerSeg, 'header') as JwtHeader;
  const payload = parseSegment(payloadSeg, 'payload') as P;
  return { header, payload, signature: signatureSeg };
}

/**
 * Decode and return only the payload claims — the common case. Equivalent to
 * `decodeJwt(token).payload`. Throws {@link InvalidTokenError} on malformed
 * input.
 */
export function jwtClaims<P = AtlasJwtPayload>(token: string): P {
  return decodeJwt<P>(token).payload;
}

/**
 * Whether the token is expired, read from its `exp` claim (seconds since the
 * epoch). `leewaySec` extends validity by that many seconds to tolerate clock
 * skew — the token counts as expired only once `now > exp + leewaySec`.
 *
 * Throws {@link InvalidTokenError} when the token is malformed or carries no
 * numeric `exp` (expiry cannot be determined, so a caller must not silently
 * treat it as valid).
 *
 * @param token     the JWT to inspect
 * @param leewaySec clock-skew allowance in seconds (default `0`)
 * @param nowMs     current time in ms; defaults to `Date.now()` (for testing)
 */
export function jwtExpired(token: string, leewaySec = 0, nowMs: number = Date.now()): boolean {
  const { exp } = decodeJwt(token).payload;
  if (typeof exp !== 'number' || !Number.isFinite(exp)) {
    throw new InvalidTokenError('Token has no numeric `exp` claim.');
  }
  const nowSec = Math.floor(nowMs / 1000);
  return nowSec > exp + leewaySec;
}
