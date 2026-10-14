/**
 * Theming — the bridge from `@atlasauth/themes` presets to the widget's
 * appearance model.
 *
 * A `@atlasauth/themes` `Appearance` carries `variables` (design tokens) and
 * `elements` (class overrides). The embedded `@atlasauth/embed` widget speaks a
 * `WidgetAppearance` whose `variables` are a slightly different token set (it
 * adds `colorAccent` / `colorCard`, has no `colorDanger` / `spacingUnit`). This
 * module maps between them so a page can say `theme: 'dark'` and have both the
 * modal chrome and the form inside it recolour from the SAME source.
 */
import type { WidgetAppearance, DesignTokens } from '@atlasauth/embed';
import type { Appearance } from '@atlasauth/themes';
import { themes } from '@atlasauth/themes';
import type { AtlasLockTheme } from './options';

/** Resolve an {@link AtlasLockTheme} to a concrete `Appearance` (or null for `'auto'`). */
export function resolveTheme(theme: AtlasLockTheme | undefined): Appearance | null {
  if (!theme || theme === 'auto') return null;
  if (typeof theme === 'string') return themes[theme] ?? null;
  return theme;
}

/** Map the `@atlasauth/themes` variable set onto the widget's `DesignTokens`. */
function tokensFromThemeVars(vars: Appearance['variables'] | undefined): DesignTokens {
  const out: DesignTokens = {};
  if (!vars) return out;
  if (vars.colorPrimary !== undefined) {
    out.colorPrimary = vars.colorPrimary;
    out.colorAccent = vars.colorPrimary;
  }
  if (vars.colorText !== undefined) out.colorText = vars.colorText;
  if (vars.colorBackground !== undefined) {
    out.colorBackground = vars.colorBackground;
    out.colorCard = vars.colorBackground;
  }
  if (vars.colorBorder !== undefined) out.colorBorder = vars.colorBorder;
  if (vars.borderRadius !== undefined) out.borderRadius = vars.borderRadius;
  if (vars.fontFamily !== undefined) out.fontFamily = vars.fontFamily;
  return out;
}

/**
 * Build the final {@link WidgetAppearance} the widget receives, layering, in
 * order of increasing precedence:
 *   1. the resolved theme preset's tokens,
 *   2. the `primaryColor` convenience override,
 *   3. the page's advanced `appearance` override (wins).
 */
export function buildWidgetAppearance(args: {
  theme?: AtlasLockTheme;
  primaryColor?: string;
  appearance?: WidgetAppearance;
}): WidgetAppearance | undefined {
  const preset = resolveTheme(args.theme);
  const variables: DesignTokens = { ...tokensFromThemeVars(preset?.variables) };

  if (args.primaryColor) {
    variables.colorPrimary = args.primaryColor;
    variables.colorAccent = args.primaryColor;
  }
  if (args.appearance?.variables) {
    Object.assign(variables, args.appearance.variables);
  }

  const appearance: WidgetAppearance = { ...args.appearance };
  if (Object.keys(variables).length) appearance.variables = variables;

  return Object.keys(appearance).length ? appearance : undefined;
}

/** The chrome tokens the modal/panel shell paints itself with. */
export interface ChromeTokens {
  colorBackground: string;
  colorText: string;
  colorPrimary: string;
  colorBorder: string;
  colorDanger: string;
  borderRadius: string;
  fontFamily: string;
}

const CHROME_FALLBACK: ChromeTokens = {
  colorBackground: '#ffffff',
  colorText: '#1c1c1f',
  colorPrimary: '#5b5bd6',
  colorBorder: '#e4e4e9',
  colorDanger: '#d64545',
  borderRadius: '10px',
  fontFamily:
    'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
};

/**
 * Resolve the tokens the shell uses for its own backdrop/header/tabs, from the
 * same preset + overrides the form gets, so the chrome and the form always
 * agree even for `theme: 'dark'`. `'auto'` keeps the neutral fallback (the
 * tenant's server appearance themes the form, but the shell has no server call).
 */
export function resolveChromeTokens(args: {
  theme?: AtlasLockTheme;
  primaryColor?: string;
  appearance?: WidgetAppearance;
}): ChromeTokens {
  const preset = resolveTheme(args.theme);
  const v = preset?.variables ?? {};
  const o = args.appearance?.variables ?? {};
  const danger = preset?.variables?.colorDanger;
  return {
    colorBackground: o.colorBackground ?? v.colorBackground ?? CHROME_FALLBACK.colorBackground,
    colorText: o.colorText ?? v.colorText ?? CHROME_FALLBACK.colorText,
    colorPrimary:
      args.primaryColor ?? o.colorPrimary ?? v.colorPrimary ?? CHROME_FALLBACK.colorPrimary,
    colorBorder: o.colorBorder ?? v.colorBorder ?? CHROME_FALLBACK.colorBorder,
    colorDanger: danger ?? CHROME_FALLBACK.colorDanger,
    borderRadius: o.borderRadius ?? v.borderRadius ?? CHROME_FALLBACK.borderRadius,
    fontFamily: o.fontFamily ?? v.fontFamily ?? CHROME_FALLBACK.fontFamily,
  };
}
