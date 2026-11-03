import {
  ATLAS_WEBHOOK_HEADERS,
  REPLAY_TOLERANCE_MS,
  parseSignatures,
  readHeader,
  type WebhookVerifyOptions,
  type WebhookVerifyResult,
} from './webhook-common';
import type { AtlasWebhookEvent } from './webhook-events';

// ── Web-standards variant ──────────────────────────────────────────────────

export interface VerifyAtlasWebhookInput extends WebhookVerifyOptions {
  /** The RAW request body: the string or bytes exactly as received, never a parsed object. */
  body: string | Uint8Array | ArrayBuffer;
}

/**
 * The Node `verifyWebhook` on Web Crypto only (no `Buffer`, no `node:crypto`), so
 * it runs unchanged on Node 18+, Deno, Bun and Workers. Same signed material,
 * same 5-minute window in both directions, same `v1` / `v2` handling, same
 * result shape; never throws on a bad delivery.
 *
 * ```ts
 * const { verified, event, deliveryId } = await verifyAtlasWebhook({
 *   body: await request.text(), headers: request.headers, secret: env.ATLAS_WEBHOOK_SECRET,
 * });
 * ```
 */
export async function verifyAtlasWebhook<T = AtlasWebhookEvent>(input: VerifyAtlasWebhookInput): Promise<WebhookVerifyResult<T>> {
  const raw = typeof input.body === 'string' ? input.body : new TextDecoder().decode(input.body);
  const id = readHeader(input.headers, ATLAS_WEBHOOK_HEADERS.id);
  const timestampRaw = readHeader(input.headers, ATLAS_WEBHOOK_HEADERS.timestamp);
  const signature = readHeader(input.headers, ATLAS_WEBHOOK_HEADERS.signature);
  if (!id || !timestampRaw || !signature) return { verified: false, reason: 'missing_headers' };
  if (typeof input.secret !== 'string' || input.secret === '') return { verified: false, reason: 'signature_mismatch' };

  const provided = input.requireV2 ? [] : parseSignatures(signature);
  const providedV2 = input.url ? parseSignatures(signature, 'v2') : [];
  if (provided.length === 0 && providedV2.length === 0) return { verified: false, reason: 'malformed_signature' };

  const timestamp = Number(timestampRaw);
  const now = (input.now ?? new Date()).getTime();
  if (!Number.isFinite(timestamp) || Math.abs(now - timestamp) > (input.toleranceMs ?? REPLAY_TOLERANCE_MS)) {
    return { verified: false, reason: 'stale_timestamp' };
  }

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(input.secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = async (material: string) =>
    toBase64(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(material))));
  let matched = false;
  if (provided.length > 0) {
    const expected = await mac(`${id}.${timestamp}.${raw}`);
    for (const candidate of provided) if (constantTimeEqual(candidate, expected)) matched = true;
  }
  if (providedV2.length > 0) {
    const expected = await mac(`${id}.${timestamp}.${input.url}.${raw}`);
    for (const candidate of providedV2) if (constantTimeEqual(candidate, expected)) matched = true;
  }
  if (!matched) return { verified: false, reason: 'signature_mismatch' };
  try {
    return { verified: true, event: JSON.parse(raw) as T, deliveryId: id, timestamp };
  } catch {
    return { verified: true, deliveryId: id, timestamp };
  }
}

/**
 * {@link verifyAtlasWebhook} straight from a Fetch `Request` (Hono, Workers,
 * Deno, Bun, Next.js route handlers). Reads the body once, as text; do not
 * read it before calling this.
 */
export async function verifyAtlasWebhookRequest<T = AtlasWebhookEvent>(
  request: Request,
  options: Omit<VerifyAtlasWebhookInput, 'body' | 'headers'>,
): Promise<WebhookVerifyResult<T>> {
  return verifyAtlasWebhook<T>({ ...options, body: await request.text(), headers: request.headers });
}

function toBase64(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** Compares every byte whatever the lengths, so timing reveals neither where nor whether they differ early. */
function constantTimeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}
