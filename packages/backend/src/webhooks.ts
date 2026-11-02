import { createHmac, timingSafeEqual } from './edge-crypto';
import {
  ATLAS_WEBHOOK_HEADERS,
  REPLAY_TOLERANCE_MS,
  parseSignatures,
  readHeader,
  type HeadersLike,
  type WebhookVerifyOptions,
  type WebhookVerifyResult,
} from './webhook-common';

export { ATLAS_WEBHOOK_HEADERS } from './webhook-common';
export type { WebhookVerifyFailure, WebhookVerifyOptions, WebhookVerifyResult } from './webhook-common';
// The Web-standards verifier lives in its own module (the rp entry loads only that one).
export { verifyAtlasWebhook, verifyAtlasWebhookRequest } from './webhooks-web';
export type { VerifyAtlasWebhookInput } from './webhooks-web';

/**
 * §12.2 — verify an inbound Atlas webhook, for the CUSTOMER consuming events.
 *
 * Atlas signs every delivery: `atlas-signature: v1,<base64>` is HMAC-SHA256 over
 * `<id>.<timestamp>.<rawBody>` keyed with the endpoint secret, with `atlas-id`
 * and `atlas-timestamp` (epoch ms) headers. The timestamp is INSIDE the signed
 * material — a header-only timestamp would let an attacker replay a captured
 * body under a fresh timestamp — and a delivery older than 5 minutes is rejected
 * so a captured request cannot be replayed later. The header may carry several
 * space-separated `v1,<base64>` entries (one per secret while a secret rotates
 * with an overlap); the delivery verifies when any one of them matches.
 *
 * The signing logic is identical to the server's (`@atlas/core` `verifyWebhook`),
 * reimplemented here with zero dependencies so an integrator gets a first-party
 * verifier without pulling in Atlas internals. Verify over the RAW request body,
 * BEFORE any JSON parse — re-serializing reorders keys and breaks the MAC.
 */

export interface VerifyWebhookInput extends WebhookVerifyOptions {
  /** The RAW request body as received — a string or Buffer, NOT a parsed object. */
  body: string | Buffer;
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

  const provided = input.requireV2 ? [] : parseSignatures(signature);
  const providedV2 = input.url ? parseSignatures(signature, 'v2') : [];
  if (provided.length === 0 && providedV2.length === 0) return { verified: false, reason: 'malformed_signature' };

  const timestamp = Number(timestampRaw);
  const now = (input.now ?? new Date()).getTime();
  const tolerance = input.toleranceMs ?? REPLAY_TOLERANCE_MS;
  // Rejected in both directions: a far-future timestamp is as suspicious as a
  // stale one — accepting it would let an attacker mint a long-lived replay.
  if (!Number.isFinite(timestamp) || Math.abs(now - timestamp) > tolerance) {
    return { verified: false, reason: 'stale_timestamp' };
  }

  const expected = Buffer.from(
    createHmac('sha256', input.secret).update(`${id}.${timestamp}.${raw}`).digest('base64'),
  );
  // Compare every entry (no early exit), each in constant time.
  let matched = false;
  for (const candidate of provided) {
    const a = Buffer.from(candidate);
    if (a.length === expected.length && timingSafeEqual(a, expected)) matched = true;
  }
  if (input.url) {
    const expectedV2 = Buffer.from(
      createHmac('sha256', input.secret).update(`${id}.${timestamp}.${input.url}.${raw}`).digest('base64'),
    );
    for (const candidate of providedV2) {
      const a = Buffer.from(candidate);
      if (a.length === expectedV2.length && timingSafeEqual(a, expectedV2)) matched = true;
    }
  }
  if (!matched) return { verified: false, reason: 'signature_mismatch' };

  try {
    return { verified: true, event: JSON.parse(raw) as T, deliveryId: id, timestamp };
  } catch {
    // Signature is valid but the body isn't JSON — surface it as verified with no event.
    return { verified: true, deliveryId: id, timestamp };
  }
}

/** Standard Webhooks header names, as application webhooks send them (lower-case). */
export const STANDARD_WEBHOOK_HEADERS = {
  id: 'webhook-id',
  timestamp: 'webhook-timestamp',
  signature: 'webhook-signature',
} as const;

export interface VerifyStandardWebhookInput {
  /** The RAW request body as received — a string or Buffer, NOT a parsed object. */
  body: string | Buffer;
  headers: HeadersLike;
  /** The endpoint's `whsec_…` secret. */
  secret: string;
  now?: Date;
  /** Override the ±replay tolerance in seconds (default 300). */
  toleranceSec?: number;
}

/**
 * Verify an APPLICATION webhook (the events an app publishes to its customers'
 * endpoints through Atlas): Standard Webhooks — `webhook-id`,
 * `webhook-timestamp` (seconds), `webhook-signature: v1,<base64>` (one entry
 * per secret during a rotation), HMAC-SHA256 over `<id>.<timestamp>.<rawBody>`
 * keyed with the base64-decoded part of `whsec_<base64>`. Any Standard Webhooks
 * library verifies the same deliveries; this one has no dependencies. Never
 * throws: `{ verified, reason?, event?, deliveryId?, timestamp? }`, where
 * `deliveryId` (the `webhook-id`) is stable across retries — dedupe on it.
 *
 * ```ts
 * const { verified, event } = verifyStandardWebhook({ body: rawBody, headers: req.headers, secret: 'whsec_…' });
 * ```
 */
export function verifyStandardWebhook<T = unknown>(input: VerifyStandardWebhookInput): WebhookVerifyResult<T> {
  const raw = typeof input.body === 'string' ? input.body : input.body.toString('utf8');
  const id = readHeader(input.headers, STANDARD_WEBHOOK_HEADERS.id);
  const timestampRaw = readHeader(input.headers, STANDARD_WEBHOOK_HEADERS.timestamp);
  const signature = readHeader(input.headers, STANDARD_WEBHOOK_HEADERS.signature);
  if (!id || !timestampRaw || !signature) return { verified: false, reason: 'missing_headers' };

  const provided = parseSignatures(signature);
  if (provided.length === 0) return { verified: false, reason: 'malformed_signature' };

  const timestamp = /^\d+$/.test(timestampRaw) ? Number(timestampRaw) : NaN;
  const nowSec = Math.floor((input.now ?? new Date()).getTime() / 1000);
  if (!Number.isFinite(timestamp) || Math.abs(nowSec - timestamp) > (input.toleranceSec ?? REPLAY_TOLERANCE_MS / 1000)) {
    return { verified: false, reason: 'stale_timestamp' };
  }

  const key = Buffer.from(input.secret.startsWith('whsec_') ? input.secret.slice('whsec_'.length) : input.secret, 'base64');
  const expected = Buffer.from(createHmac('sha256', key).update(`${id}.${timestamp}.${raw}`).digest('base64'));
  let matched = false;
  for (const candidate of provided) {
    const a = Buffer.from(candidate);
    if (a.length === expected.length && timingSafeEqual(a, expected)) matched = true;
  }
  if (!matched) return { verified: false, reason: 'signature_mismatch' };
  try {
    return { verified: true, event: JSON.parse(raw) as T, deliveryId: id, timestamp };
  } catch {
    return { verified: true, deliveryId: id, timestamp };
  }
}
