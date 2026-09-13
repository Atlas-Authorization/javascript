import {
  defineNuxtModule,
  createResolver,
  addPlugin,
  addImports,
  addComponent,
  addServerHandler,
  addServerImports,
} from '@nuxt/kit';

/**
 * `@atlasauth/nuxt` — the official Nuxt 3 module for Atlas.
 *
 * A thin Nuxt binding: the client half is `@atlasauth/vue` (the `createAtlas()`
 * plugin, its composables and components), installed app-wide through a Nuxt
 * plugin and surfaced via auto-imports; the server half mirrors `@atlasauth/nextjs`,
 * verifying the `__session` JWT locally with `@atlasauth/backend` inside a Nitro
 * middleware and exposing a `getAtlasAuth(event)` helper to server routes.
 *
 * The design mirrors the other framework bindings exactly:
 *   - the browser holds only the short-lived JWT, never a secret;
 *   - the server verifies against cached JWKS with no call back to Atlas on the
 *     hot path (§7.3);
 *   - `jwksUrl` / `issuer` live in the SERVER-only `runtimeConfig`, never in the
 *     public config a client bundle can read.
 */

export interface ModuleOptions {
  /**
   * The instance publishable key (`pk_...`). Safe to expose to the browser; it
   * ends up in `runtimeConfig.public.atlas`. Prefer the
   * `NUXT_PUBLIC_ATLAS_PUBLISHABLE_KEY` env var in production.
   */
  publishableKey?: string;
  /** The instance's FAPI origin (e.g. `https://fox.fapi.atlas.dev`). Public. */
  frontendApi?: string;
  /**
   * The instance's JWKS URL, used by the Nitro side to verify session JWTs.
   * SERVER-ONLY — kept in `runtimeConfig.atlas`, never sent to the client.
   */
  jwksUrl?: string;
  /**
   * Expected token `iss`. SERVER-ONLY. Required for server-side verification —
   * an unchecked issuer would accept a token from any Atlas instance.
   */
  issuer?: string;
  /**
   * Optional `azp` allowlist. When set, a token minted for another origin is
   * refused server-side (§7.3). SERVER-ONLY.
   */
  authorizedParties?: string[];
}

export default defineNuxtModule<ModuleOptions>({
  meta: {
    name: '@atlasauth/nuxt',
    configKey: 'atlas',
    compatibility: {
      nuxt: '>=3.0.0',
    },
  },
  defaults: {
    publishableKey: '',
    frontendApi: '',
    jwksUrl: '',
    issuer: '',
    authorizedParties: [],
  },
  setup(options, nuxt) {
    const resolver = createResolver(import.meta.url);

    // ---- runtime config ----------------------------------------------------
    // Public (client + server): only the publishable key and FAPI origin — both
    // safe in a browser bundle. Module options seed the values; the matching
    // `NUXT_PUBLIC_ATLAS_*` env vars still override at runtime.
    const publicConfig = (nuxt.options.runtimeConfig.public.atlas ?? {}) as Record<string, unknown>;
    nuxt.options.runtimeConfig.public.atlas = {
      publishableKey: options.publishableKey || (publicConfig.publishableKey as string) || '',
      frontendApi: options.frontendApi || (publicConfig.frontendApi as string) || '',
    };

    // Private (server-only): the verification secrets. NEVER placed under
    // `public`, so they are stripped from the client bundle. `NUXT_ATLAS_*` env
    // vars override these at runtime.
    const privateConfig = (nuxt.options.runtimeConfig.atlas ?? {}) as Record<string, unknown>;
    nuxt.options.runtimeConfig.atlas = {
      jwksUrl: options.jwksUrl || (privateConfig.jwksUrl as string) || '',
      issuer: options.issuer || (privateConfig.issuer as string) || '',
      authorizedParties:
        options.authorizedParties?.length
          ? options.authorizedParties
          : (privateConfig.authorizedParties as string[]) || [],
    };

    // The workspace client packages ship ESM render-function source; Vite and
    // Nitro must transpile them rather than treat them as pre-built externals.
    nuxt.options.build.transpile.push('@atlasauth/vue', '@atlasauth/js', '@atlasauth/authz', resolver.resolve('./runtime'));

    // ---- client: install the Vue plugin app-wide ---------------------------
    // `mode: 'all'` so the injection context exists during SSR too — the Vue
    // plugin guards its browser-only work (boot, CSS vars) internally, so
    // installing on the server is safe and lets `<SignedIn>`/`<Protect>` render
    // (as their loading branch) instead of throwing "used outside createAtlas".
    addPlugin({ src: resolver.resolve('./runtime/plugin'), mode: 'all' });

    // ---- auto-import the @atlasauth/vue composables ----------------------------
    const composables = [
      'useAtlas',
      'useUser',
      'useSession',
      'useAuth',
      'useOrganization',
      'useSignIn',
      'useSignUp',
      'useFlow',
    ];
    for (const name of composables) {
      addImports({ name, as: name, from: '@atlasauth/vue' });
    }

    // ---- auto-register the @atlasauth/vue components ---------------------------
    const components = [
      'SignedIn',
      'SignedOut',
      'AtlasLoading',
      'AtlasLoaded',
      'Protect',
      'SignIn',
      'SignUp',
      'UserButton',
      'OrganizationSwitcher',
      'UserProfile',
      'OrganizationProfile',
    ];
    for (const name of components) {
      addComponent({ name, export: name, filePath: '@atlasauth/vue' });
    }

    // ---- server (Nitro) ----------------------------------------------------
    // A global middleware verifies the session on every request and stashes it
    // on `event.context.auth`, the Nuxt peer of the Next.js middleware. It runs
    // ahead of route handlers so any `defineEventHandler` can read the resolved
    // auth without repeating the work.
    addServerHandler({
      handler: resolver.resolve('./runtime/server/middleware'),
      middleware: true,
    });

    // Auto-import the server-route helper into every Nitro handler, so a route
    // can call `getAtlasAuth(event)` with no import — the SSR equivalent of the
    // client `useAuth()`.
    addServerImports([
      { name: 'getAtlasAuth', as: 'getAtlasAuth', from: resolver.resolve('./runtime/server/index') },
    ]);
  },
});
