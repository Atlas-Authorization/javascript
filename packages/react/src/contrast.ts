/**
 * Readable text on the primary colour, for the legacy (no-design) token path.
 *
 * The primary button and the avatar paint text on `colorPrimary`. A fixed white
 * label is unreadable on a light brand colour (the neobrutalist theme's yellow
 * scores ~1.2:1), so the default `colorTextOnPrimary` is picked per primary:
 * white or near-black, whichever has the higher WCAG contrast ratio. The design
 * system does the same for `primaryInk`; this covers the token path, which also
 * has to cope with `hsl()` and with values it cannot evaluate (`var(--brand)`).
 */

import { contrastRatio, parseCssColor, toHex } from '@atlasauth/design/runtime';

const WHITE = '#ffffff';
const NEAR_BLACK = '#111111';

/** `hsl()`/`hsla()` (comma or space syntax) as `#rrggbb`, or null. */
function hslToHex(input: string): string | null {
  const m = /^hsla?\(([^)]+)\)$/.exec(input.trim().toLowerCase());
  if (!m) return null;
  const parts = m[1]!.replace('/', ' ').split(/[\s,]+/).filter(Boolean);
  if (parts.length < 3) return null;
  const h = ((((parseFloat(parts[0]!) % 360) + 360) % 360) / 360);
  const s = Math.min(1, Math.max(0, parseFloat(parts[1]!) / 100));
  const l = Math.min(1, Math.max(0, parseFloat(parts[2]!) / 100));
  if ([h, s, l].some(Number.isNaN)) return null;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue = (t: number): number => {
    const x = t < 0 ? t + 1 : t > 1 ? t - 1 : t;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  const [r, g, b] = s === 0 ? [l, l, l] : [hue(h + 1 / 3), hue(h), hue(h - 1 / 3)];
  return toHex({ r: r! * 255, g: g! * 255, b: b! * 255, a: 1 });
}

/**
 * The text colour for a label on `primary`: `#ffffff` or `#111111`, whichever
 * contrasts more. Falls back to `#ffffff` (the historical label colour) when
 * the primary cannot be evaluated — a CSS variable, a named colour, `oklch()`.
 */
export function textOnPrimary(primary: string): string {
  const parsed = parseCssColor(primary);
  const hex = parsed ? toHex(parsed) : hslToHex(primary);
  if (!hex) return WHITE;
  return contrastRatio(WHITE, hex) >= contrastRatio(NEAR_BLACK, hex) ? WHITE : NEAR_BLACK;
}
