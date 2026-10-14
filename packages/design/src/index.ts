/**
 * @atlasauth/design — the Atlas design system.
 *
 * One structured description of how an Atlas auth surface looks, shared by the
 * hosted sign-in pages, per-organization overrides, "Sign in with Atlas" app
 * pages and the embeddable SDK components:
 *
 *  - `designSchema` / `AtlasDesign`: the settings model (closed enums, bounded
 *    numbers, strict hex colours, catalog ids — never raw CSS);
 *  - `DESIGN_PRESETS`: curated starting points;
 *  - `resolveDesign` / `layerDesign` / `applyDesignPatch`: the merge rules;
 *  - `compileDesignCss` / `designDataAttributes` / `DESIGN_CSS_VARIABLES`: the
 *    safe compiler to `--atlas-*` custom properties and `data-atlas-*` hooks;
 *  - `FONT_CATALOG`: the curated, self-hosted font list (metadata only);
 *  - contrast helpers and design warnings;
 *  - `composeDesign`: what an SDK component renders (instance design + code).
 *
 * Browser-safe, framework-free, one runtime dependency (zod).
 */
export * from './runtime';
export * from './schema';
export * from './patch';
