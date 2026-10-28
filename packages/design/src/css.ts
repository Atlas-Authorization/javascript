import { focusRingColor, readableInk } from './contrast';
import { fontById, fontSheetPath, fontStack } from './fonts';
import {
  ASSET_ID,
  BACKGROUND_PATTERNS,
  BUTTON_STYLES,
  CARD_SHADOWS,
  CARD_STYLES,
  CARD_WIDTHS,
  DENSITIES,
  HEX_COLOR,
  IMAGE_FITS,
  IMAGE_POSITIONS,
  INPUT_STYLES,
  LAYOUT_POSITIONS,
  LETTER_CASES,
  LOGO_PLACEMENTS,
  LOGO_SIZES,
  SOCIAL_LAYOUTS,
  SPLIT_SIDES,
  TYPE_SCALES,
  type ResolvedDesign,
  type ResolvedPalette,
} from './vocab';
import type { DesignBackground } from './schema';

/**
 * The design → CSS compiler.
 *
 * Output is ONLY custom properties (the documented, stable set in
 * {@link DESIGN_CSS_VARIABLES}) inside rules whose selectors we build. Templates
 * — the hosted page, the SDK components — consume the variables and select
 * structural variants on {@link designDataAttributes}. Nothing a customer typed
 * is ever a selector, a property name or free text.
 *
 * Defence in depth: the input is a `ResolvedDesign`, which the schema already
 * constrained, but the compiler trusts none of it. Every value is re-validated
 * at output — a colour must re-match `#RRGGBB` (else the variable is dropped),
 * numbers are finite-checked and clamped, enums go through constant lookup
 * tables, fonts come only from the catalog, and an image URL is built only from
 * a validated asset id through the caller's `assetUrl` and must itself match a
 * strict URL grammar. A final check refuses to return text containing `<`, a
 * backslash, `@import`, `expression(` or `javascript:`.
 */

/**
 * The variable names the compiler may emit (the documented set in
 * `DESIGN_CSS_VARIABLES`, ./css-variables.ts — a test keeps them equal).
 */
export const DESIGN_CSS_VARIABLE_NAMES: ReadonlySet<string> = /* @__PURE__ */ new Set([
  '--atlas-color-primary',
  '--atlas-color-primary-ink',
  '--atlas-color-primary-text',
  '--atlas-color-accent',
  '--atlas-color-background',
  '--atlas-color-surface',
  '--atlas-color-text',
  '--atlas-color-muted',
  '--atlas-color-border',
  '--atlas-color-danger',
  '--atlas-color-success',
  '--atlas-color-input-background',
  '--atlas-color-input-text',
  '--atlas-color-focus-ring',
  '--atlas-focus-outline-color',
  '--atlas-font-body',
  '--atlas-font-heading',
  '--atlas-font-size-base',
  '--atlas-font-size-sm',
  '--atlas-font-size-lg',
  '--atlas-font-size-title',
  '--atlas-font-weight-body',
  '--atlas-font-weight-heading',
  '--atlas-type-scale',
  '--atlas-button-text-transform',
  '--atlas-button-letter-spacing',
  '--atlas-radius-card',
  '--atlas-radius-control',
  '--atlas-border-width',
  '--atlas-card-border-width',
  '--atlas-shadow-card',
  '--atlas-card-background',
  '--atlas-card-blur',
  '--atlas-card-width',
  '--atlas-space-unit',
  '--atlas-space-card',
  '--atlas-space-gap',
  '--atlas-control-height',
  '--atlas-logo-size',
  '--atlas-bg-color',
  '--atlas-bg-gradient',
  '--atlas-bg-image',
  '--atlas-bg-size',
  '--atlas-bg-position',
  '--atlas-bg-overlay',
  '--atlas-bg-blur',
  '--atlas-bg-pattern-color',
]);

// ---- output-time validators ---------------------------------------------------

const hex = (v: unknown): string | undefined =>
  typeof v === 'string' && HEX_COLOR.test(v) ? v.toLowerCase() : undefined;

const num = (v: unknown, min: number, max: number): number | undefined => {
  if (typeof v !== 'number' || !Number.isFinite(v)) return undefined;
  return Math.round(Math.min(max, Math.max(min, v)) * 100) / 100;
};

const px = (v: number | undefined): string | undefined => (v === undefined ? undefined : `${v}px`);

/** Constant lookup: only an own key of `table` that is also in `allowed` yields a value. */
function pick<T extends string, R>(allowed: readonly T[], table: Record<T, R>, v: unknown): R | undefined {
  if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) return undefined;
  return Object.prototype.hasOwnProperty.call(table, v) ? table[v as T] : undefined;
}

const rgbA = (h: string | undefined, alpha: number): string | undefined => {
  if (!h) return undefined;
  const a = num(alpha, 0, 1);
  if (a === undefined) return undefined;
  const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
  return `rgb(${n(1)} ${n(3)} ${n(5)} / ${a})`;
};

const SHADOWS: Record<(typeof CARD_SHADOWS)[number], string> = {
  none: 'none',
  sm: '0 1px 2px rgba(0,0,0,0.05)',
  md: '0 12px 40px rgba(0,0,0,0.12)',
  lg: '0 4px 12px rgba(0,0,0,0.08), 0 16px 48px rgba(0,0,0,0.14)',
  xl: '0 8px 24px rgba(0,0,0,0.12), 0 32px 80px rgba(0,0,0,0.24)',
};
const CARD_WIDTH_PX: Record<(typeof CARD_WIDTHS)[number], number> = { narrow: 340, normal: 380, wide: 460 };
const LOGO_PX: Record<(typeof LOGO_SIZES)[number], number> = { sm: 32, md: 48, lg: 64 };
const DENSITY: Record<(typeof DENSITIES)[number], { unit: number; card: number; gap: number; control: number }> = {
  compact: { unit: 3, card: 20, gap: 10, control: 36 },
  comfortable: { unit: 4, card: 28, gap: 14, control: 40 },
  spacious: { unit: 5, card: 36, gap: 18, control: 46 },
};
const CASE: Record<(typeof LETTER_CASES)[number], { transform: string; spacing: string }> = {
  none: { transform: 'none', spacing: '0px' },
  uppercase: { transform: 'uppercase', spacing: '0.04em' },
};
const FITS: Record<(typeof IMAGE_FITS)[number], string> = { cover: 'cover', contain: 'contain' };
const POSITIONS: Record<(typeof IMAGE_POSITIONS)[number], string> = {
  'top-left': 'left top',
  top: 'center top',
  'top-right': 'right top',
  left: 'left center',
  center: 'center center',
  right: 'right center',
  'bottom-left': 'left bottom',
  bottom: 'center bottom',
  'bottom-right': 'right bottom',
};
const CARD_STYLE_LIST = CARD_STYLES;

/** A URL safe to put inside `url("…")`: https (or http on loopback, for dev) or a root-relative path; no quotes, parens, spaces or backslashes. */
const SAFE_URL =
  /^(?:https:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?\/|http:\/\/(?:localhost|127\.0\.0\.1)(?::\d{1,5})?\/|\/(?!\/))[A-Za-z0-9\-._~:/?&=%+@,]*$/;

export function safeAssetUrl(assetUrl: (id: string) => string, id: unknown): string | undefined {
  if (typeof id !== 'string' || !ASSET_ID.test(id)) return undefined;
  let url: unknown;
  try {
    url = assetUrl(id);
  } catch {
    return undefined;
  }
  if (typeof url !== 'string' || url.length > 2048 || !SAFE_URL.test(url)) return undefined;
  return url;
}

/** Selector scopes we build rules around: a simple selector, no combinator lists, no braces. */
const SAFE_SCOPE = /^[A-Za-z0-9_\-.#:[\]="' *()]{1,200}$/;

export interface CompileDesignCssOptions {
  /** The selector the variables are scoped to, e.g. `:root` or `.atlas-root`. */
  scope: string;
  /** Maps an uploaded asset id to its public URL. Required for background images. */
  assetUrl?: (assetId: string) => string;
  /**
   * Let the host page's `--atlas-host-*` variables (the shared UI-kit names) win over
   * the design where the page sets them: each mapped variable compiles to
   * `var(--atlas-host-…, <design value>)`. For components embedded on a customer's
   * page (the SDK scope); Atlas's own hosted pages leave it off.
   */
  hostVariables?: boolean;
}

/**
 * The host-page variables an embedded component reads, and the design
 * variables each one feeds. `--atlas-host-focus-ring` always has a visible fallback.
 */
export const HOST_VARIABLE_MAP: Readonly<Record<string, string>> = Object.freeze({
  '--atlas-color-primary': '--atlas-host-accent',
  '--atlas-color-primary-ink': '--atlas-host-accent-ink',
  '--atlas-color-surface': '--atlas-host-surface',
  '--atlas-card-background': '--atlas-host-surface',
  '--atlas-color-text': '--atlas-host-ink',
  '--atlas-color-border': '--atlas-host-line',
  '--atlas-radius-control': '--atlas-host-radius',
  '--atlas-font-body': '--atlas-host-font',
  '--atlas-focus-outline-color': '--atlas-host-focus-ring',
});

type Vars = [string, string | undefined][];

function paletteVars(p: ResolvedPalette, d: ResolvedDesign, bg: DesignBackground, mode: 'light' | 'dark', opts: CompileDesignCssOptions): Vars {
  const primary = hex(p.primary);
  const surface = hex(p.surface);
  const text = hex(p.text);
  const cardStyle = pick(CARD_STYLE_LIST, { solid: 'solid', glass: 'glass', outline: 'outline', none: 'none' } as const, d.card?.style) ?? 'solid';
  const cardBg =
    cardStyle === 'none'
      ? 'transparent'
      : cardStyle === 'glass'
        ? rgbA(surface, mode === 'light' ? 0.72 : 0.6)
        : surface;

  const vars: Vars = [
    ['--atlas-color-primary', primary],
    ['--atlas-color-primary-ink', hex(p.primaryInk)],
    ['--atlas-color-primary-text', primary && surface ? hex(readableInk(primary, [surface])) : primary],
    ['--atlas-color-accent', hex(p.accent)],
    ['--atlas-color-background', hex(p.background)],
    ['--atlas-color-surface', surface],
    ['--atlas-color-text', text],
    ['--atlas-color-muted', hex(p.muted)],
    ['--atlas-color-border', hex(p.border)],
    ['--atlas-color-danger', hex(p.danger)],
    ['--atlas-color-success', hex(p.success)],
    ['--atlas-color-input-background', hex(p.inputBackground)],
    ['--atlas-color-input-text', hex(p.inputText)],
    ['--atlas-color-focus-ring', rgbA(primary, 0.35)],
    // The solid keyboard outline: the primary, darkened/lightened to 3:1 on the
    // page background and the card (the glow above is translucent, not an outline).
    [
      '--atlas-focus-outline-color',
      primary ? hex(focusRingColor(primary, [hex(p.background), surface].filter((c): c is string => !!c))) : undefined,
    ],
    ['--atlas-card-background', cardBg],
    ...backgroundVars(bg, p, opts),
    ['--atlas-bg-pattern-color', rgbA(text, 0.08)],
  ];
  return vars;
}

function gradientCss(g: DesignBackground['gradient']): string | undefined {
  if (!g || typeof g !== 'object' || !Array.isArray(g.stops)) return undefined;
  const stops = g.stops
    .slice(0, 4)
    .map((s) => {
      const c = hex(s?.color);
      const at = num(s?.at, 0, 100);
      return c && at !== undefined ? `${c} ${at}%` : undefined;
    })
    .filter((s): s is string => !!s);
  if (stops.length < 2) return undefined;
  if (g.type === 'radial') return `radial-gradient(circle at center, ${stops.join(', ')})`;
  if (g.type !== 'linear') return undefined;
  const angle = num(g.angle ?? 180, 0, 360) ?? 180;
  return `linear-gradient(${angle}deg, ${stops.join(', ')})`;
}

function backgroundVars(bg: DesignBackground, p: ResolvedPalette, opts: CompileDesignCssOptions): Vars {
  const b = bg && typeof bg === 'object' ? bg : {};
  const img = b.image && typeof b.image === 'object' ? b.image : undefined;
  const url = img && opts.assetUrl ? safeAssetUrl(opts.assetUrl, img.assetId) : undefined;
  const overlay = url && img?.overlay ? rgbA(hex(img.overlay.color), img.overlay.opacity) : undefined;
  return [
    ['--atlas-bg-color', hex(b.color) ?? hex(p.background)],
    ['--atlas-bg-gradient', gradientCss(b.gradient) ?? 'none'],
    ['--atlas-bg-image', url ? `url("${url}")` : 'none'],
    ['--atlas-bg-size', pick(IMAGE_FITS, FITS, img?.fit) ?? 'cover'],
    ['--atlas-bg-position', pick(IMAGE_POSITIONS, POSITIONS, img?.position) ?? 'center center'],
    ['--atlas-bg-overlay', overlay ?? 'transparent'],
    ['--atlas-bg-blur', px(url ? (num(img?.blur ?? 0, 0, 20) ?? 0) : 0)],
  ];
}

function staticVars(d: ResolvedDesign): Vars {
  const t = d.typography ?? ({} as ResolvedDesign['typography']);
  const base = num(t.baseSize, 12, 20) ?? 15;
  const ratio = Object.prototype.hasOwnProperty.call(TYPE_SCALES, t.scale)
    ? TYPE_SCALES[t.scale as keyof typeof TYPE_SCALES]
    : TYPE_SCALES['perfect-fourth'];
  const weight = (v: unknown, min: number, max: number, dflt: number) => {
    const n = num(v, min, max);
    return String(n === undefined ? dflt : Math.round(n / 100) * 100);
  };
  const letter = pick(LETTER_CASES, CASE, t.letterCase) ?? CASE.none;
  const shape = d.shape ?? ({} as ResolvedDesign['shape']);
  const borderWidth = num(shape.borderWidth, 0, 3) ?? 1;
  const cardStyle = pick(CARD_STYLE_LIST, { solid: 'solid', glass: 'glass', outline: 'outline', none: 'none' } as const, d.card?.style) ?? 'solid';
  const cardBorder = cardStyle === 'none' ? 0 : cardStyle === 'outline' ? Math.max(1, borderWidth) : borderWidth;
  const shadow =
    cardStyle === 'outline' || cardStyle === 'none'
      ? 'none'
      : (pick(CARD_SHADOWS, SHADOWS, d.elevation?.cardShadow) ?? SHADOWS.md);
  const density = pick(DENSITIES, DENSITY, d.spacing?.density) ?? DENSITY.comfortable;
  const round1 = (n: number) => Math.round(n * 10) / 10;
  return [
    ['--atlas-font-body', fontById(t.font) ? fontStack(t.font) : fontStack('system')],
    ['--atlas-font-heading', fontById(t.headingFont) ? fontStack(t.headingFont) : fontById(t.font) ? fontStack(t.font) : fontStack('system')],
    ['--atlas-font-size-base', px(base)],
    ['--atlas-font-size-sm', px(round1(base * 0.867))],
    ['--atlas-font-size-lg', px(round1(base * Math.sqrt(ratio)))],
    ['--atlas-font-size-title', px(round1(base * ratio))],
    ['--atlas-font-weight-body', weight(t.bodyWeight, 300, 600, 400)],
    ['--atlas-font-weight-heading', weight(t.headingWeight, 400, 800, 600)],
    ['--atlas-type-scale', String(ratio)],
    ['--atlas-button-text-transform', letter.transform],
    ['--atlas-button-letter-spacing', letter.spacing],
    ['--atlas-radius-card', px(num(shape.radius, 0, 32) ?? 12)],
    ['--atlas-radius-control', px(num(shape.controlRadius, 0, 999) ?? 8)],
    ['--atlas-border-width', px(borderWidth)],
    ['--atlas-card-border-width', px(cardBorder)],
    ['--atlas-shadow-card', shadow],
    ['--atlas-card-blur', px(cardStyle === 'glass' ? (num(d.card?.blur, 0, 40) ?? 16) : 0)],
    ['--atlas-card-width', px(pick(CARD_WIDTHS, CARD_WIDTH_PX, d.card?.width) ?? CARD_WIDTH_PX.normal)],
    ['--atlas-space-unit', px(density.unit)],
    ['--atlas-space-card', px(density.card)],
    ['--atlas-space-gap', px(density.gap)],
    ['--atlas-control-height', px(density.control)],
    ['--atlas-logo-size', px(pick(LOGO_SIZES, LOGO_PX, d.layout?.logoSize) ?? LOGO_PX.md)],
  ];
}

const block = (selector: string, vars: Vars, host = false): string => {
  const body = vars
    .filter((v): v is [string, string] => typeof v[1] === 'string' && DESIGN_CSS_VARIABLE_NAMES.has(v[0]))
    .map(([k, v]) => {
      const fd = host && Object.prototype.hasOwnProperty.call(HOST_VARIABLE_MAP, k) ? HOST_VARIABLE_MAP[k] : undefined;
      return fd ? `${k}:var(${fd},${v});` : `${k}:${v};`;
    })
    .join('');
  return `${selector}{${body}}`;
};

const FORBIDDEN_OUTPUT = /[<>\\]|@import|expression\s*\(|javascript:|\/\*/i;

/**
 * Compile a resolved design to a stylesheet of custom properties.
 *
 *   <scope>{…static + default-mode vars…}
 *   <scope>[data-atlas-theme="light"]{…light vars…}
 *   <scope>[data-atlas-theme="dark"]{…dark vars…}
 *   @media (prefers-color-scheme:dark){<scope>:not([data-atlas-theme="light"]){…dark vars…}}   (auto only)
 *
 * The default mode is dark when the design forces dark, otherwise light. The
 * attribute blocks let a host toggle modes; {@link designDataAttributes} sets
 * `data-atlas-theme` when the design forces one.
 */
export function compileDesignCss(d: ResolvedDesign, opts: CompileDesignCssOptions): string {
  const scope = typeof opts?.scope === 'string' ? opts.scope.trim() : '';
  if (!SAFE_SCOPE.test(scope) || scope.includes('</') || scope.includes(',')) {
    throw new Error('compileDesignCss: unsafe scope selector');
  }
  const scheme = d?.colorScheme === 'dark' ? 'dark' : d?.colorScheme === 'light' ? 'light' : 'auto';
  const light = paletteVars(d.palette ?? ({} as ResolvedPalette), d, d.background ?? {}, 'light', opts);
  const dark = paletteVars(d.paletteDark ?? ({} as ResolvedPalette), d, d.backgroundDark ?? {}, 'dark', opts);

  const host = opts.hostVariables === true;
  const parts = [
    block(scope, [...staticVars(d), ...(scheme === 'dark' ? dark : light)], host),
    block(`${scope}[data-atlas-theme="light"]`, light, host),
    block(`${scope}[data-atlas-theme="dark"]`, dark, host),
  ];
  if (scheme === 'auto') {
    parts.push(
      `@media (prefers-color-scheme:dark){${block(`${scope}:not([data-atlas-theme="light"])`, dark, host)}}`,
    );
  }
  const css = parts.join('\n');
  // Unreachable by construction; a tripwire, not a sanitiser.
  if (FORBIDDEN_OUTPUT.test(css)) throw new Error('compileDesignCss: refused unsafe output');
  return css;
}

/**
 * Enum-valued data attributes for the element the design is scoped to.
 * Templates select structural variants on these (`[data-atlas-card="glass"]`).
 * Every value is from a closed list; an out-of-list value falls back to the
 * default rather than being emitted.
 */
export function designDataAttributes(d: ResolvedDesign): Record<string, string> {
  const one = <T extends string>(allowed: readonly T[], v: unknown, dflt: T): T =>
    typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : dflt;
  const bg = d?.background ?? {};
  const attrs: Record<string, string> = {
    'data-atlas-layout': one(LAYOUT_POSITIONS, d?.layout?.position, 'center'),
    'data-atlas-split-side': one(SPLIT_SIDES, d?.layout?.splitImageSide, 'left'),
    'data-atlas-logo': one(LOGO_PLACEMENTS, d?.layout?.logoPlacement, 'card'),
    'data-atlas-logo-size': one(LOGO_SIZES, d?.layout?.logoSize, 'md'),
    'data-atlas-card': one(CARD_STYLES, d?.card?.style, 'solid'),
    'data-atlas-card-width': one(CARD_WIDTHS, d?.card?.width, 'normal'),
    'data-atlas-shadow': one(CARD_SHADOWS, d?.elevation?.cardShadow, 'md'),
    'data-atlas-density': one(DENSITIES, d?.spacing?.density, 'comfortable'),
    'data-atlas-button': one(BUTTON_STYLES, d?.buttons?.style, 'solid'),
    'data-atlas-social': one(SOCIAL_LAYOUTS, d?.buttons?.socialLayout, 'list'),
    'data-atlas-input': one(INPUT_STYLES, d?.inputs?.style, 'outline'),
    'data-atlas-pattern': one(BACKGROUND_PATTERNS, bg.pattern, 'none'),
    'data-atlas-pattern-dark': one(BACKGROUND_PATTERNS, d?.backgroundDark?.pattern, 'none'),
    'data-atlas-letter-case': one(LETTER_CASES, d?.typography?.letterCase, 'none'),
  };
  if (d?.colorScheme === 'dark' || d?.colorScheme === 'light') attrs['data-atlas-theme'] = d.colorScheme;
  return attrs;
}

/** The web-font stylesheet paths (Atlas origin) a design needs, de-duplicated. */
export function designFontSheets(d: ResolvedDesign): string[] {
  const out = new Set<string>();
  for (const id of [d?.typography?.font, d?.typography?.headingFont]) {
    const path = fontSheetPath(id);
    if (path) out.add(path);
  }
  return [...out];
}

/**
 * The bridge for an embedded component that renders without a design: maps
 * each host-page `--atlas-host-*` variable the page actually sets onto the component's
 * variables, scoped with zero specificity so a design (or the page's own
 * `--atlas-*` theming) still wins. `setVariables` are the `--atlas-host-*` names the
 * page defines (read from its computed style); unset ones are left alone, so
 * the component's built-in defaults apply.
 */
export function hostVariableBridgeCss(setVariables: readonly string[], scope = '.atlas-root'): string {
  if (!SAFE_SCOPE.test(scope) || scope.includes(',')) return '';
  const set = new Set(setVariables);
  const body = Object.entries(HOST_VARIABLE_MAP)
    .filter(([, fd]) => set.has(fd))
    .map(([k, fd]) => `${k}:var(${fd});`)
    .join('');
  return body ? `:where(${scope}){${body}}` : '';
}

/** Every `--atlas-host-*` variable an embedded component reads. */
export const HOST_VARIABLE_NAMES: readonly string[] = Object.freeze([...new Set(Object.values(HOST_VARIABLE_MAP))]);
