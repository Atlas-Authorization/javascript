import { composite, parseCssColor, toHex } from './contrast';
import { compileDesignCss, designDataAttributes, designFontSheets } from './css';
import { FONT_CATALOG } from './fonts';
import { checkDesign } from './guards';
import { mergePatch } from './merge';
import { isPresetId, layerDesign, resolveDesign } from './resolve';
import type { AtlasDesign } from './schema';
import type { PresetId, ResolvedDesign } from './vocab';

/**
 * The SDK-side composition of a design: what an embedded component renders when
 * the instance has a design configured in the dashboard and/or the developer
 * passes design settings in code.
 *
 *   instance design (Frontend API, resolved)  <  appearance.preset  <  appearance.variables  <  appearance.design
 *
 * Everything a developer passes goes through the design schema: an invalid value
 * is DROPPED (with a development-only console warning naming its path), never
 * forwarded into CSS. The stylesheet is compiled here, client-side, from the
 * resolved design by {@link compileDesignCss}, which re-validates every value —
 * the CSS text the server sends is not injected as-is.
 *
 * Framework SDKs (React, Vue, Svelte, Angular, the embed widget) call
 * {@link composeDesign} and then do three framework-specific things: render the
 * `css` once in a `<style data-atlas-design="<key>">`, spread `dataAttributes` on
 * the component root, and add a `<link rel="stylesheet">` per `fontStylesheets`.
 */

declare const process: { env?: { NODE_ENV?: string } } | undefined;
declare const console: { warn(...args: unknown[]): void };

/** True outside production builds (bundlers replace `process.env.NODE_ENV`). */
export function isDevelopment(): boolean {
  try {
    return typeof process !== 'undefined' && process?.env?.NODE_ENV !== 'production';
  } catch {
    return false;
  }
}

export type DesignWarn = (message: string) => void;

const devWarn: DesignWarn = (message) => {
  if (isDevelopment()) console.warn(`[atlas] ${message}`);
};

/**
 * The pre-design-system appearance tokens every Atlas SDK accepted
 * (`appearance.variables`). Still supported: they map onto the design.
 */
export interface LegacyDesignTokens {
  colorPrimary?: string;
  colorText?: string;
  colorBackground?: string;
  colorDanger?: string;
  colorBorder?: string;
  borderRadius?: string;
  fontFamily?: string;
  spacingUnit?: string;
}

/** The `design` object of `GET /v1/appearance`. Only `resolved` is read. */
export interface InstanceDesign {
  scope?: string;
  css?: string;
  data_attributes?: Record<string, string>;
  font_stylesheets?: string[];
  resolved: ResolvedDesign;
}

// ---- validation with per-leaf dropping -------------------------------------------

type Plain = Record<string, unknown>;
const isPlain = (v: unknown): v is Plain => !!v && typeof v === 'object' && !Array.isArray(v);
const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Validate developer-supplied design overrides, keeping every valid setting and
 * DROPPING each invalid one (warned with its dotted path). Coarser than the
 * dashboard's all-or-nothing validation on purpose: a typo in one colour must
 * not throw away the rest of a working design in production.
 */
export function cleanDesign(input: unknown, warn: DesignWarn = devWarn, prefix = 'design'): AtlasDesign {
  if (input !== undefined && input !== null && (typeof input !== 'object' || Array.isArray(input))) {
    warn(`${prefix} must be an object; ignored.`);
    return {};
  }
  return checkDesign(input, (p) =>
    warn(
      p.message === 'Unknown setting.' && p.path.split('.').length === prefix.split('.').length + 1
        ? `${p.path} is not a design setting; ignored.`
        : `${p.path} is invalid; ignored.`,
    ),
  prefix);
}

// ---- legacy tokens → design ----------------------------------------------------------

/** A CSS colour as opaque `#rrggbb` (translucent colours composited on white), else undefined. */
function colorToHex(value: string): string | undefined {
  const c = parseCssColor(value);
  if (!c) return undefined;
  return toHex(c.a < 1 ? composite(c, { r: 255, g: 255, b: 255, a: 1 }) : c);
}

/** `12px` / `0.75rem` / `0` → px number; else undefined. */
function lengthToPx(value: string): number | undefined {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(px|rem|em)?\s*$/i.exec(value);
  if (!m) return undefined;
  const n = parseFloat(m[1]!);
  const unit = (m[2] ?? 'px').toLowerCase();
  return unit === 'px' ? n : n * 16;
}

/** The catalog font id whose family (or id) is the FIRST family in a CSS stack. */
export function fontIdForFamily(stack: string): string | undefined {
  const first = stack.split(',')[0]?.trim().replace(/^["']|["']$/g, '').toLowerCase();
  if (!first) return undefined;
  const hit = FONT_CATALOG.find((f) => f.id === first || f.family?.toLowerCase() === first);
  return hit?.id;
}

const LEGACY_VAR: Record<keyof LegacyDesignTokens, string> = {
  colorPrimary: '--atlas-color-primary',
  colorText: '--atlas-color-text',
  colorBackground: '--atlas-color-background',
  colorDanger: '--atlas-color-danger',
  colorBorder: '--atlas-color-border',
  borderRadius: '--atlas-border-radius',
  fontFamily: '--atlas-font-family',
  spacingUnit: '--atlas-spacing-unit',
};

/** Characters a raw token may never contain (it lands in an inline custom property). */
const UNSAFE_RAW = /[;{}<>\\]|\/\*|url\s*\(|expression\s*\(|@import|javascript:/i;

export interface TokensAsDesign {
  /** The tokens that map onto the design, as design overrides (both colour modes). */
  design: AtlasDesign;
  /**
   * Tokens that have no structured equivalent (e.g. a font family outside the
   * curated list, a colour written as `var(--brand)`), keyed by their legacy CSS
   * variable name. SDKs keep setting these as inline custom properties on the
   * root, exactly as before the design system, so they still win.
   */
  rawVariables: Record<string, string>;
}

/**
 * Map the legacy `appearance.variables` tokens onto the design.
 *
 * Tokens had no light/dark notion, so a mapped colour is applied to BOTH
 * palettes. `colorBackground` was the component (card, input, menu) background:
 * it maps to `surface` and `inputBackground`; `colorText` to `text` and
 * `inputText`; `borderRadius` to both radii; `spacingUnit` to the nearest
 * density; `fontFamily` to a curated font when its first family is one.
 */
export function designFromTokens(tokens: LegacyDesignTokens | undefined, warn: DesignWarn = devWarn): TokensAsDesign {
  const palette: Plain = {};
  const shape: Plain = {};
  const design: Plain = {};
  const rawVariables: Record<string, string> = {};
  if (!tokens || typeof tokens !== 'object') return { design: {}, rawVariables };

  const raw = (key: keyof LegacyDesignTokens, value: string) => {
    if (UNSAFE_RAW.test(value) || value.length > 200) {
      warn(`appearance.variables.${key} is not a safe CSS value; ignored.`);
      return;
    }
    rawVariables[LEGACY_VAR[key]] = value;
  };
  const color = (key: keyof LegacyDesignTokens, value: string, slots: string[]) => {
    const hex = colorToHex(value);
    if (hex) for (const s of slots) palette[s] = hex;
    else raw(key, value);
  };

  for (const key of Object.keys(LEGACY_VAR) as (keyof LegacyDesignTokens)[]) {
    const value = tokens[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string') {
      warn(`appearance.variables.${key} must be a string; ignored.`);
      continue;
    }
    switch (key) {
      case 'colorPrimary':
        color(key, value, ['primary']);
        break;
      case 'colorText':
        color(key, value, ['text', 'inputText']);
        break;
      case 'colorBackground':
        color(key, value, ['surface', 'inputBackground']);
        break;
      case 'colorDanger':
        color(key, value, ['danger']);
        break;
      case 'colorBorder':
        color(key, value, ['border']);
        break;
      case 'borderRadius': {
        const px = lengthToPx(value);
        if (px === undefined) raw(key, value);
        else {
          shape.radius = Math.min(32, Math.round(px));
          shape.controlRadius = Math.min(999, Math.round(px));
        }
        break;
      }
      case 'spacingUnit': {
        const px = lengthToPx(value);
        if (px === undefined) raw(key, value);
        else design.spacing = { density: px < 3.5 ? 'compact' : px <= 4.5 ? 'comfortable' : 'spacious' };
        break;
      }
      case 'fontFamily': {
        const id = fontIdForFamily(value);
        if (id) design.typography = { font: id };
        else raw(key, value);
        break;
      }
    }
  }
  if (Object.keys(palette).length) {
    design.palette = { ...palette };
    design.paletteDark = { ...palette };
  }
  if (Object.keys(shape).length) design.shape = shape;
  return { design: cleanDesign(design, warn, 'appearance.variables'), rawVariables };
}

// ---- composition --------------------------------------------------------------------

export interface ComposeDesignInput {
  /** `design` from `GET /v1/appearance` (null/undefined when the instance has none or it is not loaded yet). */
  instance?: InstanceDesign | null | unknown;
  /** `appearance.preset` — replaces the instance design as the base. */
  preset?: PresetId | string;
  /** `appearance.design` — structured overrides, highest precedence. */
  design?: AtlasDesign | unknown;
  /** The legacy tokens the developer set EXPLICITLY (not theme defaults). */
  tokens?: LegacyDesignTokens;
  /** Frontend API origin the font stylesheets are served from (`""` = same origin). */
  frontendApi?: string;
  /** Maps an uploaded asset id to its URL (background images); omitted = no image. */
  assetUrl?: (assetId: string) => string;
  /** Root class the design is scoped under. Default `atlas-root`. */
  rootClass?: string;
  /** Warning sink. Default: `console.warn` outside production. */
  warn?: DesignWarn;
  /**
   * Let the host page's `--atlas-host-*` variables (accent, surface, ink, line, radius,
   * font, focus ring) restyle the component where the page sets them. Default true.
   */
  hostVariables?: boolean;
}

export interface ComposedDesign {
  /** False when there is nothing to apply: render exactly as before the design system. */
  active: boolean;
  /** Stable key of this design (hash of its CSS), also the `data-atlas-design` value. */
  key: string;
  /** The selector the CSS is scoped to: `.atlas-root[data-atlas-design="<key>"]`. */
  scope: string;
  /** Custom-property stylesheet ('' when inactive). */
  css: string;
  /** Attributes for the root element (`data-atlas-*`, incl. `data-atlas-design`). */
  dataAttributes: Record<string, string>;
  /** Absolute (or same-origin) URLs of the self-hosted web-font stylesheets to link. */
  fontStylesheets: string[];
  /** Legacy token values with no structured equivalent: set inline on the root. */
  rawVariables: Record<string, string>;
  resolved: ResolvedDesign | null;
}

const INACTIVE: ComposedDesign = {
  active: false,
  key: '',
  scope: '',
  css: '',
  dataAttributes: {},
  fontStylesheets: [],
  rawVariables: {},
  resolved: null,
};

/** FNV-1a, base36 — a short stable key, not a security boundary. */
export function designKey(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

const SAFE_ORIGIN = /^(?:https:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?|http:\/\/(?:localhost|127\.0\.0\.1)(?::\d{1,5})?)$/;

function fontUrls(resolved: ResolvedDesign, frontendApi: string | undefined): string[] {
  const origin = (frontendApi ?? '').replace(/\/+$/, '');
  if (origin && !SAFE_ORIGIN.test(origin)) return [];
  return designFontSheets(resolved).map((path) => `${origin}${path}`);
}

function instanceResolved(instance: unknown): ResolvedDesign | undefined {
  if (!isPlain(instance) || !isPlain(instance.resolved)) return undefined;
  return instance.resolved as unknown as ResolvedDesign;
}

/**
 * Compose the design an embedded component renders. Inactive (render as
 * before) unless the instance has a design or the developer set
 * `preset`/`design`. Tokens alone never activate it — they keep their exact
 * pre-design-system behaviour.
 */
/**
 * The resolution half of {@link composeDesign}, without compiling CSS: the
 * resolved design (or null when there is nothing to apply). For renderers
 * that translate a design into their own styling (the embed widget) and so
 * never ship the compiler. `tokensDesign` is the output of
 * {@link designFromTokens}, if the renderer maps legacy tokens.
 */
export function resolveComposedDesign(
  input: Pick<ComposeDesignInput, 'instance' | 'preset' | 'design' | 'warn'> & { tokensDesign?: AtlasDesign },
): ResolvedDesign | null {
  const warn = input.warn ?? devWarn;
  const instance = instanceResolved(input.instance);
  const code = cleanDesign(input.design, warn, 'appearance.design');
  let preset: PresetId | undefined;
  const presetIn = input.preset ?? code.preset;
  if (presetIn !== undefined) {
    if (isPresetId(presetIn)) preset = presetIn;
    else warn(`appearance.preset "${String(presetIn)}" is not a preset; ignored.`);
  }
  const hasCode = preset !== undefined || Object.keys(code).some((k) => k !== 'preset');
  if (!instance && !hasCode) return null;

  const base = preset ? resolveDesign({ preset }) : instance ? resolveDesign(instance) : resolveDesign({});
  const overrides = mergePatch((input.tokensDesign ?? {}) as Plain, code as Plain) as AtlasDesign;
  return layerDesign(base, overrides);
}

/** The self-hosted font stylesheet URLs a resolved design needs, on the Frontend API origin. */
export function designFontUrls(resolved: ResolvedDesign, frontendApi: string | undefined): string[] {
  return fontUrls(resolved, frontendApi);
}

export function composeDesign(input: ComposeDesignInput): ComposedDesign {
  const warn = input.warn ?? devWarn;
  const { design: tokensDesign, rawVariables } = designFromTokens(input.tokens, warn);
  const resolved = resolveComposedDesign({ ...input, warn, tokensDesign });
  if (!resolved) return INACTIVE;

  const rootClass = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(input.rootClass ?? '') ? input.rootClass! : 'atlas-root';
  const key = designKey(compileDesignCss(resolved, { scope: '.k', assetUrl: input.assetUrl }));
  const scope = `.${rootClass}[data-atlas-design="${key}"]`;
  const css = compileDesignCss(resolved, { scope, assetUrl: input.assetUrl, hostVariables: input.hostVariables !== false });
  return {
    active: true,
    key,
    scope,
    css,
    dataAttributes: { ...designDataAttributes(resolved), 'data-atlas-design': key },
    fontStylesheets: fontUrls(resolved, input.frontendApi),
    rawVariables,
    resolved,
  };
}
