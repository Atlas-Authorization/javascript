/** What both Atlas webhook verifiers share: headers, constants, the result shape and the options. No Node APIs. */
export const SIGNATURE_VERSION = 'v1';
export const REPLAY_TOLERANCE_MS = 5 * 60_000;

/** Header names Atlas sends on every delivery (lower-case; match case-insensitively). */
export const ATLAS_WEBHOOK_HEADERS = {
  id: 'atlas-id',
  timestamp: 'atlas-timestamp',
  signature: 'atlas-signature',
} as const;

export type WebhookVerifyFailure =
  | 'missing_headers'
  | 'malformed_signature'
  | 'stale_timestamp'
  | 'signature_mismatch';

export interface WebhookVerifyResult<T = unknown> {
  /** True only when the signature and timestamp both check out. */
  verified: boolean;
  /** Why verification failed, when it did. */
  reason?: WebhookVerifyFailure;
  /** The parsed event envelope `{ id, type, timestamp, instance_id, data }` — present only when `verified`. */
  event?: T;
  /**
   * The signed `atlas-id` header — present only when `verified`. It is the same
   * on every retry of one event, so it is the key to deduplicate deliveries on.
   */
  deliveryId?: string;
  /** The signed `atlas-timestamp` header (epoch ms) of this attempt — present only when `verified`. */
  timestamp?: number;
}

/** Read a header case-insensitively from a plain object or a Fetch `Headers`. */
export function readHeader(headers: HeadersLike, name: string): string | undefined {
  if (typeof (headers as Headers).get === 'function') {
    return (headers as Headers).get(name) ?? undefined;
  }
  const bag = headers as Record<string, string | string[] | undefined>;
  const direct = bag[name] ?? bag[name.toLowerCase()];
  const v = Array.isArray(direct) ? direct[0] : direct;
  if (v !== undefined) return v;
  // Fall back to a case-insensitive scan (Node lower-cases, but be safe).
  const hit = Object.keys(bag).find((k) => k.toLowerCase() === name);
  const found = hit ? bag[hit] : undefined;
  return Array.isArray(found) ? found[0] : found;
}

/**
 * The `v1` signatures in an `atlas-signature` header. The header carries one
 * `v1,<base64>` entry, or several separated by spaces (while an endpoint
 * secret rotates, Atlas signs with the old and the new secret). Entries of
 * another version are skipped, so a future scheme never breaks this verifier.
 */
export function parseSignatures(header: string, version: string = SIGNATURE_VERSION): string[] {
  const out: string[] = [];
  for (const entry of header.trim().split(/\s+/)) {
    const comma = entry.indexOf(',');
    if (comma <= 0) continue;
    const value = entry.slice(comma + 1);
    if (entry.slice(0, comma) === version && value) out.push(value);
  }
  return out;
}

export type HeadersLike = Headers | Record<string, string | string[] | undefined>;

export interface WebhookVerifyOptions {
  /** The request headers (a plain object, Node `req.headers`, or a Fetch `Headers`). */
  headers: HeadersLike;
  /** The endpoint's signing secret (shown once when the endpoint was created/rotated). */
  secret: string;
  /** Override "now" (tests); defaults to the current time. */
  now?: Date;
  /** Override the ±replay tolerance (defaults to 5 minutes). */
  toleranceMs?: number;
  /**
   * The exact URL Atlas POSTed to (your endpoint's `url`). When given, `v2`
   * signature entries — which also cover the URL, for endpoints with
   * `signature_versions` including `v2` — are checked too.
   */
  url?: string;
  /** Accept only a `v2` entry (needs `url`): a delivery replayed to another URL then fails. */
  requireV2?: boolean;
}
