import type { Appearance, Catalog } from '@atlasauth/react';

/**
 * Plugin options as set in `gatsby-config`:
 *
 * ```js
 * module.exports = {
 *   plugins: [
 *     {
 *       resolve: 'gatsby-plugin-atlasauth',
 *       options: {
 *         publishableKey: 'pk_live_…',
 *         frontendApi: 'https://auth.acme.com',
 *       },
 *     },
 *   ],
 * };
 * ```
 *
 * Every field is optional here because it may instead come from the environment
 * (see {@link resolveOptions}). It mirrors the props of `@atlasauth/react`'s
 * `<AtlasProvider>` — nothing is invented on top.
 */
export interface GatsbyAtlasOptions {
  /**
   * `pk_(live|test)_<instanceId>`. Falls back to `GATSBY_ATLAS_PUBLISHABLE_KEY`
   * then `ATLAS_PUBLISHABLE_KEY` from the environment.
   */
  publishableKey?: string;
  /**
   * The instance's Frontend API origin (e.g. `https://atlasauth.net`, or a
   * verified custom domain, or `"same-origin"` for a same-origin / reverse-proxy
   * setup). Falls back to `GATSBY_ATLAS_FRONTEND_API` then `ATLAS_FRONTEND_API`.
   *
   * Required: the publishable key encodes the instance id but not a host, so the
   * origin cannot be derived. When neither the option nor the env provides it,
   * the wrap throws an `AtlasConfigError` (`FRONTEND_API_REQUIRED`) naming both;
   * a malformed value is refused by the provider (`FRONTEND_API_INVALID`).
   */
  frontendApi?: string;
  /** Provider appearance tokens, passed through unchanged. */
  appearance?: Appearance;
  /** Localization catalog, passed through unchanged. */
  localization?: Catalog;
  /** App-wide default for social/OIDC sign-in: `"popup"` or `"redirect"`. */
  oauthMode?: 'popup' | 'redirect';
  /**
   * Gatsby injects its own `plugins` array onto the options object it hands
   * plugins; it is accepted and ignored here.
   */
  plugins?: unknown;
}

/**
 * The options merged with the environment. `publishableKey` is always a string
 * (`""` when genuinely unset — the provider's concern). `frontendApi` is
 * `undefined` when unset rather than `""`, so "missing" is never mistaken for a
 * value: the wrap refuses it with a clear error. The rest stay optional exactly
 * as the provider declares them.
 */
export interface ResolvedAtlasOptions {
  publishableKey: string;
  frontendApi: string | undefined;
  appearance?: Appearance;
  localization?: Catalog;
  oauthMode?: 'popup' | 'redirect';
}

/**
 * Read one env var, treating empty string as absent. Each name is referenced
 * statically (not `process.env[name]`) so Gatsby's `DefinePlugin` can inline the
 * `GATSBY_*` values into the browser bundle; the `ATLAS_*` names resolve only in
 * the Node/SSR pass (and in the browser when `gatsby-node` forwards them).
 */
function env(): Record<string, string | undefined> {
  return typeof process !== 'undefined' && process.env ? process.env : {};
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    if (value != null && value !== '') return value;
  }
  return undefined;
}

/**
 * Merge `gatsby-config` options with the environment. Options win; env is the
 * fallback, `GATSBY_*` (browser-safe) ahead of the unprefixed `ATLAS_*`.
 */
export function resolveOptions(options: GatsbyAtlasOptions = {}): ResolvedAtlasOptions {
  const e = env();
  const publishableKey = firstNonEmpty(
    options.publishableKey,
    e.GATSBY_ATLAS_PUBLISHABLE_KEY,
    e.ATLAS_PUBLISHABLE_KEY,
  );
  // An explicit `frontendApi: ""` plugin option is the deprecated same-origin
  // spelling and is kept as-is; env vars treat empty as unset.
  const frontendApi = options.frontendApi === '' ? '' : firstNonEmpty(
    options.frontendApi,
    e.GATSBY_ATLAS_FRONTEND_API,
    e.ATLAS_FRONTEND_API,
  );

  return {
    // `""` not undefined: the provider's prop is a required string, and an unset
    // key is a provider concern (it renders signed-out).
    publishableKey: publishableKey ?? '',
    // Left undefined when unset (not defaulted to `""`, the deprecated
    // same-origin spelling), so the wrap turns a missing value into a clear
    // error. An explicit `""` option is passed through and still means
    // same-origin, with a deprecation warning; prefer `"same-origin"`.
    frontendApi,
    appearance: options.appearance,
    localization: options.localization,
    oauthMode: options.oauthMode,
  };
}
