/**
 * Route handlers for Atlas webhooks and the `before_user_create` hook, for the
 * App Router (web-standard `Request` / `Response`; Node and Edge runtimes). The
 * implementation is framework-neutral and lives in `@atlasauth/backend`.
 *
 * ```ts
 * // app/api/atlas/webhooks/route.ts
 * import { createWebhookHandler, memoryDedupeStore } from '@atlasauth/nextjs';
 * export const POST = createWebhookHandler({
 *   secret: process.env.ATLAS_WEBHOOK_SECRET,
 *   store: memoryDedupeStore(),
 *   onEvent: async (event) => { ... },
 * });
 *
 * // app/api/atlas/hooks/before-user-create/route.ts
 * export const POST = createBeforeUserCreateHandler({
 *   secret: process.env.ATLAS_HOOK_SECRET,
 *   externalId: () => crypto.randomUUID(),
 * });
 * ```
 */
export {
  createWebhookHandler,
  createBeforeUserCreateHandler,
  memoryDedupeStore,
  sqlDedupeStore,
  type WebhookDedupeStore,
  type WebhookEnvelope,
  type WebhookHandlerOptions,
  type BeforeUserCreateHandlerOptions,
} from '@atlasauth/backend';
