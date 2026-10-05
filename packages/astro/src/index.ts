/**
 * `@atlasauth/astro` — the Astro adapter for Atlas auth.
 *
 * The real value is the SERVER middleware (`atlasMiddleware` / `getAuth`), which
 * lives in `./server` and is re-exported here so `@atlasauth/astro` alone gives
 * an integrator everything for SSR auth. This entry adds one small extra: the
 * `atlasAstro()` integration factory a consumer drops into `astro.config`.
 */

// Re-export the whole server surface (middleware, getAuth, authz primitives,
// AtlasBackend) — mirrors how `@atlasauth/nextjs` re-exports its middleware.
export * from './server';

/**
 * The minimal `AstroIntegration` shape this factory returns. Kept structural so
 * the package builds without `astro` installed; a real `AstroIntegration` is
 * assignable to it.
 */
export interface AtlasAstroIntegration {
  name: string;
  hooks: Record<string, unknown>;
}

/** Options for {@link atlasAstro}. Accepted for parity/forwarding; the server
 *  middleware is what performs verification, so nothing here is required. */
export interface AtlasAstroOptions {
  publishableKey?: string;
}

/**
 * `atlasAstro()` — the Astro integration a consumer adds to `astro.config.mjs`:
 *
 * @example
 * import { defineConfig } from 'astro/config';
 * import { atlasAstro } from '@atlasauth/astro';
 * export default defineConfig({ integrations: [atlasAstro()] });
 *
 * The hook is intentionally minimal — unlike Clerk, Atlas does not hotload a
 * client bundle or inject scripts, so there is nothing to wire at config time.
 * The integration exists for install parity and as the seam where future
 * client-side wiring (script injection, env schema) would attach. The session
 * verification that matters is done entirely by {@link atlasMiddleware}, which
 * the consumer registers in `src/middleware.ts` — that is the real value.
 */
export function atlasAstro(_options: AtlasAstroOptions = {}): AtlasAstroIntegration {
  return {
    name: '@atlasauth/astro',
    hooks: {},
  };
}
