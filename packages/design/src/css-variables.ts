/**
 * The documented `--atlas-*` variable set with types and descriptions — data
 * for docs, editors and the design catalog. Kept apart from the compiler so a
 * renderer that only compiles never ships the descriptions.
 */

export type DesignCssVarType =
  | 'color'
  | 'length'
  | 'number'
  | 'font-family'
  | 'font-weight'
  | 'shadow'
  | 'image'
  | 'keyword';

export interface DesignCssVariable {
  name: `--atlas-${string}`;
  type: DesignCssVarType;
  /** True when the value differs between light and dark mode. */
  perMode: boolean;
  description: string;
}

/** The complete, stable variable set — data for docs and SDKs. */
export const DESIGN_CSS_VARIABLES: readonly DesignCssVariable[] = [
  { name: '--atlas-color-primary', type: 'color', perMode: true, description: 'Primary brand colour: primary button fill, focus, active states.' },
  { name: '--atlas-color-primary-ink', type: 'color', perMode: true, description: 'Text/icon colour on a primary fill (button label).' },
  { name: '--atlas-color-primary-text', type: 'color', perMode: true, description: 'Primary used AS text (links) — the primary hue adjusted to 4.5:1 on the surface.' },
  { name: '--atlas-color-accent', type: 'color', perMode: true, description: 'Secondary accent (gradient buttons, highlights).' },
  { name: '--atlas-color-background', type: 'color', perMode: true, description: 'Page background colour.' },
  { name: '--atlas-color-surface', type: 'color', perMode: true, description: 'Card / panel surface colour.' },
  { name: '--atlas-color-text', type: 'color', perMode: true, description: 'Body text colour.' },
  { name: '--atlas-color-muted', type: 'color', perMode: true, description: 'Secondary text: labels, hints, dividers text.' },
  { name: '--atlas-color-border', type: 'color', perMode: true, description: 'Card and control border colour.' },
  { name: '--atlas-color-danger', type: 'color', perMode: true, description: 'Errors and destructive actions.' },
  { name: '--atlas-color-success', type: 'color', perMode: true, description: 'Success messages.' },
  { name: '--atlas-color-input-background', type: 'color', perMode: true, description: 'Text input fill.' },
  { name: '--atlas-color-input-text', type: 'color', perMode: true, description: 'Text input text colour.' },
  { name: '--atlas-color-focus-ring', type: 'color', perMode: true, description: 'Focus ring (primary at 35% alpha).' },
  { name: '--atlas-font-body', type: 'font-family', perMode: false, description: 'Body font stack.' },
  { name: '--atlas-font-heading', type: 'font-family', perMode: false, description: 'Heading font stack.' },
  { name: '--atlas-font-size-base', type: 'length', perMode: false, description: 'Body text size (px).' },
  { name: '--atlas-font-size-sm', type: 'length', perMode: false, description: 'Small text size (px).' },
  { name: '--atlas-font-size-lg', type: 'length', perMode: false, description: 'Large text size: base × √scale (px).' },
  { name: '--atlas-font-size-title', type: 'length', perMode: false, description: 'Card title size: base × scale (px).' },
  { name: '--atlas-font-weight-body', type: 'font-weight', perMode: false, description: 'Body font weight.' },
  { name: '--atlas-font-weight-heading', type: 'font-weight', perMode: false, description: 'Heading font weight.' },
  { name: '--atlas-type-scale', type: 'number', perMode: false, description: 'Modular type-scale ratio.' },
  { name: '--atlas-button-text-transform', type: 'keyword', perMode: false, description: '`none` or `uppercase` for button labels.' },
  { name: '--atlas-button-letter-spacing', type: 'length', perMode: false, description: 'Button label tracking (wider when uppercase).' },
  { name: '--atlas-radius-card', type: 'length', perMode: false, description: 'Card corner radius (px).' },
  { name: '--atlas-radius-control', type: 'length', perMode: false, description: 'Button/input corner radius (px; 999px = pill).' },
  { name: '--atlas-border-width', type: 'length', perMode: false, description: 'Control border width (px).' },
  { name: '--atlas-card-border-width', type: 'length', perMode: false, description: 'Card border width (0 for `none` cards, at least 1px for `outline`).' },
  { name: '--atlas-shadow-card', type: 'shadow', perMode: false, description: 'Card box-shadow (`none` for outline/none cards).' },
  { name: '--atlas-card-background', type: 'color', perMode: true, description: 'Card fill: surface, translucent surface (glass) or transparent (none).' },
  { name: '--atlas-card-blur', type: 'length', perMode: false, description: 'Card backdrop blur (px); 0 unless the card is glass.' },
  { name: '--atlas-card-width', type: 'length', perMode: false, description: 'Card max width (px).' },
  { name: '--atlas-space-unit', type: 'length', perMode: false, description: 'Base spacing unit (px), by density.' },
  { name: '--atlas-space-card', type: 'length', perMode: false, description: 'Card padding (px), by density.' },
  { name: '--atlas-space-gap', type: 'length', perMode: false, description: 'Gap between form rows (px), by density.' },
  { name: '--atlas-control-height', type: 'length', perMode: false, description: 'Button/input height (px), by density.' },
  { name: '--atlas-logo-size', type: 'length', perMode: false, description: 'Logo max height (px).' },
  { name: '--atlas-bg-color', type: 'color', perMode: true, description: 'Page background fill (background.color or palette background).' },
  { name: '--atlas-bg-gradient', type: 'image', perMode: true, description: 'Page gradient (`linear-gradient(…)` / `radial-gradient(…)`) or `none`.' },
  { name: '--atlas-bg-image', type: 'image', perMode: true, description: 'Page background image `url("…")` (Atlas asset) or `none`.' },
  { name: '--atlas-bg-size', type: 'keyword', perMode: true, description: '`cover` or `contain`.' },
  { name: '--atlas-bg-position', type: 'keyword', perMode: true, description: 'Background image position, e.g. `center center`.' },
  { name: '--atlas-bg-overlay', type: 'color', perMode: true, description: 'Overlay painted over the image (`rgb(r g b / a)`), `transparent` when none.' },
  { name: '--atlas-bg-blur', type: 'length', perMode: true, description: 'Background image blur (px).' },
  { name: '--atlas-bg-pattern-color', type: 'color', perMode: true, description: 'Pattern ink (text colour at low alpha).' },
] as const;
