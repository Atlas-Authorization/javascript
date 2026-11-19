import { array, enumOf as enumSchema, literal, number, object, string, type Schema, type SchemaError } from './mini';
import { CUSTOM_FONT_ID, FONT_IDS } from './fonts';
import {
  COLOR_SCHEMES,
  PALETTE_SLOTS,
  LETTER_CASES,
  TYPE_SCALES,
  TYPE_SCALE_NAMES,
  CARD_SHADOWS,
  DENSITIES,
  CARD_STYLES,
  CARD_WIDTHS,
  LAYOUT_POSITIONS,
  SPLIT_SIDES,
  LOGO_PLACEMENTS,
  LOGO_SIZES,
  BUTTON_STYLES,
  SOCIAL_LAYOUTS,
  INPUT_STYLES,
  GRADIENT_TYPES,
  IMAGE_FITS,
  IMAGE_POSITIONS,
  BACKGROUND_PATTERNS,
  PRESET_IDS,
  HEX_COLOR,
  ASSET_ID,
  type PaletteSlot,
  type PresetId,
  type DesignProblem,
  type DesignValidation,
} from './vocab';

// The vocabularies and resolved shape live in ./vocab (zod-free); re-exported here.
export * from './vocab';

/**
 * The Atlas design schema — ONE structured description of how an auth surface
 * looks, shared by hosted sign-in pages, per-organization overrides, "Sign in
 * with Atlas" app pages and the embeddable SDK components.
 *
 * STRUCTURED SETTINGS ONLY. Every leaf is a closed enum, a bounded number, a
 * strict `#RRGGBB` hex, a catalog id (preset, font) or an uploaded asset id.
 * There is deliberately no field that carries CSS, HTML, JavaScript or an
 * arbitrary URL: the compiler (`./css.ts`) can therefore turn a design into a
 * stylesheet of custom properties without an escaper, and still re-validates
 * every value on the way out.
 *
 * Every object is `.strict()`: an unknown key is REFUSED (with its full dotted
 * path) rather than silently dropped, so a misspelled field never answers
 * "saved" while storing nothing.
 *
 * A stored design is a set of OVERRIDES: every section and field is optional
 * and resolves over the chosen preset, then the defaults (see `./resolve.ts`).
 */

export const hexColor = string(HEX_COLOR, 'Use a 6-digit hex colour like #4F46E5.');
export const assetId = string(ASSET_ID, 'Use the asset_id returned by the design image upload (dasset_…).');
/** A catalog font id, or a self-hosted brand font id (`custom-<hash>`). One typed string, so the OpenAPI schema stays typed. */
const FONT_ID_PATTERN = new RegExp(
  `^(?:${FONT_IDS.map((id) => id.replace(/[^a-z0-9-]/g, '')).join('|')}|${CUSTOM_FONT_ID.source.replace(/^\^|\$$/g, '')})$`,
);
const fontId = string(
  FONT_ID_PATTERN,
  `Use a catalog font id (${FONT_IDS.join(', ')}), or a self-hosted font id (custom-…) from a brand import.`,
);
const int = (min: number, max: number, multipleOf?: number) => number({ int: true, min, max, multipleOf });
const enumOf = <const T extends readonly string[]>(values: T) => enumSchema(values);

// ---- types -------------------------------------------------------------------

export type DesignPalette = { [K in PaletteSlot]?: string };
export type DesignGradient = {
  type: (typeof GRADIENT_TYPES)[number];
  /** Degrees; linear only. */
  angle?: number;
  stops: { color: string; at: number }[];
};
export type DesignBackgroundImage = {
  assetId: string;
  fit?: (typeof IMAGE_FITS)[number];
  position?: (typeof IMAGE_POSITIONS)[number];
  overlay?: { color: string; opacity: number };
  blur?: number;
};
export type DesignBackground = {
  color?: string;
  gradient?: DesignGradient;
  image?: DesignBackgroundImage;
  pattern?: (typeof BACKGROUND_PATTERNS)[number];
};

/** A stored design: overrides on top of a preset. */
export type AtlasDesign = {
  /** Schema version, for forward migrations. */
  version?: 1;
  preset?: PresetId;
  colorScheme?: (typeof COLOR_SCHEMES)[number];
  palette?: DesignPalette;
  paletteDark?: DesignPalette;
  typography?: {
    font?: string;
    headingFont?: string;
    baseSize?: number;
    headingWeight?: number;
    bodyWeight?: number;
    letterCase?: (typeof LETTER_CASES)[number];
    scale?: keyof typeof TYPE_SCALES;
  };
  shape?: { radius?: number; controlRadius?: number; borderWidth?: number };
  elevation?: { cardShadow?: (typeof CARD_SHADOWS)[number] };
  spacing?: { density?: (typeof DENSITIES)[number] };
  card?: { style?: (typeof CARD_STYLES)[number]; blur?: number; width?: (typeof CARD_WIDTHS)[number] };
  layout?: {
    position?: (typeof LAYOUT_POSITIONS)[number];
    splitImageSide?: (typeof SPLIT_SIDES)[number];
    logoPlacement?: (typeof LOGO_PLACEMENTS)[number];
    logoSize?: (typeof LOGO_SIZES)[number];
  };
  buttons?: { style?: (typeof BUTTON_STYLES)[number]; socialLayout?: (typeof SOCIAL_LAYOUTS)[number] };
  inputs?: { style?: (typeof INPUT_STYLES)[number] };
  background?: DesignBackground;
  backgroundDark?: DesignBackground;
  logo?: { assetId?: string; darkAssetId?: string };
};

// ---- sections ----------------------------------------------------------------

export const paletteSchema = object<DesignPalette>(
  Object.fromEntries(PALETTE_SLOTS.map((k) => [k, hexColor.optional()])),
);

export const typographySchema = object<NonNullable<AtlasDesign['typography']>>({
  /** A catalog font id, or a self-hosted brand font (`custom-<hash>`, imported from a brand document). */
  font: fontId.optional(),
  headingFont: fontId.optional(),
  /** Body text size in px. */
  baseSize: int(12, 20).optional(),
  headingWeight: int(400, 800, 100).optional(),
  bodyWeight: int(300, 600, 100).optional(),
  /** Letter case of BUTTON labels. */
  letterCase: enumOf(LETTER_CASES).optional(),
  scale: enumOf(TYPE_SCALE_NAMES).optional(),
});

export const shapeSchema = object<NonNullable<AtlasDesign['shape']>>({
  /** Card corner radius, px. */
  radius: int(0, 32).optional(),
  /** Button + input corner radius, px; 999 = pill. */
  controlRadius: int(0, 999).optional(),
  borderWidth: int(0, 3).optional(),
});

export const elevationSchema = object<NonNullable<AtlasDesign['elevation']>>({ cardShadow: enumOf(CARD_SHADOWS).optional() });
export const spacingSchema = object<NonNullable<AtlasDesign['spacing']>>({ density: enumOf(DENSITIES).optional() });

export const cardSchema = object<NonNullable<AtlasDesign['card']>>({
  style: enumOf(CARD_STYLES).optional(),
  /** Backdrop blur, px. Only applied when `style` is `glass`. */
  blur: int(0, 40).optional(),
  width: enumOf(CARD_WIDTHS).optional(),
});

export const layoutSchema = object<NonNullable<AtlasDesign['layout']>>({
  position: enumOf(LAYOUT_POSITIONS).optional(),
  /** Which side the image panel sits on. Only applied when `position` is `split`. */
  splitImageSide: enumOf(SPLIT_SIDES).optional(),
  logoPlacement: enumOf(LOGO_PLACEMENTS).optional(),
  logoSize: enumOf(LOGO_SIZES).optional(),
});

export const buttonsSchema = object<NonNullable<AtlasDesign['buttons']>>({
  style: enumOf(BUTTON_STYLES).optional(),
  socialLayout: enumOf(SOCIAL_LAYOUTS).optional(),
});

export const inputsSchema = object<NonNullable<AtlasDesign['inputs']>>({ style: enumOf(INPUT_STYLES).optional() });

export const gradientSchema = object<DesignGradient>({
  type: enumOf(GRADIENT_TYPES),
  /** Degrees; linear only. */
  angle: int(0, 360).optional(),
  stops: array(object<{ color: string; at: number }>({ color: hexColor, at: number({ min: 0, max: 100 }) }), 2, 4),
});

export const backgroundImageSchema = object<DesignBackgroundImage>({
  assetId,
  fit: enumOf(IMAGE_FITS).optional(),
  position: enumOf(IMAGE_POSITIONS).optional(),
  overlay: object<{ color: string; opacity: number }>({ color: hexColor, opacity: number({ min: 0, max: 1 }) }).optional(),
  blur: int(0, 20).optional(),
});

/**
 * A page background: a colour, a gradient, an uploaded image and a pattern,
 * painted bottom-to-top in that order. Atomic on resolve — a design that sets
 * `background` REPLACES the preset's background wholesale (so a preset's photo
 * cannot leak under a customer's plain colour).
 */
export const backgroundSchema = object<DesignBackground>({
  color: hexColor.optional(),
  gradient: gradientSchema.optional(),
  image: backgroundImageSchema.optional(),
  pattern: enumOf(BACKGROUND_PATTERNS).optional(),
});

export const logoSchema = object<NonNullable<AtlasDesign['logo']>>({
  /** Uploaded logo for light mode. */
  assetId: assetId.optional(),
  /** Uploaded logo for dark mode; falls back to `assetId`. */
  darkAssetId: assetId.optional(),
});

export const designSchema = object<AtlasDesign>({
  version: literal(1).optional(),
  preset: enumOf(PRESET_IDS).optional(),
  colorScheme: enumOf(COLOR_SCHEMES).optional(),
  palette: paletteSchema.optional(),
  paletteDark: paletteSchema.optional(),
  typography: typographySchema.optional(),
  shape: shapeSchema.optional(),
  elevation: elevationSchema.optional(),
  spacing: spacingSchema.optional(),
  card: cardSchema.optional(),
  layout: layoutSchema.optional(),
  buttons: buttonsSchema.optional(),
  inputs: inputsSchema.optional(),
  background: backgroundSchema.optional(),
  backgroundDark: backgroundSchema.optional(),
  logo: logoSchema.optional(),
});

// ---- partial updates -------------------------------------------------------------

/**
 * Make every object field optional AND nullable, recursively. `null` is the
 * patch's "delete this key"; arrays (gradient stops) are left as-is because
 * they replace wholesale. Strictness is preserved at every level.
 */
function toPatch(schema: Schema<unknown>): Schema<unknown> {
  let inner = schema;
  while (inner._zod.def.type === 'optional' || inner._zod.def.type === 'nullable') inner = inner._zod.def.innerType!;
  const def = inner._zod.def;
  if (def.type === 'object') {
    const next: Record<string, Schema<unknown>> = {};
    for (const [k, v] of Object.entries(def.shape!)) next[k] = toPatch(v).nullable().optional();
    return object(next);
  }
  return inner;
}

/**
 * A partial update to a stored design: nested objects merge, arrays and scalars
 * replace, an explicit `null` removes the key (falling back to the preset).
 * Apply with `applyDesignPatch`, which re-validates the merged result.
 */
export const designPatchSchema = toPatch(designSchema as Schema<unknown>) as Schema<DesignPatch>;
export type DesignPatch = DeepPatch<AtlasDesign>;
type DeepPatch<T> = {
  [K in keyof T]?: NonNullable<T[K]> extends readonly unknown[]
    ? T[K] | null
    : NonNullable<T[K]> extends object
      ? DeepPatch<NonNullable<T[K]>> | null
      : T[K] | null;
};

// ---- validation with full paths ------------------------------------------------

/** Schema issues → one problem per offending key, unknown keys named with their full path. */
export function zodProblems(error: SchemaError, prefix = ''): DesignProblem[] {
  const out: DesignProblem[] = [];
  const join = (parts: PropertyKey[]) =>
    [prefix, ...parts.map(String)].filter((p) => p !== '').join('.');
  for (const issue of error.issues) {
    if (issue.code === 'unrecognized_keys') {
      for (const key of issue.keys ?? []) {
        out.push({ path: join([...issue.path, key]), message: `Unknown setting "${key}".` });
      }
    } else {
      out.push({ path: join(issue.path) || prefix || '(root)', message: issue.message });
    }
  }
  return out;
}


/** Validate a stored design (overrides). Unknown keys are refused with their full path. */
export function validateDesign(input: unknown): DesignValidation<AtlasDesign> {
  const r = designSchema.safeParse(input);
  return r.success ? { ok: true, value: r.data } : { ok: false, problems: zodProblems(r.error) };
}

/** Validate a design PATCH (nullable leaves). */
export function validateDesignPatch(input: unknown): DesignValidation<DesignPatch> {
  const r = designPatchSchema.safeParse(input);
  return r.success ? { ok: true, value: r.data } : { ok: false, problems: zodProblems(r.error) };
}
