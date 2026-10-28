import { resolveOptions, type GatsbyAtlasOptions } from './options';

/**
 * Minimal structural types for the one Gatsby Node API this plugin uses, so the
 * package type-checks without `gatsby` installed (it is an optional peer).
 */
interface OnCreateWebpackConfigArgs {
  actions: { setWebpackConfig: (config: { plugins: unknown[] }) => void };
  plugins: { define: (defs: Record<string, string>) => unknown };
}

/**
 * Forward the resolved publishable key / frontend API into the BROWSER bundle as
 * `GATSBY_*` defines. This is what lets a site configure the plugin with only the
 * unprefixed `ATLAS_*` env (which Node sees at build time but the browser bundle
 * otherwise never does): the resolved values are inlined so the client-side wrap
 * reads them back. A value set in `gatsby-config` or via `GATSBY_*` already
 * reaches the browser, so this is purely additive — never destructive.
 */
export function onCreateWebpackConfig(
  { actions, plugins }: OnCreateWebpackConfigArgs,
  pluginOptions?: GatsbyAtlasOptions,
): void {
  const { publishableKey, frontendApi } = resolveOptions(pluginOptions);

  const defines: Record<string, string> = {};
  if (publishableKey) {
    defines['process.env.GATSBY_ATLAS_PUBLISHABLE_KEY'] = JSON.stringify(publishableKey);
  }
  if (frontendApi) {
    defines['process.env.GATSBY_ATLAS_FRONTEND_API'] = JSON.stringify(frontendApi);
  }
  if (Object.keys(defines).length === 0) return;

  actions.setWebpackConfig({ plugins: [plugins.define(defines)] });
}
