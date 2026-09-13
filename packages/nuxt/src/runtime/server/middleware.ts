import { defineEventHandler } from 'h3';
import { getAtlasAuth } from './index';

/**
 * Global Nitro middleware — the Nuxt peer of the Next.js `atlasMiddleware`.
 *
 * It verifies the `__session` JWT once, up front, and stashes the result on
 * `event.context.auth`, so every downstream `defineEventHandler` (and any server
 * util) reads the same resolved auth without repeating the verify. It does NOT
 * enforce a route policy here — verification is local and cheap, but redirect /
 * 401 decisions belong to each route via `auth.protect(...)`, keeping the
 * middleware a pure "who is this" step rather than a "may they" one.
 */
export default defineEventHandler(async (event) => {
  await getAtlasAuth(event);
});
