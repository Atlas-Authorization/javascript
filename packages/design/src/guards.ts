import { FONT_IDS } from './fonts';
import type { AtlasDesign } from './schema';
import {
  ASSET_ID,
  BACKGROUND_PATTERNS,
  BUTTON_STYLES,
  CARD_SHADOWS,
  CARD_STYLES,
  CARD_WIDTHS,
  COLOR_SCHEMES,
  DENSITIES,
  GRADIENT_TYPES,
  HEX_COLOR,
  IMAGE_FITS,
  IMAGE_POSITIONS,
  INPUT_STYLES,
  LAYOUT_POSITIONS,
  LETTER_CASES,
  LOGO_PLACEMENTS,
  LOGO_SIZES,
  PALETTE_SLOTS,
  PRESET_IDS,
  SOCIAL_LAYOUTS,
  SPLIT_SIDES,
  TYPE_SCALE_NAMES,
  type DesignProblem,
} from './vocab';

/**
 * Hand-written design validation with NO dependency — the runtime twin of the
 * zod `designSchema` (./schema.ts), for bundles that must stay small (the embed
 * widget). It accepts exactly what the schema accepts: every object is strict
 * (unknown keys refused), every leaf a closed enum, a bounded integer, a strict
 * `#RRGGBB` hex or a catalog id. `guards.test.ts` fuzzes both against each
 * other so they cannot drift.
 *
 * This is the input gate; the CSS compiler re-validates every value at output
 * regardless, so a gap here could drop a setting but never inject CSS.
 */

type Check = (v: unknown) => boolean;
type Plain = Record<string, unknown>;

const isPlain = (v: unknown): v is Plain => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};
const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

const oneOf =
  (values: readonly string[]): Check =>
  (v) =>
    typeof v === 'string' && values.includes(v);
const int =
  (min: number, max: number, step = 1): Check =>
  (v) =>
    typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max && v % step === 0;
const num =
  (min: number, max: number): Check =>
  (v) =>
    typeof v === 'number' && !Number.isNaN(v) && v >= min && v <= max;
const hex: Check = (v) => typeof v === 'string' && HEX_COLOR.test(v);
const asset: Check = (v) => typeof v === 'string' && ASSET_ID.test(v);

/** A strict object: only `fields`, each optional unless listed in `required`. */
function object(fields: Record<string, Check>, required: readonly string[] = []): Check {
  return (v) => {
    if (!isPlain(v)) return false;
    for (const k of Object.keys(v)) {
      if (!own(fields, k)) return false;
      const value = v[k];
      if (value === undefined) {
        if (required.includes(k)) return false;
        continue;
      }
      if (!fields[k]!(value)) return false;
    }
    return required.every((k) => own(v, k) && v[k] !== undefined);
  };
}

const FONT = oneOf(FONT_IDS);

/** Leaf checks per object section. */
export const DESIGN_SECTION_FIELDS: Record<string, Record<string, Check>> = {
  palette: Object.fromEntries(PALETTE_SLOTS.map((k) => [k, hex])),
  paletteDark: Object.fromEntries(PALETTE_SLOTS.map((k) => [k, hex])),
  typography: {
    font: FONT,
    headingFont: FONT,
    baseSize: int(12, 20),
    headingWeight: int(400, 800, 100),
    bodyWeight: int(300, 600, 100),
    letterCase: oneOf(LETTER_CASES),
    scale: oneOf(TYPE_SCALE_NAMES),
  },
  shape: { radius: int(0, 32), controlRadius: int(0, 999), borderWidth: int(0, 3) },
  elevation: { cardShadow: oneOf(CARD_SHADOWS) },
  spacing: { density: oneOf(DENSITIES) },
  card: { style: oneOf(CARD_STYLES), blur: int(0, 40), width: oneOf(CARD_WIDTHS) },
  layout: {
    position: oneOf(LAYOUT_POSITIONS),
    splitImageSide: oneOf(SPLIT_SIDES),
    logoPlacement: oneOf(LOGO_PLACEMENTS),
    logoSize: oneOf(LOGO_SIZES),
  },
  buttons: { style: oneOf(BUTTON_STYLES), socialLayout: oneOf(SOCIAL_LAYOUTS) },
  inputs: { style: oneOf(INPUT_STYLES) },
  logo: { assetId: asset, darkAssetId: asset },
};

const gradient: Check = (v) => {
  if (!object({ type: oneOf(GRADIENT_TYPES), angle: int(0, 360), stops: () => true }, ['type', 'stops'])(v)) return false;
  const stops = (v as Plain).stops;
  return (
    Array.isArray(stops) &&
    stops.length >= 2 &&
    stops.length <= 4 &&
    stops.every(object({ color: hex, at: num(0, 100) }, ['color', 'at']))
  );
};

const backgroundImage = object(
  {
    assetId: asset,
    fit: oneOf(IMAGE_FITS),
    position: oneOf(IMAGE_POSITIONS),
    overlay: object({ color: hex, opacity: num(0, 1) }, ['color', 'opacity']),
    blur: int(0, 20),
  },
  ['assetId'],
);

/** Leaf checks of a background (an ATOMIC section: it replaces wholesale on resolve). */
export const BACKGROUND_FIELDS: Record<string, Check> = {
  color: hex,
  gradient,
  image: backgroundImage,
  pattern: oneOf(BACKGROUND_PATTERNS),
};

const TOP: Record<string, Check> = {
  version: (v) => v === 1,
  preset: oneOf(PRESET_IDS),
  colorScheme: oneOf(COLOR_SCHEMES),
  background: object(BACKGROUND_FIELDS),
  backgroundDark: object(BACKGROUND_FIELDS),
  ...Object.fromEntries(Object.entries(DESIGN_SECTION_FIELDS).map(([k, f]) => [k, object(f)])),
};

/** Whether `value` is a valid value for the top-level design key `key`. */
export function isValidDesignSection(key: string, value: unknown): boolean {
  return own(TOP, key) && TOP[key]!(value);
}

/** Whether `input` is a valid stored design (same answer as `designSchema.safeParse`). */
export const isValidDesign: Check = object(TOP);

/**
 * Keep every valid setting of `input` and drop each invalid one, reporting it
 * with its dotted path. Object sections are kept leaf by leaf; a background
 * keeps each valid layer (colour, gradient, image, pattern).
 */
export function checkDesign(
  input: unknown,
  onProblem: (p: DesignProblem) => void = () => {},
  prefix = '',
): AtlasDesign {
  const at = (...parts: string[]) => [prefix, ...parts].filter(Boolean).join('.');
  if (input === undefined || input === null) return {};
  if (!isPlain(input)) {
    onProblem({ path: prefix || '(root)', message: 'must be an object' });
    return {};
  }
  const out: Plain = {};
  for (const [k, v] of Object.entries(input)) {
    if (v === undefined) continue;
    if (!own(TOP, k)) {
      onProblem({ path: at(k), message: 'Unknown setting.' });
      continue;
    }
    if (TOP[k]!(v)) {
      out[k] = v;
      continue;
    }
    const leaves = own(DESIGN_SECTION_FIELDS, k)
      ? DESIGN_SECTION_FIELDS[k]!
      : k === 'background' || k === 'backgroundDark'
        ? BACKGROUND_FIELDS
        : null;
    if (!leaves || !isPlain(v)) {
      onProblem({ path: at(k), message: 'Invalid value.' });
      continue;
    }
    const kept: Plain = {};
    for (const [leaf, lv] of Object.entries(v)) {
      if (lv === undefined) continue;
      if (own(leaves, leaf) && leaves[leaf]!(lv)) kept[leaf] = lv;
      else onProblem({ path: at(k, leaf), message: own(leaves, leaf) ? 'Invalid value.' : 'Unknown setting.' });
    }
    if (Object.keys(kept).length) out[k] = kept;
  }
  return out as AtlasDesign;
}
