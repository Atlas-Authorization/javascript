import { z } from 'zod';
import { FONT_IDS } from './fonts';
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

export const hexColor = z.string().regex(HEX_COLOR, 'Use a 6-digit hex colour like #4F46E5.');
export const assetId = z
  .string()
  .regex(ASSET_ID, 'Use the asset_id returned by the design image upload (dasset_…).');
const int = (min: number, max: number) => z.number().int().min(min).max(max);
const enumOf = <T extends readonly [string, ...string[]]>(values: T) => z.enum(values);

// ---- sections ----------------------------------------------------------------

const paletteShape = Object.fromEntries(PALETTE_SLOTS.map((k) => [k, hexColor.optional()])) as {
  [K in (typeof PALETTE_SLOTS)[number]]: z.ZodOptional<typeof hexColor>;
};
export const paletteSchema = z.object(paletteShape).strict();

export const typographySchema = z
  .object({
    font: z.enum(FONT_IDS as [string, ...string[]]).optional(),
    headingFont: z.enum(FONT_IDS as [string, ...string[]]).optional(),
    /** Body text size in px. */
    baseSize: int(12, 20).optional(),
    headingWeight: int(400, 800).multipleOf(100).optional(),
    bodyWeight: int(300, 600).multipleOf(100).optional(),
    /** Letter case of BUTTON labels. */
    letterCase: enumOf(LETTER_CASES).optional(),
    scale: z.enum(TYPE_SCALE_NAMES as [string, ...string[]]).optional(),
  })
  .strict();

export const shapeSchema = z
  .object({
    /** Card corner radius, px. */
    radius: int(0, 32).optional(),
    /** Button + input corner radius, px; 999 = pill. */
    controlRadius: int(0, 999).optional(),
    borderWidth: int(0, 3).optional(),
  })
  .strict();

export const elevationSchema = z.object({ cardShadow: enumOf(CARD_SHADOWS).optional() }).strict();
export const spacingSchema = z.object({ density: enumOf(DENSITIES).optional() }).strict();

export const cardSchema = z
  .object({
    style: enumOf(CARD_STYLES).optional(),
    /** Backdrop blur, px. Only applied when `style` is `glass`. */
    blur: int(0, 40).optional(),
    width: enumOf(CARD_WIDTHS).optional(),
  })
  .strict();

export const layoutSchema = z
  .object({
    position: enumOf(LAYOUT_POSITIONS).optional(),
    /** Which side the image panel sits on. Only applied when `position` is `split`. */
    splitImageSide: enumOf(SPLIT_SIDES).optional(),
    logoPlacement: enumOf(LOGO_PLACEMENTS).optional(),
    logoSize: enumOf(LOGO_SIZES).optional(),
  })
  .strict();

export const buttonsSchema = z
  .object({
    style: enumOf(BUTTON_STYLES).optional(),
    socialLayout: enumOf(SOCIAL_LAYOUTS).optional(),
  })
  .strict();

export const inputsSchema = z.object({ style: enumOf(INPUT_STYLES).optional() }).strict();

export const gradientSchema = z
  .object({
    type: enumOf(GRADIENT_TYPES),
    /** Degrees; linear only. */
    angle: int(0, 360).optional(),
    stops: z
      .array(z.object({ color: hexColor, at: z.number().min(0).max(100) }).strict())
      .min(2)
      .max(4),
  })
  .strict();

export const backgroundImageSchema = z
  .object({
    assetId,
    fit: enumOf(IMAGE_FITS).optional(),
    position: enumOf(IMAGE_POSITIONS).optional(),
    overlay: z
      .object({ color: hexColor, opacity: z.number().min(0).max(1) })
      .strict()
      .optional(),
    blur: int(0, 20).optional(),
  })
  .strict();

/**
 * A page background: a colour, a gradient, an uploaded image and a pattern,
 * painted bottom-to-top in that order. Atomic on resolve — a design that sets
 * `background` REPLACES the preset's background wholesale (so a preset's photo
 * cannot leak under a customer's plain colour).
 */
export const backgroundSchema = z
  .object({
    color: hexColor.optional(),
    gradient: gradientSchema.optional(),
    image: backgroundImageSchema.optional(),
    pattern: enumOf(BACKGROUND_PATTERNS).optional(),
  })
  .strict();

export const logoSchema = z
  .object({
    /** Uploaded logo for light mode. */
    assetId: assetId.optional(),
    /** Uploaded logo for dark mode; falls back to `assetId`. */
    darkAssetId: assetId.optional(),
  })
  .strict();

export const designSchema = z
  .object({
    /** Schema version, for forward migrations. */
    version: z.literal(1).optional(),
    preset: z.enum(PRESET_IDS).optional(),
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
  })
  .strict();

/** A stored design: overrides on top of a preset. */
export type AtlasDesign = z.infer<typeof designSchema>;
export type DesignPalette = z.infer<typeof paletteSchema>;
export type DesignBackground = z.infer<typeof backgroundSchema>;
export type DesignGradient = z.infer<typeof gradientSchema>;
export type DesignBackgroundImage = z.infer<typeof backgroundImageSchema>;

// ---- partial updates -------------------------------------------------------------

/**
 * Make every object field optional AND nullable, recursively. `null` is the
 * patch's "delete this key"; arrays (gradient stops) are left as-is because
 * they replace wholesale. Strictness is preserved at every level.
 */
function toPatch(schema: z.ZodTypeAny): z.ZodTypeAny {
  let inner = schema;
  while (inner instanceof z.ZodOptional || inner instanceof z.ZodNullable) inner = inner.unwrap();
  if (inner instanceof z.ZodObject) {
    const shape = inner.shape as Record<string, z.ZodTypeAny>;
    const next: Record<string, z.ZodTypeAny> = {};
    for (const [k, v] of Object.entries(shape)) next[k] = toPatch(v).nullable().optional();
    return z.object(next).strict();
  }
  return inner;
}

/**
 * A partial update to a stored design: nested objects merge, arrays and scalars
 * replace, an explicit `null` removes the key (falling back to the preset).
 * Apply with `applyDesignPatch`, which re-validates the merged result.
 */
export const designPatchSchema = toPatch(designSchema) as z.ZodType<DesignPatch>;
export type DesignPatch = DeepPatch<AtlasDesign>;
type DeepPatch<T> = {
  [K in keyof T]?: NonNullable<T[K]> extends readonly unknown[]
    ? T[K] | null
    : NonNullable<T[K]> extends object
      ? DeepPatch<NonNullable<T[K]>> | null
      : T[K] | null;
};

// ---- validation with full paths ------------------------------------------------

/** Zod issues → one problem per offending key, unknown keys named with their full path. */
export function zodProblems(error: z.ZodError, prefix = ''): DesignProblem[] {
  const out: DesignProblem[] = [];
  const join = (parts: (string | number)[]) =>
    [prefix, ...parts.map(String)].filter((p) => p !== '').join('.');
  for (const issue of error.issues) {
    if (issue.code === 'unrecognized_keys') {
      for (const key of issue.keys) {
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
