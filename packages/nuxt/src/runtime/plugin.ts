import { createAtlas } from '@atlasauth/vue';
import { defineNuxtPlugin, useRuntimeConfig } from '#imports';

/**
 * The client plugin: installs the `@atlasauth/vue` plugin on Nuxt's Vue app.
 *
 * This is the Nuxt peer of calling `app.use(createAtlas(...))` in a plain Vue
 * app, and of wrapping the tree in `<AtlasProvider>` in React. It runs once per
 * app instance — which on the server means once per request, so each SSR render
 * gets its own reactive client and never shares auth state between two users
 * sharing the process (the exact leak `@atlasauth/vue`'s per-app `inject` avoids).
 *
 * `createAtlas` reads only the PUBLIC config (publishable key + FAPI origin).
 * The verification secrets stay server-side and are never referenced here, so
 * nothing secret is bundled into the client.
 */
export default defineNuxtPlugin((nuxtApp) => {
  const { atlas } = useRuntimeConfig().public;

  nuxtApp.vueApp.use(
    createAtlas({
      publishableKey: atlas.publishableKey,
      // Empty string → let @atlasauth/vue fall back to its default (same-origin FAPI).
      frontendApi: atlas.frontendApi || undefined,
    }),
  );
});
