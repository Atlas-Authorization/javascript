import { hmac } from '@noble/hashes/hmac';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';

/**
 * CSRF tokens bound to the Atlas session: `<nonce>.<mac>`, where the MAC is
 * HMAC-SHA256(secret, `<sid>.<nonce>`), both base64url. A token minted for one
 * session never verifies for another. The browser sends it back in the
 * `x-atlas-csrf` header (or an `atlas_csrf` form field) AND carries it in the
 * `__atlas_csrf` cookie (double submit): a cross-site page can trigger the
 * cookie but cannot read it to fill the header or field.
 *
 * Edge-safe: no `node:crypto`.
 */

export const CSRF_HEADER = 'x-atlas-csrf';
export const CSRF_FORM_FIELD = 'atlas_csrf';
export const CSRF_COOKIE = '__atlas_csrf';

export interface CsrfOptions {
  /** The session id (`sid` claim). */
  sid: string;
  /** A server secret: `ATLAS_CSRF_SECRET`, or {@link deriveCsrfSecret} of your secret key. */
  secret: string;
}

const enc = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function mac(secret: string, sid: string, nonce: string): string {
  return b64url(hmac(sha256, enc.encode(secret), enc.encode(`${sid}.${nonce}`)));
}

/** Compares every character whatever the lengths. */
function constantTimeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

function requireOptions({ sid, secret }: CsrfOptions): void {
  if (typeof sid !== 'string' || sid === '') throw new TypeError('csrf: sid is required');
  if (typeof secret !== 'string' || secret.length < 16) throw new TypeError('csrf: secret must be at least 16 characters');
}

/** Mint a fresh token for this session (a new random nonce each call). */
export function csrfToken(options: CsrfOptions): string {
  requireOptions(options);
  const nonce = b64url(globalThis.crypto.getRandomValues(new Uint8Array(16)));
  return `${nonce}.${mac(options.secret, options.sid, nonce)}`;
}

/** Whether `token` was minted for this session with this secret. */
export function checkCsrfToken(token: string | null | undefined, options: CsrfOptions): boolean {
  requireOptions(options);
  if (typeof token !== 'string') return false;
  const dot = token.indexOf('.');
  if (dot <= 0 || dot !== token.lastIndexOf('.')) return false;
  return constantTimeEqual(token.slice(dot + 1), mac(options.secret, options.sid, token.slice(0, dot)));
}

/**
 * A 32-byte CSRF secret derived from your instance secret key (HKDF-SHA256,
 * info `atlas-csrf-v1`), for when `ATLAS_CSRF_SECRET` isn't set. Rotating the
 * secret key invalidates outstanding tokens; browsers get a fresh one on their
 * next page load.
 */
export function deriveCsrfSecret(secretKey: string): string {
  if (typeof secretKey !== 'string' || secretKey === '') throw new TypeError('deriveCsrfSecret: secretKey is required');
  return b64url(hkdf(sha256, enc.encode(secretKey), undefined, enc.encode('atlas-csrf-v1'), 32));
}

/** Read one cookie from a `Cookie` header. */
export function readCookieValue(header: string | null | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      const raw = part.slice(eq + 1).trim();
      try {
        return decodeURIComponent(raw);
      } catch {
        return raw;
      }
    }
  }
  return undefined;
}

/** The request slice {@link verifyCsrf} reads (a Fetch `Request` / `NextRequest` fits). */
export interface CsrfRequest {
  headers: { get(name: string): string | null };
  clone?(): { formData(): Promise<{ get(name: string): unknown }> };
}

/**
 * Verify a state-changing request: the submitted token (`x-atlas-csrf` header,
 * else the `atlas_csrf` field of a urlencoded / multipart form) must equal the
 * `__atlas_csrf` cookie and be valid for `sid`. Reads a form body from a CLONE,
 * so your handler can still read it.
 */
export async function verifyCsrf(request: CsrfRequest, options: CsrfOptions): Promise<boolean> {
  requireOptions(options);
  const cookie = readCookieValue(request.headers.get('cookie'), CSRF_COOKIE);
  if (!cookie) return false;
  let submitted: string | null = request.headers.get(CSRF_HEADER);
  if (submitted === null) {
    const type = (request.headers.get('content-type') ?? '').toLowerCase();
    if (request.clone && (type.startsWith('application/x-www-form-urlencoded') || type.startsWith('multipart/form-data'))) {
      try {
        const field = (await request.clone().formData()).get(CSRF_FORM_FIELD);
        submitted = typeof field === 'string' ? field : null;
      } catch {
        submitted = null;
      }
    }
  }
  if (submitted === null || !constantTimeEqual(submitted, cookie)) return false;
  return checkCsrfToken(submitted, options);
}
