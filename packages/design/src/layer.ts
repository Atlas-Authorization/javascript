import { sanitizeDesign } from './resolve';
import type { AtlasDesign } from './schema';

/**
 * Stack one design's OVERRIDES on top of another's, producing a single override
 * object — e.g. an organization's override over its instance design. Every
 * surface that layers designs uses this one function (the hosted page, the
 * organization API and the dashboard editor's preview), so what the editor
 * previews is what the page renders.
 *
 * Same semantics as `resolveDesign` uses for its preset → overrides step:
 *  - sections merge per field; `background`, `backgroundDark`, `logo` replace wholesale;
 *  - a brand colour set in `palette` (and not in `paletteDark`) carries into dark mode;
 *  - setting `primary` without `primaryInk` drops the inherited ink so it is
 *    re-derived for the new colour (same for `font` → `headingFont`);
 *  - a `background` without a `backgroundDark` carries its image + pattern to dark.
 */
const ATOMIC = new Set(['background', 'backgroundDark', 'logo']);
const BRAND_SLOTS = ['primary', 'accent', 'danger', 'success'] as const;
const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);

const isPlain = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

export function layerDesignOverrides(base: AtlasDesign, over: AtlasDesign | null | undefined): AtlasDesign {
  if (!over) return base;
  const out: Record<string, unknown> = JSON.parse(JSON.stringify(base));
  const o = JSON.parse(JSON.stringify(over)) as Record<string, unknown>;

  // Brand carry into dark (before the generic merge so the dark section sees it).
  const pal = isPlain(o.palette) ? (o.palette as Record<string, string>) : undefined;
  if (pal) {
    const dark = isPlain(o.paletteDark) ? { ...(o.paletteDark as Record<string, string>) } : {};
    let carried = false;
    for (const slot of BRAND_SLOTS) {
      if (pal[slot] && !dark[slot]) {
        dark[slot] = pal[slot]!;
        carried = true;
      }
    }
    if (carried && pal.primaryInk && !dark.primaryInk && dark.primary === pal.primary) dark.primaryInk = pal.primaryInk;
    if (Object.keys(dark).length) o.paletteDark = dark;
  }
  if (isPlain(o.background) && !isPlain(o.backgroundDark)) {
    const bg = o.background as Record<string, unknown>;
    const carried: Record<string, unknown> = {};
    if (bg.image) carried.image = bg.image;
    if (bg.pattern) carried.pattern = bg.pattern;
    o.backgroundDark = carried;
  }

  for (const [k, v] of Object.entries(o)) {
    if (FORBIDDEN.has(k) || v === undefined) continue;
    if (ATOMIC.has(k) || !isPlain(v) || !isPlain(out[k])) {
      out[k] = v;
      continue;
    }
    const merged: Record<string, unknown> = { ...(out[k] as Record<string, unknown>), ...v };
    if ((k === 'palette' || k === 'paletteDark') && 'primary' in v && !('primaryInk' in v)) delete merged.primaryInk;
    if (k === 'typography' && 'font' in v && !('headingFont' in v)) delete merged.headingFont;
    out[k] = merged;
  }
  return sanitizeDesign(out);
}
