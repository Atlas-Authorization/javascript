/**
 * `@atlasauth/themes` — prebuilt appearance presets for Atlas hosted pages and
 * React components. The Atlas peer of `@clerk/themes`.
 *
 * Every export here is a plain, well-formed value of the `Appearance` type that
 * Atlas components already accept (defined in `@atlasauth/react`,
 * `packages/react/src/appearance.ts`). A theme is nothing more than a tasteful
 * set of design tokens (`variables`) plus a few per-element class overrides
 * (`elements`) — there are no invented fields. Pass one straight to the
 * `appearance` prop:
 *
 * ```tsx
 * import { dark } from '@atlasauth/themes';
 * <SignIn appearance={dark} />
 * ```
 *
 * The import of the type is `import type`, so this package carries no runtime
 * dependency on `@atlasauth/react` — the themes are inert data.
 *
 * @packageDocumentation
 */

import type { Appearance, DesignTokens, ElementKey } from '@atlasauth/react';

export type { Appearance, DesignTokens, ElementKey } from '@atlasauth/react';

/**
 * A neutral light base, equivalent to the Atlas default tokens expressed as an
 * {@link Appearance}. It is the implicit base that {@link experimental_createTheme}
 * merges onto, and a sensible starting point for a custom light theme.
 */
export const base: Appearance = {
  variables: {
    colorPrimary: '#5b5bd6',
    colorText: '#1c1c1f',
    colorBackground: '#ffffff',
    colorDanger: '#c53030',
    colorBorder: '#e4e4e9',
    borderRadius: '8px',
    fontFamily: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
    spacingUnit: '4px',
  },
};

/**
 * A polished dark theme: near-black surface, light high-contrast text, and a
 * soft indigo-blue accent chosen to sit comfortably above AA contrast on the
 * dark background. Borders are a quiet step above the surface rather than a
 * hard line.
 */
export const dark: Appearance = {
  variables: {
    colorPrimary: '#818cf8',
    colorText: '#e6e9ef',
    colorBackground: '#14171c',
    colorDanger: '#f87171',
    colorBorder: '#2a2f3a',
    borderRadius: '8px',
    fontFamily: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
    spacingUnit: '4px',
  },
  elements: {
    card: 'shadow-xl shadow-black/40',
    formButtonPrimary: 'font-medium',
    formFieldInput: 'bg-[#1b1f27]',
  },
};

/**
 * A deep blue / indigo dark variant — darker and cooler than {@link dark}, with
 * an indigo surface, violet accent, and matching danger tone. Good for products
 * that want a richer, more saturated night theme.
 */
export const midnight: Appearance = {
  variables: {
    colorPrimary: '#a5b4fc',
    colorText: '#e3e8ff',
    colorBackground: '#0b1020',
    colorDanger: '#fb7185',
    colorBorder: '#1e2748',
    borderRadius: '10px',
    fontFamily: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
    spacingUnit: '4px',
  },
  elements: {
    card: 'shadow-2xl shadow-indigo-950/60 ring-1 ring-indigo-500/10',
    formButtonPrimary: 'font-medium',
    formFieldInput: 'bg-[#121a33]',
    headerTitle: 'tracking-tight',
  },
};

/**
 * Bold neobrutalism: pure black borders, a vivid yellow accent, zero border
 * radius, and hard offset shadows on the raised surfaces. A deliberately loud
 * theme that doubles as proof the token + element-override set is expressive
 * enough to look nothing like the default.
 */
export const neobrutalism: Appearance = {
  variables: {
    colorPrimary: '#ffe600',
    colorText: '#000000',
    colorBackground: '#ffffff',
    colorDanger: '#ff2d2d',
    colorBorder: '#000000',
    borderRadius: '0px',
    fontFamily: '"DM Mono", "Courier New", ui-monospace, monospace',
    spacingUnit: '4px',
  },
  elements: {
    card: 'border-2 border-black shadow-[6px_6px_0_0_#000]',
    formButtonPrimary:
      'border-2 border-black font-bold uppercase tracking-wide shadow-[4px_4px_0_0_#000] hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-[2px_2px_0_0_#000]',
    formButtonSecondary: 'border-2 border-black font-bold uppercase',
    formFieldInput: 'border-2 border-black',
    socialButton: 'border-2 border-black shadow-[4px_4px_0_0_#000]',
    badge: 'border-2 border-black',
  },
};

/**
 * A neutral, shadcn-like theme: a near-neutral slate accent, calm zinc text,
 * subtle borders and a gentle radius. Mirrors the tokens of the shadcn/ui
 * default palette so Atlas components blend into a shadcn-styled app.
 */
export const shadcn: Appearance = {
  variables: {
    colorPrimary: '#18181b',
    colorText: '#09090b',
    colorBackground: '#ffffff',
    colorDanger: '#ef4444',
    colorBorder: '#e4e4e7',
    borderRadius: '6px',
    fontFamily:
      'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
    spacingUnit: '4px',
  },
  elements: {
    card: 'border border-zinc-200 shadow-sm',
    formButtonPrimary: 'font-medium',
    formFieldInput: 'border border-zinc-200',
    headerSubtitle: 'text-zinc-500',
  },
};

/** The {@link Appearance} top-level keys a theme may set. Used for validation. */
const APPEARANCE_KEYS = ['baseTheme', 'variables', 'elements'] as const;

type PlainObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is PlainObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Recursively merge `override` onto `source`. Plain objects (such as the
 * `variables` and `elements` maps) are merged key-by-key; every other value —
 * strings, including the class-override strings — is replaced. `undefined`
 * values in `override` are ignored so a partial override never blanks a field.
 */
function deepMerge<T>(source: T, override: Partial<T>): T {
  if (!isPlainObject(source) || !isPlainObject(override)) {
    return (override as T) ?? source;
  }
  const out: PlainObject = { ...source };
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue;
    const current = out[key];
    out[key] = isPlainObject(current) && isPlainObject(value)
      ? deepMerge(current, value as PlainObject)
      : value;
  }
  return out as T;
}

/**
 * Build a theme by deep-merging `overrides` onto a base — the Atlas peer of
 * Clerk's `createTheme`. `variables` and `elements` are merged field-by-field,
 * so you can tweak a single token or add one element override without restating
 * the rest of the base.
 *
 * The `experimental_` prefix mirrors Clerk: the preset values are stable, but
 * this builder's exact merge semantics may still change.
 *
 * ```ts
 * // A dark theme with a brand-green accent and a rounder card:
 * const brand = experimental_createTheme(
 *   { variables: { colorPrimary: '#16a34a' }, elements: { card: 'rounded-2xl' } },
 *   dark,
 * );
 * ```
 *
 * @param overrides Partial appearance to layer on top.
 * @param from The base theme to merge onto. Defaults to {@link base} (neutral light).
 * @returns A new {@link Appearance}; inputs are never mutated.
 */
export function experimental_createTheme(
  overrides: Appearance,
  from: Appearance = base,
): Appearance {
  return deepMerge<Appearance>(from, overrides);
}

/**
 * Every prebuilt theme this package ships, keyed by name. Handy for building a
 * theme picker:
 *
 * ```ts
 * import { themes } from '@atlasauth/themes';
 * const options = Object.keys(themes); // ['base','dark','midnight','neobrutalism','shadcn']
 * ```
 */
export const themes = { base, dark, midnight, neobrutalism, shadcn } as const;

export { APPEARANCE_KEYS };
