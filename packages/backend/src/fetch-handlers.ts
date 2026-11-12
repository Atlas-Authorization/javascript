/**
 * Framework-neutral handlers for Atlas webhooks and the `before_user_create` hook
 * (web-standard `Request` / `Response`; Node and Edge runtimes).
 *
 * ```ts
 * // any server: a POST route at your webhook path
 * import { createWebhookHandler, memoryDedupeStore } from '@atlasauth/backend';
 * const handler = createWebhookHandler({
 *   secret: process.env.ATLAS_WEBHOOK_SECRET,
 *   store: memoryDedupeStore(),
 *   onEvent: async (event) => { ... },
 * });
 * // handler(request: Request): Promise<Response>
 * ```
 */
import { WebhookVerificationError, memoryWebhookStore, sqlWebhookDedupeStore, verifyAndDedupe, type WebhookDedupeStore } from './webhook-dedupe';
import { verifyAtlasWebhookRequest } from './webhooks-web';
import type { AtlasWebhookEvent } from './webhook-events';

export { memoryWebhookStore as memoryDedupeStore, sqlWebhookDedupeStore as sqlDedupeStore };
export type { WebhookDedupeStore };

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

const missingSecret = (name: string) =>
  json(503, { error: 'webhook_secret_missing', message: `${name} has no signing secret configured; set \`secret\` (the endpoint's signing secret from Atlas).` });

/** The signed delivery: narrow on `type` and `data` is typed (`event.type === 'user.created'` gives the user). */
export type WebhookEnvelope = AtlasWebhookEvent;

export interface WebhookHandlerOptions {
  /** The endpoint's signing secret. Missing or empty answers 503 (never accepts unsigned input). */
  secret: string | undefined;
  /** Called once per event. Throwing releases the dedupe entry and answers 500 so Atlas retries. */
  onEvent: (event: WebhookEnvelope, ctx: { deliveryId: string }) => void | Promise<void>;
  /** Remembers delivery ids. Default: in-process memory; use `sqlDedupeStore` or your own when you run several instances. */
  store?: WebhookDedupeStore;
  /** Also call `onEvent` for Atlas's `webhook.test` delivery. Default false: it is answered with 200 and not passed on. */
  handleTest?: boolean;
  /** The exact URL Atlas posts to; also checks `v2` signatures. */
  url?: string;
}

/** A `POST` route handler that verifies, dedupes by event id and runs `onEvent`. */
export function createWebhookHandler(options: WebhookHandlerOptions): (request: Request) => Promise<Response> {
  const store = options.store ?? memoryWebhookStore();
  return async (request) => {
    if (!options.secret) return missingSecret('createWebhookHandler');
    let result;
    try {
      result = await verifyAndDedupe<WebhookEnvelope>(request, { secret: options.secret, store, url: options.url });
    } catch (e) {
      if (e instanceof WebhookVerificationError) return json(400, { error: 'invalid_webhook', reason: e.reason });
      return json(500, { error: 'webhook_store_failed' });
    }
    const { event, duplicate, deliveryId, release } = result;
    if (duplicate) return json(200, { received: true, duplicate: true });
    if (event.type === 'webhook.test' && !options.handleTest) return json(200, { received: true, test: true });
    try {
      await options.onEvent(event, { deliveryId });
    } catch {
      await release().catch(() => {});
      return json(500, { error: 'handler_failed' });
    }
    return json(200, { received: true });
  };
}

export interface BeforeUserCreateHandlerOptions {
  /** The hook's signing secret. Missing or empty answers 503. */
  secret: string | undefined;
  /** Your own id for the new user. Not called for Atlas's test call. Throwing answers 500 (Atlas then lets the sign-up through unless the hook is `fail_closed`). */
  externalId: () => string | Promise<string>;
}

/** A `POST` route handler for the `before_user_create` hook, answering `{ external_id }`. */
export function createBeforeUserCreateHandler(options: BeforeUserCreateHandlerOptions): (request: Request) => Promise<Response> {
  return async (request) => {
    if (!options.secret) return missingSecret('createBeforeUserCreateHandler');
    const res = await verifyAtlasWebhookRequest<{ test?: boolean; type?: string }>(request, { secret: options.secret });
    if (!res.verified || !res.event) return json(401, { error: 'invalid_signature', reason: res.reason ?? 'invalid_body' });
    // A test call (`test: true` / `atlas-test` header) reserves nothing: answer a valid, empty decision.
    if (res.event.test === true || request.headers.get('atlas-test')) return json(200, {});
    let external_id: string;
    try {
      external_id = await options.externalId();
    } catch {
      return json(500, { error: 'external_id_failed' });
    }
    return json(200, { external_id });
  };
}
