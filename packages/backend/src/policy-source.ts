import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

/**
 * Atlas policy source protocol v1 — helpers for the system that SERVES an
 * Atlas instance's policy documents (a CMS, a docs platform, your own service).
 *
 *  Atlas → you:  GET {endpoint_url}/policies            (full feed)
 *                GET {endpoint_url}/policies?key=<key>  (one policy, after your event)
 *    signed with the source's signing secret: `atlas-id`, `atlas-timestamp`
 *    (epoch ms) and `atlas-signature: v1,<base64 HMAC-SHA256>` over
 *    `{atlas-id}.{atlas-timestamp}.GET\n{path+query}`. Verify it with
 *    {@link verifyPolicyFeedRequest}, then answer a {@link PolicyFeed}.
 *  You → Atlas:  POST {webhook_url} (from GET /v1/instance/policy_source), a
 *    {@link PolicySourceEvent} signed with the same secret —
 *    {@link signPolicySourceEvent} (Atlas-style) or any Standard Webhooks library.
 *    Atlas then re-fetches that policy; it never stores content from the event.
 */

export const POLICY_SOURCE_PROTOCOL_VERSION = '2026-10-24';
export const POLICY_SOURCE_VERSION_HEADER = 'atlas-policies-version';
const TOLERANCE_MS = 5 * 60_000;

export interface PolicyFeedVersion {
  version: string;
  /** Epoch ms or ISO 8601. */
  published_at?: number | string;
  /** When Atlas starts asking users for it (defaults to published_at). */
  effective_at?: number | string;
  /** One of content_html / content_markdown, or content_url for Atlas to snapshot. At most 512 KB. */
  content_html?: string;
  content_markdown?: string;
  content_url?: string;
  summary_of_changes?: string;
  locale?: string;
}

export interface PolicyFeedPolicy {
  /** Slug: lowercase letters, digits, `_` and `-`. */
  key: string;
  title: string;
  display?: 'checkbox' | 'scroll' | 'link';
  required?: boolean;
  applies_to?: 'sign_up' | 'sign_in_and_sign_up';
  versions: PolicyFeedVersion[];
}

/** The answer to `GET {endpoint_url}/policies`. */
export interface PolicyFeed {
  object: 'policy_list';
  policies: PolicyFeedPolicy[];
}

export type PolicySourceEvent =
  | { type: 'policy.published'; key: string; version: string; occurred_at?: string | number }
  | { type: 'policy.retired'; key: string; occurred_at?: string | number };

type HeadersLike = Headers | Record<string, string | string[] | undefined>;

function header(headers: HeadersLike, name: string): string | undefined {
  if (typeof (headers as Headers).get === 'function') return (headers as Headers).get(name) ?? undefined;
  const bag = headers as Record<string, string | string[] | undefined>;
  const direct = bag[name] ?? bag[Object.keys(bag).find((k) => k.toLowerCase() === name) ?? ''];
  return Array.isArray(direct) ? direct[0] : direct;
}

function mac(secret: string, id: string, timestamp: string, payload: string): Buffer {
  return createHmac('sha256', secret).update(`${id}.${timestamp}.${payload}`).digest();
}

export type PolicyFeedVerifyResult =
  | { verified: true; deliveryId: string; timestamp: number; key: string | null; protocolVersion: string | undefined }
  | { verified: false; reason: 'missing_headers' | 'malformed_signature' | 'stale_timestamp' | 'signature_mismatch' | 'wrong_method' };

/**
 * Verify Atlas's signed GET of your feed. Pass the request's path AND query
 * exactly as received (e.g. `req.originalUrl`), and the method.
 *
 * ```ts
 * app.get('/atlas/policies', (req, res) => {
 *   const v = verifyPolicyFeedRequest({ method: req.method, pathAndQuery: req.originalUrl, headers: req.headers, secret });
 *   if (!v.verified) return res.sendStatus(401);
 *   res.json(buildFeed(v.key)); // PolicyFeed, one policy when v.key is set
 * });
 * ```
 */
export function verifyPolicyFeedRequest(input: {
  method?: string;
  pathAndQuery: string;
  headers: HeadersLike;
  secret: string;
  now?: Date;
  toleranceMs?: number;
}): PolicyFeedVerifyResult {
  if (input.method && input.method.toUpperCase() !== 'GET') return { verified: false, reason: 'wrong_method' };
  const id = header(input.headers, 'atlas-id');
  const ts = header(input.headers, 'atlas-timestamp');
  const sig = header(input.headers, 'atlas-signature');
  if (!id || !ts || !sig) return { verified: false, reason: 'missing_headers' };
  const provided = sig
    .trim()
    .split(/\s+/)
    .filter((e) => e.startsWith('v1,'))
    .map((e) => Buffer.from(e.slice(3), 'base64'));
  if (provided.length === 0) return { verified: false, reason: 'malformed_signature' };
  const timestamp = Number(ts);
  const now = (input.now ?? new Date()).getTime();
  if (!Number.isFinite(timestamp) || Math.abs(now - timestamp) > (input.toleranceMs ?? TOLERANCE_MS)) {
    return { verified: false, reason: 'stale_timestamp' };
  }
  const expected = mac(input.secret, id, ts, `GET\n${input.pathAndQuery}`);
  const ok = provided.some((p) => p.length === expected.length && timingSafeEqual(p, expected));
  if (!ok) return { verified: false, reason: 'signature_mismatch' };
  let key: string | null = null;
  const q = input.pathAndQuery.indexOf('?');
  if (q !== -1) key = new URLSearchParams(input.pathAndQuery.slice(q + 1)).get('key');
  return { verified: true, deliveryId: id, timestamp, key, protocolVersion: header(input.headers, POLICY_SOURCE_VERSION_HEADER) };
}

/**
 * Sign an event for `POST {webhook_url}` (Atlas-style headers). Send `body`
 * byte-for-byte as returned.
 *
 * ```ts
 * const { body, headers } = signPolicySourceEvent({ event: { type: 'policy.published', key: 'tos', version: '2026-10-24' }, secret });
 * await fetch(webhookUrl, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });
 * ```
 */
export function signPolicySourceEvent(input: {
  event: PolicySourceEvent;
  secret: string;
  id?: string;
  timestampMs?: number;
}): { body: string; headers: Record<string, string> } {
  const body = JSON.stringify({ occurred_at: new Date().toISOString(), ...input.event });
  const id = input.id ?? `evt_${randomUUID()}`;
  const ts = String(input.timestampMs ?? Date.now());
  return {
    body,
    headers: {
      'atlas-id': id,
      'atlas-timestamp': ts,
      'atlas-signature': `v1,${mac(input.secret, id, ts, body).toString('base64')}`,
    },
  };
}
