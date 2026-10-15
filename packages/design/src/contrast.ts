/**
 * WCAG 2.x contrast arithmetic for design palettes — the ONE implementation the
 * design warnings, the compiler's derived ink colours and the legacy-branding
 * migration share. (Ported from Forumulate's shared `contrast.ts` and web
 * `theme-contrast.ts`.)
 */

export interface RGBA {
  r: number;
  g: number;
  b: number;
  a: number;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** Parse `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb()`/`rgba()` (comma or space syntax). */
export function parseCssColor(input: string | null | undefined): RGBA | null {
  if (!input || typeof input !== 'string') return null;
  const s = input.trim().toLowerCase();
  if (s === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  const hex = /^#([0-9a-f]{3,8})$/.exec(s);
  if (hex) {
    let h = hex[1]!;
    if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('');
    if (h.length !== 6 && h.length !== 8) return null;
    const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
    return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) / 255 : 1 };
  }
  const fn = /^rgba?\(([^)]+)\)$/.exec(s);
  if (!fn) return null;
  const parts = fn[1]!.replace('/', ' ').split(/[\s,]+/).filter(Boolean);
  if (parts.length < 3) return null;
  const chan = (p: string) => (p.endsWith('%') ? (parseFloat(p) / 100) * 255 : parseFloat(p));
  const alpha = (p: string | undefined) =>
    p === undefined ? 1 : p.endsWith('%') ? parseFloat(p) / 100 : parseFloat(p);
  const c = {
    r: clamp(chan(parts[0]!), 0, 255),
    g: clamp(chan(parts[1]!), 0, 255),
    b: clamp(chan(parts[2]!), 0, 255),
    a: clamp(alpha(parts[3]), 0, 1),
  };
  return [c.r, c.g, c.b, c.a].some(Number.isNaN) ? null : c;
}

/** `top` painted over `under` (source-over). */
export function composite(top: RGBA, under: RGBA): RGBA {
  const a = top.a + under.a * (1 - top.a);
  if (a === 0) return { r: 0, g: 0, b: 0, a: 0 };
  const mix = (t: number, u: number) => (t * top.a + u * under.a * (1 - top.a)) / a;
  return { r: mix(top.r, under.r), g: mix(top.g, under.g), b: mix(top.b, under.b), a };
}

const hex2 = (n: number) => clamp(Math.round(n), 0, 255).toString(16).padStart(2, '0');

/** An opaque colour as `#rrggbb` (alpha ignored — composite first if it matters). */
export function toHex(c: RGBA): string {
  return `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}`;
}

/** Linear mix of two hex colours: `weight` of `a`, the rest `b`. */
export function mixHex(a: string, b: string, weight: number): string {
  const x = parseCssColor(a);
  const y = parseCssColor(b);
  if (!x || !y) return a;
  const w = clamp(weight, 0, 1);
  return toHex({
    r: x.r * w + y.r * (1 - w),
    g: x.g * w + y.g * (1 - w),
    b: x.b * w + y.b * (1 - w),
    a: 1,
  });
}

/** WCAG relative luminance of an opaque colour. */
export function luminance(c: RGBA): number {
  const lin = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
}

/** Relative luminance of a hex colour, or null when it is not one. */
export function relativeLuminance(hex: string): number | null {
  const c = parseCssColor(hex);
  return c ? luminance(c) : null;
}

/**
 * The WCAG contrast ratio of two colours, 1–21. Returns 1 (the worst possible,
 * so a caller that forgets to check cannot accidentally pass) when either is
 * unparseable.
 */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  if (la === null || lb === null) return 1;
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

/** AA minimum for body text. */
export const AA_TEXT = 4.5;
/** AA minimum for large text and UI components. */
export const AA_LARGE = 3;

/**
 * Readable text ON a colour — near-black or near-white, whichever wins (the
 * WCAG 0.179 luminance split). Used for `primaryInk` when a design leaves it unset.
 */
export function readableOn(hex: string): string {
  return (relativeLuminance(hex) ?? 0) > 0.179 ? '#111827' : '#ffffff';
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const rr = r / 255;
  const gg = g / 255;
  const bb = b / 255;
  const max = Math.max(rr, gg, bb);
  const min = Math.min(rr, gg, bb);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h =
    max === rr
      ? ((gg - bb) / d + (gg < bb ? 6 : 0)) / 6
      : max === gg
        ? ((bb - rr) / d + 2) / 6
        : ((rr - gg) / d + 4) / 6;
  return [h, s, l];
}

function hslToHex(h: number, s: number, l: number): string {
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue = (t: number): number => {
    let x = t;
    if (x < 0) x += 1;
    if (x > 1) x -= 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  const out = s === 0 ? [l, l, l] : [hue(h + 1 / 3), hue(h), hue(h - 1 / 3)];
  return `#${out.map((v) => hex2(clamp(v, 0, 1) * 255)).join('')}`;
}

/**
 * `hex`, moved along its lightness axis until it clears `target` against every
 * colour in `papers` — darker on light papers, lighter on dark ones. Hue and
 * saturation are preserved so it still reads as the brand. A colour that
 * already passes is returned unchanged; one that cannot pass at any lightness
 * comes back at the most readable extreme reached.
 */
export function readableInk(hex: string, papers: readonly string[], target: number = AA_TEXT): string {
  const c = parseCssColor(hex);
  if (!c || papers.length === 0) return hex;
  const passes = (x: string) => papers.every((p) => contrastRatio(x, p) >= target);
  if (passes(hex)) return hex;
  const paperL = relativeLuminance(papers[0]!) ?? 1;
  const step = paperL > 0.179 ? -0.01 : 0.01;
  const [h, s, l] = rgbToHsl(c.r, c.g, c.b);
  let best = hex;
  for (let i = 1; i <= 100; i += 1) {
    const next = l + step * i;
    if (next < 0 || next > 1) break;
    best = hslToHex(h, s, next);
    if (passes(best)) return best;
  }
  return best;
}

/**
 * The default keyboard focus-ring colour for `primary`: the primary itself when
 * it already clears 3:1 (WCAG 1.4.11 non-text contrast) against every colour in
 * `papers`, else the primary moved along its lightness axis until it does —
 * the same rule {@link readableInk} applies to text, at the UI-component
 * threshold. A light brand colour (mint `#22f79a` scores ~1.4:1 on white) gets a
 * darker shade of itself instead of a ring nobody can see. An unparseable
 * primary is returned unchanged.
 */
export function focusRingColor(primary: string, papers: readonly string[]): string {
  return readableInk(primary, papers, AA_LARGE);
}
