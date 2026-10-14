import { readableOn } from './contrast';
import { DESIGN_DEFAULTS, PRESET_DESIGNS } from './presets';
import { isValidDesign, isValidDesignSection } from './guards';
import type { AtlasDesign, DesignBackground } from './schema';
import { PRESET_IDS, type PaletteSlot, type PresetId, type ResolvedDesign, type ResolvedPalette } from './vocab';

/**
 * defaults ← preset ← overrides → a fully-resolved design.
 *
 * Merge rules (one place, documented, tested):
 *  - Field sections (`palette`, `typography`, `shape`, …) merge per field.
 *  - `background`, `backgroundDark` and `logo` are ATOMIC: a layer that sets one
 *    replaces the one below it wholesale, so a preset's photo can never show
 *    through under a customer's plain colour.
 *  - Brand colours carry into dark mode: a `palette` brand slot (primary,
 *    accent, danger, success) the customer sets is also used in `paletteDark`
 *    unless they set that dark slot too. Neutrals (background, text, …) do not
 *    carry — a light page colour in dark mode is never what anyone wants.
 *  - Derived defaults follow their source: setting `palette.primary` without
 *    `primaryInk` recomputes the ink for the new colour (readableOn); setting
 *    `typography.font` without `headingFont` uses the same font for headings.
 *  - Dark background: the customer's `backgroundDark` if set; else, if they set
 *    a light `background`, its gradient + image + pattern (artwork and photos
 *    are meant for both modes; a plain page colour is not — a light page in
 *    dark mode is never what anyone wants); else the preset's.
 *
 * Forgiving by design: a stored section that no longer validates (e.g. a font
 * removed from the catalog) is ignored rather than failing the page.
 */

const BRAND_SLOTS: readonly PaletteSlot[] = ['primary', 'accent', 'danger', 'success'];

type Layer = Omit<AtlasDesign, 'version'>;

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** Keep only the sections of `input` that validate on their own. */
export function sanitizeDesign(input: unknown): AtlasDesign {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  if (isValidDesign(input)) return clone(input) as AtlasDesign;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (v !== undefined && isValidDesignSection(k, v)) out[k] = clone(v);
  }
  return out as AtlasDesign;
}

function layerPalette(
  base: ResolvedPalette,
  over: Partial<ResolvedPalette> | undefined,
): ResolvedPalette {
  if (!over) return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) if (v !== undefined) out[k as PaletteSlot] = v;
  if (over.primary && !over.primaryInk) out.primaryInk = readableOn(over.primary);
  return out;
}

function applyLayer(r: ResolvedDesign, layer: Layer, opts: { carryBrand: boolean }): void {
  if (layer.colorScheme) r.colorScheme = layer.colorScheme;

  const lightBefore = r.palette;
  r.palette = layerPalette(r.palette, layer.palette);

  // Brand slots set in `palette` (and not in `paletteDark`) carry into dark.
  let darkOver: Partial<ResolvedPalette> | undefined = layer.paletteDark
    ? { ...layer.paletteDark }
    : undefined;
  if (opts.carryBrand && layer.palette) {
    for (const slot of BRAND_SLOTS) {
      const v = layer.palette[slot];
      if (v && v !== lightBefore[slot] && !layer.paletteDark?.[slot]) {
        darkOver = { ...(darkOver ?? {}), [slot]: v };
      }
    }
    if (layer.palette.primaryInk && !layer.paletteDark?.primaryInk && darkOver?.primary) {
      darkOver.primaryInk = layer.palette.primaryInk;
    }
  }
  r.paletteDark = layerPalette(r.paletteDark, darkOver);

  if (layer.typography) {
    const t = layer.typography;
    r.typography = {
      ...r.typography,
      ...definedOnly(t),
      headingFont: t.headingFont ?? (t.font ? t.font : r.typography.headingFont),
    } as ResolvedDesign['typography'];
  }
  if (layer.shape) r.shape = { ...r.shape, ...definedOnly(layer.shape) };
  if (layer.elevation) r.elevation = { ...r.elevation, ...definedOnly(layer.elevation) };
  if (layer.spacing) r.spacing = { ...r.spacing, ...definedOnly(layer.spacing) };
  if (layer.card) r.card = { ...r.card, ...definedOnly(layer.card) };
  if (layer.layout) r.layout = { ...r.layout, ...definedOnly(layer.layout) };
  if (layer.buttons) r.buttons = { ...r.buttons, ...definedOnly(layer.buttons) };
  if (layer.inputs) r.inputs = { ...r.inputs, ...definedOnly(layer.inputs) };

  if (layer.background) r.background = clone(layer.background);
  if (layer.backgroundDark) {
    r.backgroundDark = clone(layer.backgroundDark);
  } else if (layer.background && opts.carryBrand) {
    const carried: DesignBackground = {};
    if (layer.background.gradient) carried.gradient = clone(layer.background.gradient);
    if (layer.background.image) carried.image = clone(layer.background.image);
    if (layer.background.pattern) carried.pattern = layer.background.pattern;
    r.backgroundDark = carried;
  }
  if (layer.logo) r.logo = clone(layer.logo);
}

function definedOnly<T extends object>(o: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  return out;
}

export function isPresetId(v: unknown): v is PresetId {
  return typeof v === 'string' && (PRESET_IDS as readonly string[]).includes(v);
}

/** Resolve a stored design (overrides) to the full design every consumer renders. */
export function resolveDesign(design?: AtlasDesign | unknown): ResolvedDesign {
  const d = sanitizeDesign(design);
  const presetId: PresetId = isPresetId(d.preset) ? d.preset : 'minimal';
  const r = clone(DESIGN_DEFAULTS);
  r.preset = presetId;
  // (A preset palette that leaves primaryInk unset gets it derived in layerPalette.)
  applyLayer(r, PRESET_DESIGNS[presetId].design, { carryBrand: false });
  applyLayer(r, d, { carryBrand: true });
  return r;
}

/**
 * Layer design overrides on top of an ALREADY-RESOLVED design — what an SDK
 * component does with the instance's resolved design (from the Frontend API)
 * plus the developer's code-level overrides, when the instance's stored
 * overrides themselves are not available. Same merge rules as
 * {@link resolveDesign} (brand slots carry into dark, derived ink and heading
 * font follow their source, backgrounds are atomic). The base is re-sanitized
 * first, so a tampered or out-of-date payload cannot smuggle an invalid value
 * through; `overrides.preset` is ignored here (switch preset by resolving a new
 * base with `resolveDesign({ preset })`).
 */
export function layerDesign(base: ResolvedDesign | unknown, overrides?: AtlasDesign | unknown): ResolvedDesign {
  const r = resolveDesign(base);
  const o = sanitizeDesign(overrides);
  delete o.preset;
  applyLayer(r, o, { carryBrand: true });
  return r;
}
