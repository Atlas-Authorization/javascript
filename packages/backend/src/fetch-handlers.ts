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
import { WebhookVerificationError, memoryDedupeStore, verifyAndDedupe, type WebhookDedupeStore } from './webhook-dedupe';
import { verifyAtlasWebhookRequest } from './webhooks-web';
import type { AtlasWebhookEvent } from './webhook-events';


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
  /** Remembers delivery ids. Default: in-process memory; use `sqlDedupeStore`, `redisDedupeStore` or your own when you run several instances. */
  store?: WebhookDedupeStore;
  /** `false` skips dedupe entirely (your `onEvent` is idempotent). Default true. */
  dedupe?: boolean;
  /** Also call `onEvent` for Atlas's `webhook.test` delivery. Default false: it is answered with 200 and not passed on. */
  handleTest?: boolean;
  /** The exact URL Atlas posts to; also checks `v2` signatures. */
  url?: string;
}

/** A `POST` route handler that verifies, dedupes by event id and runs `onEvent`. */
export function createWebhookHandler(options: WebhookHandlerOptions): (request: Request) => Promise<Response> {
  const store = options.store ?? memoryDedupeStore();
  return async (request) => {
    if (!options.secret) return missingSecret('createWebhookHandler');
    let result;
    try {
      result = await verifyAndDedupe<WebhookEnvelope>(
        request,
        options.dedupe === false ? { secret: options.secret, dedupe: false, url: options.url } : { secret: options.secret, store, url: options.url },
      );
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

/** The user Atlas is about to mint a first session for, as the `beforeFirstSession` hook sends it. */
export interface LinkCandidate {
  user_id: string;
  email: string | null;
  email_verified: boolean;
  /** `null` for email/password and passkey sign-ins. */
  provider: string | null;
  provider_user_id: string | null;
  name: string | null;
  /** The user's current `external_id`, when one is already set. */
  external_id: string | null;
}

export interface LinkHookOptions {
  /** The hook's signing secret. Missing or empty answers 503. */
  secret: string | undefined;
  /**
   * Decide the user's `external_id` (your own account id) from the verified candidate, or `{}` to leave it unset.
   * Atlas only applies it when the user has none yet and no other user already holds it. Throwing answers 500
   * and the sign-in goes on without a link.
   */
  resolve: (candidate: LinkCandidate) => { external_id?: string } | void | Promise<{ external_id?: string } | void>;
}

/**
 * A `POST` route handler for the `beforeFirstSession` hook: Atlas calls it once per user, after the email is
 * verified and before the first session token is minted, so that token already carries `external_id`.
 */
export function createLinkHook(options: LinkHookOptions): (request: Request) => Promise<Response> {
  return async (request) => {
    if (!options.secret) return missingSecret('createLinkHook');
    const res = await verifyAtlasWebhookRequest<{ test?: boolean; type?: string; data?: Partial<LinkCandidate> }>(request, { secret: options.secret });
    if (!res.verified || !res.event) return json(401, { error: 'invalid_signature', reason: res.reason ?? 'invalid_body' });
    if (res.event.test === true || request.headers.get('atlas-test')) return json(200, {});
    const data = res.event.data;
    if (res.event.type !== 'before_first_session' || !data || typeof data.user_id !== 'string') {
      return json(400, { error: 'invalid_hook_body' });
    }
    const candidate: LinkCandidate = {
      user_id: data.user_id,
      email: data.email ?? null,
      email_verified: data.email_verified === true,
      provider: data.provider ?? null,
      provider_user_id: data.provider_user_id ?? null,
      name: data.name ?? null,
      external_id: data.external_id ?? null,
    };
    let out;
    try {
      out = await options.resolve(candidate);
    } catch {
      return json(500, { error: 'link_failed' });
    }
    const id = out && typeof out.external_id === 'string' && out.external_id !== '' ? out.external_id : undefined;
    return json(200, id === undefined ? {} : { external_id: id });
  };
}
