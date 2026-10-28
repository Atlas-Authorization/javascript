/**
 * `gatsby-plugin-atlasauth` — the Atlas peer of `gatsby-plugin-clerk`.
 *
 * Add it to `gatsby-config` and every page, server-rendered and hydrated, is
 * wrapped in `@atlasauth/react`'s `<AtlasProvider>`, so the package's hooks
 * (`useAuth`, `useUser`, …) and components (`<SignedIn>`, `<SignIn>`, …) work
 * anywhere in the tree.
 *
 * Gatsby resolves `gatsby-browser.js`, `gatsby-ssr.js` and `gatsby-node.js` at
 * the package root (shims that point here, into `dist/`). This entry re-exports
 * the option types and the shared wrap for direct use and testing.
 */
export { wrapRootElement, type GatsbyWrapArgs } from './wrap';
export {
  resolveOptions,
  type GatsbyAtlasOptions,
  type ResolvedAtlasOptions,
} from './options';
