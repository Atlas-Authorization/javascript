import { createElement, type ReactNode } from 'react';
import { AtlasConfigError, AtlasProvider } from '@atlasauth/react';
import { resolveOptions, type GatsbyAtlasOptions } from './options';

/**
 * The shape Gatsby passes to `wrapRootElement` / `wrapPageElement`: the element
 * to render, plus a few APIs this plugin does not need.
 */
export interface GatsbyWrapArgs {
  element: ReactNode;
}

/**
 * THE wrap — the single implementation shared by `gatsby-ssr` and
 * `gatsby-browser`. Using the identical function on both sides is the whole
 * correctness contract of a Gatsby auth plugin: the server HTML and the first
 * client render must produce the same tree, or React throws a hydration
 * mismatch. `<AtlasProvider>` is itself SSR-safe (it no-ops its window/cookie
 * work when there is no DOM), so a plain wrap on both sides is all that is
 * needed — no separate server renderer.
 *
 * Gatsby hands the plugin's `gatsby-config` options as the second argument; they
 * are merged with `ATLAS_*` / `GATSBY_ATLAS_*` env in {@link resolveOptions}.
 */
export function wrapRootElement(
  { element }: GatsbyWrapArgs,
  pluginOptions?: GatsbyAtlasOptions,
): ReactNode {
  const { publishableKey, frontendApi, appearance, localization, oauthMode } =
    resolveOptions(pluginOptions);

  // Refused here (same on the SSR/build pass and in the browser) so the message
  // names the places a Gatsby site actually sets it. A present-but-malformed
  // value is left to the provider, which validates the format.
  if (frontendApi === undefined) {
    throw new AtlasConfigError(
      'FRONTEND_API_REQUIRED',
      'gatsby-plugin-atlasauth needs `frontendApi`: set it in the plugin options in gatsby-config, ' +
        'or via GATSBY_ATLAS_FRONTEND_API (or ATLAS_FRONTEND_API). Use the absolute URL of your ' +
        'instance\'s Frontend API, e.g. "https://atlasauth.net" or your verified custom domain such as ' +
        '"https://auth.example.com" — or "same-origin" behind a reverse proxy on your own origin.',
    );
  }

  // `children` goes in the props object (not the third arg) because
  // AtlasProviderProps declares it required, which the 3-arg createElement
  // overload does not satisfy.
  return createElement(AtlasProvider, {
    publishableKey,
    frontendApi,
    appearance,
    localization,
    oauthMode,
    children: element,
  });
}
