import type { DesignBackground } from './schema';

/**
 * The design system's closed vocabularies and the resolved-design shape —
 * plain constants and types with NO runtime dependency, shared by the
 * zod schema (`./schema`) and the zod-free runtime entry (`./runtime`).
 */

// ---- closed vocabularies ---------------------------------------------------

export const COLOR_SCHEMES = ['auto', 'light', 'dark'] as const;
export const PALETTE_SLOTS = [
  'primary',
  'primaryInk',
  'accent',
  'background',
  'surface',
  'text',
  'muted',
  'border',
  'danger',
  'success',
  'inputBackground',
  'inputText',
] as const;
export const LETTER_CASES = ['none', 'uppercase'] as const;
/** Modular type scales: heading size = base × ratio. */
export const TYPE_SCALES = {
  'minor-second': 1.067,
  'major-second': 1.125,
  'minor-third': 1.2,
  'major-third': 1.25,
  'perfect-fourth': 1.333,
  'augmented-fourth': 1.414,
  'perfect-fifth': 1.5,
  golden: 1.618,
  'minor-seventh': 1.778,
  octave: 2,
} as const;
export const TYPE_SCALE_NAMES = Object.keys(TYPE_SCALES) as (keyof typeof TYPE_SCALES)[];
export const CARD_SHADOWS = ['none', 'sm', 'md', 'lg', 'xl'] as const;
export const DENSITIES = ['compact', 'comfortable', 'spacious'] as const;
export const CARD_STYLES = ['solid', 'glass', 'outline', 'none'] as const;
export const CARD_WIDTHS = ['narrow', 'normal', 'wide'] as const;
export const LAYOUT_POSITIONS = ['center', 'left', 'right', 'split'] as const;
export const SPLIT_SIDES = ['left', 'right'] as const;
/**
 * Where the logo sits. `hidden` is part of the vocabulary but a CONSUMER may
 * refuse it (e.g. a surface that must always show whose sign-in this is) —
 * consumers that do should map it to `card` at render time.
 */
export const LOGO_PLACEMENTS = ['card', 'page', 'hidden'] as const;
export const LOGO_SIZES = ['sm', 'md', 'lg'] as const;
export const BUTTON_STYLES = ['solid', 'outline', 'soft', 'gradient'] as const;
export const SOCIAL_LAYOUTS = ['list', 'grid', 'icons'] as const;
export const INPUT_STYLES = ['outline', 'filled', 'underline'] as const;
export const GRADIENT_TYPES = ['linear', 'radial'] as const;
export const IMAGE_FITS = ['cover', 'contain'] as const;
export const IMAGE_POSITIONS = [
  'top-left',
  'top',
  'top-right',
  'left',
  'center',
  'right',
  'bottom-left',
  'bottom',
  'bottom-right',
] as const;
export const BACKGROUND_PATTERNS = ['none', 'dots', 'grid', 'noise'] as const;

/** Preset ids. The table itself lives in `./presets.ts`; the ids live here so the schema can name them. */
export const PRESET_IDS = [
  'minimal',
  'atlas',
  'glass',
  'midnight',
  'editorial',
  'terminal',
  'sunrise',
  'forest',
  'grape',
  'slate',
  'split-photo',
  'bold',
] as const;
export type PresetId = (typeof PRESET_IDS)[number];

// ---- leaves ----------------------------------------------------------------

export const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
/** An uploaded Atlas design asset id: `dasset_` + a ULID. Never a URL. */
export const ASSET_ID = /^dasset_[0-9A-HJKMNP-TV-Z]{26}$/;

// ---- the fully-resolved shape --------------------------------------------------

export type PaletteSlot = (typeof PALETTE_SLOTS)[number];
export type ResolvedPalette = Record<PaletteSlot, string>;

export interface ResolvedDesign {
  version: 1;
  preset: PresetId;
  colorScheme: (typeof COLOR_SCHEMES)[number];
  palette: ResolvedPalette;
  paletteDark: ResolvedPalette;
  typography: {
    font: string;
    headingFont: string;
    baseSize: number;
    headingWeight: number;
    bodyWeight: number;
    letterCase: (typeof LETTER_CASES)[number];
    scale: keyof typeof TYPE_SCALES;
  };
  shape: { radius: number; controlRadius: number; borderWidth: number };
  elevation: { cardShadow: (typeof CARD_SHADOWS)[number] };
  spacing: { density: (typeof DENSITIES)[number] };
  card: { style: (typeof CARD_STYLES)[number]; blur: number; width: (typeof CARD_WIDTHS)[number] };
  layout: {
    position: (typeof LAYOUT_POSITIONS)[number];
    splitImageSide: (typeof SPLIT_SIDES)[number];
    logoPlacement: (typeof LOGO_PLACEMENTS)[number];
    logoSize: (typeof LOGO_SIZES)[number];
  };
  buttons: { style: (typeof BUTTON_STYLES)[number]; socialLayout: (typeof SOCIAL_LAYOUTS)[number] };
  inputs: { style: (typeof INPUT_STYLES)[number] };
  background: DesignBackground;
  backgroundDark: DesignBackground;
  logo: { assetId?: string; darkAssetId?: string };
}

// ---- validation results --------------------------------------------------------

export interface DesignProblem {
  /** Dotted path, e.g. `typography.baseSize` or `background.gradient.stops.0.color`. */
  path: string;
  message: string;
}

export type DesignValidation<T> = { ok: true; value: T } | { ok: false; problems: DesignProblem[] };
