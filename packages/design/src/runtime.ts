/**
 * @atlasauth/design/runtime — the zod-free subset of the design system for
 * renderers that must stay small: everything needed to resolve, layer, compile
 * and apply a design (presets, resolver, CSS compiler, data attributes, fonts,
 * contrast, warnings, the SDK composition helpers), with hand-written input
 * guards (./guards) in place of the zod schema. Same behaviour as the full
 * entry for rendering; the dashboard-facing validators with zod error
 * messages (`validateDesign`, `applyDesignPatch`, the zod schemas) are only in
 * the full `@atlasauth/design` entry.
 */
export * from './vocab';
export * from './guards';
export * from './merge';
export * from './presets';
export * from './resolve';
export * from './layer';
export * from './contrast';
export * from './warnings';
export * from './css';
export * from './css-variables';
export * from './fonts';
export * from './client';
export * from './render';
export * from './adopt';
export type {
  AtlasDesign,
  DesignBackground,
  DesignBackgroundImage,
  DesignGradient,
  DesignPalette,
  DesignPatch,
} from './schema';
