/**
 * Serve the Atlas Frontend API under a path of your Next.js app (a path mount),
 * with no reverse proxy of your own: a catch-all App Router route forwards
 * `/<base>/…` to your instance's Frontend API host with the headers Atlas needs.
 *
 * ```ts
 * // app/atlas/[[...path]]/route.ts
 * import { createMountHandler } from '@atlasauth/nextjs';
 * export const { GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD } = createMountHandler({ basePath: '/atlas' });
 *
 * // app/.well-known/atlas-verify/[token]/route.ts
 * import { createVerifyHandler } from '@atlasauth/nextjs';
 * export const { GET } = createVerifyHandler();
 * ```
 *
 * Use a base path without a leading underscore (`/atlas`, not `/__atlas`): the
 * App Router treats `_folder` as private and never routes it.
 *
 * Web-standard only (`fetch`, `Headers`, `Response`), so it runs on the Node.js
 * and Edge runtimes.
 */

import { createMountHandler as createFetchMountHandler, createVerifyHandler, type AtlasMountHandlers, type AtlasMountOptions } from '@atlasauth/backend';
import { ATLAS_NEXTJS_VERSION } from './version';

export { createVerifyHandler, type AtlasMountHandlers, type AtlasMountOptions };

/**
 * App Router handlers that forward the mount to Atlas. The framework-neutral
 * implementation (header allow-lists, `clientIp` / `trustedProxyHops`, 503 without
 * config) is in `@atlasauth/backend`; this reports `@atlasauth/nextjs` as the SDK.
 */
export function createMountHandler(options: AtlasMountOptions = {}): AtlasMountHandlers {
  return createFetchMountHandler({ sdk: { name: '@atlasauth/nextjs', version: ATLAS_NEXTJS_VERSION }, ...options });
}
