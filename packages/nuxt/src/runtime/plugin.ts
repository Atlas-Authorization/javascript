import { resolveFrontendApi } from '@atlasauth/js';
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

  // Validated HERE, at runtime, not in the module's `setup()`: the value may
  // only arrive through `NUXT_PUBLIC_ATLAS_FRONTEND_API` when the server starts,
  // after the build. Checked up front (rather than left to `createAtlas()`) so
  // the error names the Nuxt config key and env var the developer actually
  // sets. The module's runtimeConfig placeholder is `""`, which — like an
  // explicit `""` — still means same-origin for backward compatibility, with a
  // one-time deprecation warning pointing at `"same-origin"`; a malformed value
  // throws `AtlasConfigError`.
  resolveFrontendApi(atlas.frontendApi, {
    component: '@atlasauth/nuxt (`atlas.frontendApi` in nuxt.config, or NUXT_PUBLIC_ATLAS_FRONTEND_API)',
  });

  nuxtApp.vueApp.use(
    createAtlas({
      publishableKey: atlas.publishableKey,
      frontendApi: atlas.frontendApi,
    }),
  );
});
