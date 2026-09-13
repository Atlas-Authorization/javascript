/**
 * Fallback type declarations for the Nuxt virtual modules this package's runtime
 * imports from (`#imports`).
 *
 * When the module is built with `@nuxt/module-builder` (or consumed inside a
 * Nuxt app), Nuxt generates the authoritative types for these virtual modules
 * and they take precedence. This shim only exists so that a standalone
 * `tsc --noEmit` typecheck of `packages/nuxt` — run outside a Nuxt project —
 * still resolves the handful of runtime helpers we use, rather than erroring on
 * an unresolvable `#imports`.
 *
 * The signatures are intentionally narrow: only what the runtime touches.
 */
declare module '#imports' {
  /**
   * The subset of Nuxt's runtime app object our plugin touches. Nuxt's own
   * generated types supply the full `NuxtApp` when this package is built inside
   * a Nuxt project; this narrow shape only needs to type the standalone
   * `tsc --noEmit` so the plugin callback's parameter isn't an implicit `any`.
   */
  export interface NuxtApp {
    vueApp: { use(plugin: unknown): unknown };
  }
  /** Register a Nuxt app plugin (function form — the callback receives the app). */
  export function defineNuxtPlugin<T>(plugin: (nuxtApp: NuxtApp) => T): (nuxtApp: NuxtApp) => T;
  /** Resolve the merged runtime config (public on the client, public + private on the server). */
  export function useRuntimeConfig(): {
    public: {
      atlas: {
        publishableKey: string;
        frontendApi: string;
      };
    };
    atlas: {
      jwksUrl: string;
      issuer: string;
      authorizedParties: string[];
    };
  };
}
