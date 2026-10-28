/**
 * Gatsby SSR API. Re-exports THE shared wrap so it is reference-identical to the
 * one `gatsby-browser` exports — server HTML and client hydration render the
 * same provider tree, so there is no hydration mismatch.
 */
export { wrapRootElement } from './wrap';
