import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * How Atlas signs a call to a Referalli-style connection API, and how a
 * receiver verifies it.
 *
 *  `x-referalli-signature: t=<unix seconds>,v1=<hex>,v2=<hex>`, each a hex
 *  HMAC-SHA256 keyed with the connection secret:
 *   - v1 over "{t}.{payload}": the raw body of a POST, or the raw query string
 *     (after `?`, empty when none) of a GET;
 *   - v2 over "{t}.{METHOD}.{path?query}.{body}" (body empty for a GET), which
 *     binds the request to its endpoint.
 *  The legacy `x-referally-signature` / `x-referally-id` / `referally-version`
 *  headers carry the same values. Every attempt has a fresh `x-referalli-id`.
 */

export const REFERALLI_VERSION = '2026-10-21';

const hmac = (secret: string, material: string) => createHmac('sha256', secret).update(material).digest('hex');

export interface SignParts {
  secret: string;
  timestampSeconds: number;
  method: 'GET' | 'POST';
  /** The request path with its query string, e.g. `/v1/auth/connections/c/export?customerRef=u`. */
  pathAndQuery: string;
  /** The raw POST body, or the raw GET query string (empty when none). */
  payload: string;
}

/** The v1-only signature value. */
export function signatureV1(secret: string, timestampSeconds: number, payload: string): string {
  return `t=${timestampSeconds},v1=${hmac(secret, `${timestampSeconds}.${payload}`)}`;
}

/** The full signature header: v1 and v2 together. */
export function signatureHeader(parts: SignParts): string {
  const body = parts.method === 'GET' ? '' : parts.payload;
  const v2 = hmac(parts.secret, `${parts.timestampSeconds}.${parts.method}.${parts.pathAndQuery}.${body}`);
  return `${signatureV1(parts.secret, parts.timestampSeconds, parts.payload)},v2=${v2}`;
}

export interface VerifyInput {
  secret: string;
  method: string;
  pathAndQuery: string;
  /** The raw body (POST) or raw query string (GET). */
  payload: string;
  /** The `x-referalli-signature` (or legacy `x-referally-signature`) header value. */
  header: string | undefined;
  /** Epoch ms; default now. */
  now?: number;
  /** Seconds either way; default 300. */
  toleranceSeconds?: number;
}

export type VerifyResult =
  | { ok: true; version: 'v1' | 'v2'; timestampSeconds: number }
  | { ok: false; reason: 'missing' | 'malformed' | 'stale' | 'mismatch' };

const safeEqual = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/**
 * Verify a signed request. Prefers v2 (which binds the endpoint); a request
 * carrying only v1 verifies as v1. A receiver that has switched a connection to
 * v2 should refuse `version: 'v1'`.
 */
export function verifyRequest(input: VerifyInput): VerifyResult {
  if (!input.header) return { ok: false, reason: 'missing' };
  const parts = Object.fromEntries(
    input.header.split(',').map((p) => {
      const i = p.indexOf('=');
      return [p.slice(0, i).trim(), p.slice(i + 1).trim()];
    }),
  ) as Record<string, string>;
  const t = Number(parts.t);
  if (!Number.isInteger(t) || (!parts.v1 && !parts.v2)) return { ok: false, reason: 'malformed' };
  const tolerance = input.toleranceSeconds ?? 300;
  if (Math.abs((input.now ?? Date.now()) / 1000 - t) > tolerance) return { ok: false, reason: 'stale' };
  const method = input.method.toUpperCase();
  if (method !== 'GET' && method !== 'POST') return { ok: false, reason: 'malformed' };
  if (parts.v2) {
    const expected = hmac(input.secret, `${t}.${method}.${input.pathAndQuery}.${method === 'GET' ? '' : input.payload}`);
    if (safeEqual(parts.v2, expected)) return { ok: true, version: 'v2', timestampSeconds: t };
    return { ok: false, reason: 'mismatch' };
  }
  const expected = hmac(input.secret, `${t}.${input.payload}`);
  return safeEqual(parts.v1!, expected) ? { ok: true, version: 'v1', timestampSeconds: t } : { ok: false, reason: 'mismatch' };
}

/** Standard Webhooks signature for an event Referalli sends Atlas: `v1,<base64 HMAC-SHA256(id.timestamp.body)>`. */
export function standardWebhookSignature(secret: string, id: string, timestampSeconds: number, rawBody: string): string {
  const key = secret.startsWith('whsec_') ? Buffer.from(secret.slice('whsec_'.length), 'base64') : Buffer.from(secret);
  return `v1,${createHmac('sha256', key).update(`${id}.${timestampSeconds}.${rawBody}`).digest('base64')}`;
}
