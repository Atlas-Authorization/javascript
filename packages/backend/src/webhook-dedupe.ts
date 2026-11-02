import { verifyAtlasWebhookRequest } from './webhooks-web';
import { verifyWebhook, type VerifyWebhookInput } from './webhooks';
import type { WebhookVerifyFailure, WebhookVerifyOptions, WebhookVerifyResult } from './webhook-common';

/**
 * Where seen delivery ids live. `setIfAbsent` must be atomic: it stores `key`
 * for `ttlSeconds` and resolves true when the key was NOT there, false when it
 * already was (Redis: `SET key 1 EX ttl NX`). `delete` is optional; with it, a
 * failed handler can release the id so Atlas's retry is processed.
 */
export interface WebhookDedupeStore {
  setIfAbsent(key: string, ttlSeconds: number): Promise<boolean>;
  delete?(key: string): Promise<void>;
}

/** A single-process store. Use a shared one (Redis, a database) when you run more than one instance. */
export function memoryWebhookStore(now: () => number = Date.now): WebhookDedupeStore {
  const seen = new Map<string, number>();
  return {
    async setIfAbsent(key, ttlSeconds) {
      const t = now();
      for (const [k, exp] of seen) if (exp <= t) seen.delete(k);
      if (seen.has(key)) return false;
      seen.set(key, t + ttlSeconds * 1000);
      return true;
    },
    async delete(key) {
      seen.delete(key);
    },
  };
}

export interface VerifyAndDedupeOptions extends Omit<WebhookVerifyOptions, 'headers'> {
  store: WebhookDedupeStore;
  /** How long a delivery id is remembered. Default 24 hours; keep it longer than your endpoint's retry window. */
  ttlSeconds?: number;
  /** Key prefix in the store. Default `atlas-webhook:`. */
  keyPrefix?: string;
  /** The exact URL Atlas POSTed to; checks `v2` signatures too. */
  url?: string;
  requireV2?: boolean;
}

export interface VerifyAndDedupeResult<T = unknown> {
  /** The parsed event envelope `{ id, type, timestamp, instance_id, data }`. */
  event: T;
  /** True when this `atlas-id` was already seen: acknowledge with 2xx and do nothing. */
  duplicate: boolean;
  /** The signed `atlas-id`, identical on every retry of one event. */
  deliveryId: string;
  /** Forget this delivery (only when the store supports `delete`) so a retry is processed, e.g. after your handler failed. */
  release(): Promise<void>;
}

export class WebhookVerificationError extends Error {
  constructor(readonly reason: WebhookVerifyFailure | 'invalid_body') {
    super(`Atlas webhook verification failed: ${reason}`);
    this.name = 'WebhookVerificationError';
  }
}

/**
 * Verify an Atlas webhook (signature and timestamp, exactly as
 * `verifyAtlasWebhookRequest`) and drop an event whose `atlas-id` was already
 * seen. Throws {@link WebhookVerificationError} for a delivery that does not
 * verify (answer 400/401); an unverified delivery never touches the store.
 */
export async function verifyAndDedupe<T = unknown>(
  request: Request,
  options: VerifyAndDedupeOptions,
): Promise<VerifyAndDedupeResult<T>> {
  const { store, ttlSeconds, keyPrefix, ...verify } = options;
  return dedupeVerified(await verifyAtlasWebhookRequest<T>(request, verify), { store, ttlSeconds, keyPrefix });
}

export interface VerifyWebhookAndDedupeInput extends VerifyWebhookInput {
  store: WebhookDedupeStore;
  ttlSeconds?: number;
  keyPrefix?: string;
}

/**
 * {@link verifyAndDedupe} for Node/Express: the RAW body and the request
 * headers, the same input as `verifyWebhook`.
 *
 * ```ts
 * app.post('/webhooks/atlas', express.raw({ type: 'application/json' }), async (req, res) => {
 *   const { event, duplicate } = await verifyWebhookAndDedupe({ body: req.body, headers: req.headers, secret, store });
 *   if (!duplicate) await handle(event);
 *   res.sendStatus(200);
 * });
 * ```
 */
export async function verifyWebhookAndDedupe<T = unknown>(
  input: VerifyWebhookAndDedupeInput,
): Promise<VerifyAndDedupeResult<T>> {
  const { store, ttlSeconds, keyPrefix, ...verify } = input;
  return dedupeVerified(verifyWebhook<T>(verify), { store, ttlSeconds, keyPrefix });
}

async function dedupeVerified<T>(
  res: WebhookVerifyResult<T>,
  o: { store: WebhookDedupeStore; ttlSeconds?: number; keyPrefix?: string },
): Promise<VerifyAndDedupeResult<T>> {
  const { store, ttlSeconds = 86_400, keyPrefix = 'atlas-webhook:' } = o;
  if (!res.verified || !res.deliveryId) throw new WebhookVerificationError(res.reason ?? 'signature_mismatch');
  if (res.event === undefined) throw new WebhookVerificationError('invalid_body');
  const key = `${keyPrefix}${res.deliveryId}`;
  const fresh = await store.setIfAbsent(key, ttlSeconds);
  return {
    event: res.event,
    duplicate: !fresh,
    deliveryId: res.deliveryId,
    release: async () => {
      await store.delete?.(key);
    },
  };
}
