import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * §12.2 — verify an inbound Atlas webhook, for the CUSTOMER consuming events.
 *
 * Atlas signs every delivery: `atlas-signature: v1,<base64>` is HMAC-SHA256 over
 * `<id>.<timestamp>.<rawBody>` keyed with the endpoint secret, with `atlas-id`
 * and `atlas-timestamp` (epoch ms) headers. The timestamp is INSIDE the signed
 * material — a header-only timestamp would let an attacker replay a captured
 * body under a fresh timestamp — and a delivery older than 5 minutes is rejected
 * so a captured request cannot be replayed later.
 *
 * The signing logic is identical to the server's (`@atlas/core` `verifyWebhook`),
 * reimplemented here with zero dependencies so an integrator gets a first-party
 * verifier without pulling in Atlas internals. Verify over the RAW request body,
 * BEFORE any JSON parse — re-serializing reorders keys and breaks the MAC.
 */

const SIGNATURE_VERSION = 'v1';
const REPLAY_TOLERANCE_MS = 5 * 60_000;

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
function readHeader(headers: HeadersLike, name: string): string | undefined {
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

type HeadersLike = Headers | Record<string, string | string[] | undefined>;

export interface VerifyWebhookInput {
  /** The RAW request body as received — a string or Buffer, NOT a parsed object. */
  body: string | Buffer;
  /** The request headers (a plain object, Node `req.headers`, or a Fetch `Headers`). */
  headers: HeadersLike;
  /** The endpoint's signing secret (shown once when the endpoint was created/rotated). */
  secret: string;
  /** Override "now" (tests); defaults to the current time. */
  now?: Date;
  /** Override the ±replay tolerance (defaults to 5 minutes). */
  toleranceMs?: number;
}

/**
 * Verify and parse an Atlas webhook. Returns `{ verified, reason?, event?,
 * deliveryId?, timestamp? }` — it never throws on a bad signature (a thrown
 * verifier is easy to accidentally swallow). On success, `event` is the parsed
 * envelope, `deliveryId` the signed `atlas-id` (stable across retries: dedupe on
 * it) and `timestamp` the signed `atlas-timestamp`.
 *
 * ```ts
 * // Express (raw body):
 * app.post('/webhooks/atlas', express.raw({ type: 'application/json' }), async (req, res) => {
 *   const { verified, event, deliveryId } = verifyWebhook({ body: req.body, headers: req.headers, secret });
 *   if (!verified) return res.sendStatus(400);
 *   if (await seen.has(deliveryId)) return res.sendStatus(200); // a retry we already handled
 *   // handle event.type ...
 *   await seen.add(deliveryId);
 *   res.sendStatus(200);
 * });
 * ```
 */
export function verifyWebhook<T = unknown>(input: VerifyWebhookInput): WebhookVerifyResult<T> {
  const raw = typeof input.body === 'string' ? input.body : input.body.toString('utf8');
  const id = readHeader(input.headers, ATLAS_WEBHOOK_HEADERS.id);
  const timestampRaw = readHeader(input.headers, ATLAS_WEBHOOK_HEADERS.timestamp);
  const signature = readHeader(input.headers, ATLAS_WEBHOOK_HEADERS.signature);
  if (!id || !timestampRaw || !signature) return { verified: false, reason: 'missing_headers' };

  const [version, provided] = signature.split(',');
  if (version !== SIGNATURE_VERSION || !provided) return { verified: false, reason: 'malformed_signature' };

  const timestamp = Number(timestampRaw);
  const now = (input.now ?? new Date()).getTime();
  const tolerance = input.toleranceMs ?? REPLAY_TOLERANCE_MS;
  // Rejected in both directions: a far-future timestamp is as suspicious as a
  // stale one — accepting it would let an attacker mint a long-lived replay.
  if (!Number.isFinite(timestamp) || Math.abs(now - timestamp) > tolerance) {
    return { verified: false, reason: 'stale_timestamp' };
  }

  const expected = createHmac('sha256', input.secret).update(`${id}.${timestamp}.${raw}`).digest('base64');
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { verified: false, reason: 'signature_mismatch' };

  try {
    return { verified: true, event: JSON.parse(raw) as T, deliveryId: id, timestamp };
  } catch {
    // Signature is valid but the body isn't JSON — surface it as verified with no event.
    return { verified: true, deliveryId: id, timestamp };
  }
}
