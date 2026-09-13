/**
 * §10.3 theming.
 *
 * "appearance prop: design tokens (colors, radius, font, spacing) + per-element
 * class overrides (elements: { formButtonPrimary: "…" }). No iframe — components
 * render in the host DOM so Tailwind/CSS just works."
 *
 * Rendering in the host DOM is the decision everything else follows from. An
 * iframe would isolate styles perfectly and be unusable: it cannot be sized to
 * its content reliably, it breaks password managers, it breaks autofill, and a
 * Tailwind class the customer writes has no effect inside it. Sharing the DOM
 * means the customer's CSS reaches our markup, which is exactly what they want
 * and what makes an override system necessary rather than decorative.
 *
 * Element classes are APPENDED to ours, never replacing them. A customer adding
 * `className="rounded-xl"` wants a rounder button, not an unstyled one — and
 * replacement is a support burden where every override starts by rebuilding the
 * component's base styles from scratch.
 */

export interface DesignTokens {
  colorPrimary?: string;
  colorText?: string;
  colorBackground?: string;
  colorDanger?: string;
  colorBorder?: string;
  borderRadius?: string;
  fontFamily?: string;
  spacingUnit?: string;
}

/** Every element a customer may target. Named for what it IS, not where it sits. */
export type ElementKey =
  | 'root'
  | 'card'
  | 'headerTitle'
  | 'headerSubtitle'
  | 'formField'
  | 'formFieldLabel'
  | 'formFieldInput'
  | 'formFieldError'
  | 'formButtonPrimary'
  | 'formButtonSecondary'
  | 'socialButton'
  | 'dividerText'
  | 'footerAction'
  | 'avatar'
  | 'menu'
  | 'menuItem'
  | 'badge';

export interface Appearance {
  /** A prebuilt theme to start from. */
  baseTheme?: keyof typeof THEMES;
  variables?: DesignTokens;
  elements?: Partial<Record<ElementKey, string>>;
}

export const DEFAULT_TOKENS: Required<DesignTokens> = {
  colorPrimary: '#5b5bd6',
  colorText: '#1c1c1f',
  colorBackground: '#ffffff',
  colorDanger: '#d64545',
  colorBorder: '#e4e4e9',
  borderRadius: '8px',
  fontFamily: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
  spacingUnit: '4px',
};

/**
 * §10.3: "prebuilt themes shipped (default, dark, neobrutalist as a demo of the
 * override system)". Neobrutalist exists to prove the token set is expressive
 * enough for a theme that looks nothing like the default — a theming system
 * that only produces tasteful variations of itself is not a theming system.
 */
export const THEMES = {
  default: DEFAULT_TOKENS,
  dark: {
    ...DEFAULT_TOKENS,
    colorText: '#e6e9ef',
    colorBackground: '#14171c',
    colorBorder: '#242932',
    colorPrimary: '#6ea8fe',
  },
  neobrutalist: {
    ...DEFAULT_TOKENS,
    colorPrimary: '#ffe600',
    colorText: '#000000',
    colorBackground: '#ffffff',
    colorBorder: '#000000',
    borderRadius: '0px',
    fontFamily: '"Courier New", ui-monospace, monospace',
  },
} as const satisfies Record<string, Required<DesignTokens>>;

/**
 * Resolve tokens: defaults, then the base theme, then explicit variables.
 *
 * Later wins, and `undefined` never overwrites. A customer setting one variable
 * on the dark theme expects the other eleven to stay dark, not silently revert
 * to the light defaults.
 */
export function resolveTokens(appearance?: Appearance): Required<DesignTokens> {
  const base = appearance?.baseTheme ? THEMES[appearance.baseTheme] : DEFAULT_TOKENS;
  const overrides = appearance?.variables ?? {};

  const resolved = { ...DEFAULT_TOKENS, ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) resolved[key as keyof DesignTokens] = value;
  }
  return resolved;
}

/** Tokens as CSS custom properties, for the host DOM to inherit. */
export function cssVariables(tokens: Required<DesignTokens>): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const [key, value] of Object.entries(tokens)) {
    // camelCase → --atlas-kebab-case, which is what a customer writes in CSS.
    vars[`--atlas-${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`] = value;
  }
  return vars;
}

/**
 * Combine our base class with the customer's override.
 *
 * Appended, never replaced — a customer adding `rounded-xl` wants a rounder
 * button, not an unstyled one. Theirs comes last so it wins on equal
 * specificity, which is the behaviour anyone writing Tailwind expects.
 */
export function classFor(
  element: ElementKey,
  appearance: Appearance | undefined,
  base: string,
): string {
  const override = appearance?.elements?.[element];
  return override ? `${base} ${override}` : base;
}
