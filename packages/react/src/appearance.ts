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

import {
  renderDesignAppearance,
  warnOnce,
  type AppearanceRender,
  type AtlasDesign,
  type DesignWarn,
  type InstanceDesign,
  type PresetId,
} from '@atlasauth/design/runtime';
import { focusRingOn, textOnPrimary } from './contrast';

export { instanceDesignFrom, warnOnce } from '@atlasauth/design/runtime';
export type { AppearanceRender, AtlasDesign, InstanceDesign, PresetId } from '@atlasauth/design/runtime';

export interface DesignTokens {
  colorPrimary?: string;
  colorText?: string;
  colorBackground?: string;
  colorDanger?: string;
  colorBorder?: string;
  borderRadius?: string;
  fontFamily?: string;
  spacingUnit?: string;
  /**
   * Text and icon colour on a `colorPrimary` fill (the primary button label,
   * the avatar initials). Defaults to white or near-black, whichever contrasts
   * more with the resolved `colorPrimary`. With a design active, an explicit
   * value overrides the design's primary ink.
   */
  colorTextOnPrimary?: string;
  /**
   * The keyboard focus ring (a solid 2px outline on `:focus-visible`). Defaults
   * to the resolved `colorPrimary`; pick a colour with at least 3:1 contrast
   * against `colorBackground`. With a design active, an explicit value replaces
   * the design's ring colour.
   */
  colorFocusRing?: string;
}

/**
 * Every element a customer may target. Named for what it IS, not where it sits.
 *
 * Each key maps to a stable `atlas-*` base class on the rendered element; the
 * class you pass in `appearance.elements[key]` is APPENDED to it. Keys marked
 * "reserved" are accepted for forward compatibility but no current component
 * renders that element.
 */
export type ElementKey =
  /** The provider's wrapper element (`.atlas-root`). */
  | 'root'
  /** The card around a form or account section (`.atlas-card`). */
  | 'card'
  /** A component title (`.atlas-title`; page titles `.atlas-heading`). */
  | 'headerTitle'
  /** The line under a page title (`.atlas-subtitle`). */
  | 'headerSubtitle'
  /** A section heading inside a card, e.g. "Passkeys" (`.atlas-section-title`). */
  | 'sectionTitle'
  /** A label + input + error group (`.atlas-field`). */
  | 'formField'
  /** A field's label text (`.atlas-field-label`). */
  | 'formFieldLabel'
  | 'formFieldInput'
  | 'formFieldError'
  | 'formButtonPrimary'
  /** Secondary actions: revoke, remove, save in account sections (`.atlas-button-secondary`). */
  | 'formButtonSecondary'
  | 'socialButton'
  /** The provider icon inside a social button (`.atlas-social-icon`). */
  | 'socialButtonIcon'
  /** The label inside a social button (`.atlas-social-label`). */
  | 'socialButtonText'
  /** A non-field message: section errors, social sign-in errors (`.atlas-alert`). */
  | 'alert'
  /** Body copy / status messages (`.atlas-text`). */
  | 'text'
  /** An in-component link (`.atlas-link`). */
  | 'link'
  /** Lists: sessions, emails, passkeys, backup codes, plan features, invoices (`.atlas-list`). */
  | 'list'
  | 'listItem'
  /** The user button's wrapper (`.atlas-user-button`). */
  | 'userButton'
  | 'avatar'
  | 'menu'
  | 'menuItem'
  /** The user-profile tab bar (`.atlas-tabs`). */
  | 'tabs'
  /** A user-profile tab (`.atlas-tab`; also receives the `menuItem` class). */
  | 'tab'
  /** The pricing grid (`.atlas-pricing-table`). */
  | 'pricingTable'
  /** A plan's name (`.atlas-plan-name`). */
  | 'planName'
  /** A plan's price (`.atlas-price`). */
  | 'price'
  /** A price's billing interval (`.atlas-interval`). */
  | 'priceInterval'
  /** Reserved. */
  | 'dividerText'
  /** Reserved. */
  | 'footerAction'
  /** Reserved. */
  | 'badge';

/** The element keys, for iteration and docs. */
export const ELEMENT_KEYS: readonly ElementKey[] = [
  'root', 'card', 'headerTitle', 'headerSubtitle', 'sectionTitle', 'formField', 'formFieldLabel',
  'formFieldInput', 'formFieldError', 'formButtonPrimary', 'formButtonSecondary', 'socialButton',
  'socialButtonIcon', 'socialButtonText', 'alert', 'text', 'link', 'list', 'listItem', 'userButton',
  'avatar', 'menu', 'menuItem', 'tabs', 'tab', 'pricingTable', 'planName', 'price', 'priceInterval',
  'dividerText', 'footerAction', 'badge',
];

export interface Appearance {
  /** A prebuilt token theme to start from (pre-design-system themes). */
  baseTheme?: keyof typeof THEMES;
  /**
   * Legacy design tokens. Still supported: without a design they set the
   * `--atlas-*` variables exactly as before; with one they map onto it
   * (colorPrimary → palette.primary, colorText → palette.text, colorBackground →
   * palette.surface, colorDanger → palette.danger, colorBorder → palette.border,
   * borderRadius → shape, fontFamily → a curated font, spacingUnit → density).
   */
  variables?: DesignTokens;
  /** Extra classes per element, appended to ours. */
  elements?: Partial<Record<ElementKey, string>>;
  /**
   * A design preset. Replaces the dashboard design as the starting point:
   * `minimal`, `atlas`, `glass`, `midnight`, `editorial`, `terminal`, `sunrise`,
   * `forest`, `grape`, `slate`, `split-photo`, `bold`.
   */
  preset?: PresetId;
  /**
   * Structured design overrides — the same settings as the dashboard's design
   * editor. Layered over the dashboard design (or `preset`); highest precedence.
   * Invalid values are dropped (with a console warning in development).
   */
  design?: AtlasDesign;
  /**
   * Apply the design configured in the Atlas dashboard automatically. Default
   * `true`; set `false` to ignore it (code-level `preset`/`design` still apply).
   */
  instanceDesign?: boolean;
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
  // Both derived from colorPrimary by resolveTokens unless set explicitly.
  colorTextOnPrimary: '#ffffff',
  colorFocusRing: '#5b5bd6',
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
    colorTextOnPrimary: textOnPrimary('#6ea8fe'),
    colorFocusRing: '#6ea8fe',
  },
  neobrutalist: {
    ...DEFAULT_TOKENS,
    colorPrimary: '#ffe600',
    colorTextOnPrimary: textOnPrimary('#ffe600'),
    colorFocusRing: '#000000',
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
 *
 * `colorTextOnPrimary` and `colorFocusRing` follow the RESOLVED `colorPrimary`
 * unless set explicitly in `variables` (a theme's own values are for its own
 * primary): the label flips to whichever of white / near-black contrasts more,
 * and the focus ring takes the primary — adjusted in lightness until it has 3:1
 * contrast against `colorBackground` (WCAG 1.4.11), the way the label is picked
 * for contrast. A base theme whose primary would make a poor ring on its own
 * background (neobrutalist yellow on white) keeps its ring while its primary is
 * unchanged. An explicit `colorFocusRing` is used as given.
 */
export function resolveTokens(appearance?: Appearance): Required<DesignTokens> {
  const base = appearance?.baseTheme ? THEMES[appearance.baseTheme] : DEFAULT_TOKENS;
  const overrides = appearance?.variables ?? {};

  const resolved = { ...DEFAULT_TOKENS, ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) resolved[key as keyof DesignTokens] = value;
  }
  const primaryChanged = resolved.colorPrimary !== base.colorPrimary;
  if (overrides.colorTextOnPrimary === undefined) {
    resolved.colorTextOnPrimary = textOnPrimary(resolved.colorPrimary);
  }
  if (overrides.colorFocusRing === undefined) {
    resolved.colorFocusRing = focusRingOn(
      primaryChanged ? resolved.colorPrimary : base.colorFocusRing,
      resolved.colorBackground,
    );
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

// ---- the design system ---------------------------------------------------------

/**
 * The legacy tokens the developer chose EXPLICITLY: a non-default `baseTheme`
 * plus `variables`. Only these map onto a design — the token defaults must not
 * overwrite the dashboard design.
 */
export function explicitTokens(appearance?: Appearance): DesignTokens {
  const out: DesignTokens = {};
  if (appearance?.baseTheme && appearance.baseTheme !== 'default') {
    Object.assign(out, THEMES[appearance.baseTheme]);
  }
  for (const [key, value] of Object.entries(appearance?.variables ?? {})) {
    if (value !== undefined) out[key as keyof DesignTokens] = value;
  }
  return out;
}

/**
 * Turn an `appearance` (+ the instance's dashboard design from the Frontend
 * API) into root attributes and a stylesheet.
 *
 * Precedence, lowest first: dashboard design < `preset` < `variables` (and a
 * non-default `baseTheme`) < `design`. Without a dashboard design and without
 * `preset`/`design`, the output is exactly the pre-design-system one: the token
 * variables inline, no stylesheet, no attributes.
 */
export function renderAppearance(
  appearance: Appearance | undefined,
  instanceDesign: InstanceDesign | null | undefined,
  options: { frontendApi?: string; warn?: DesignWarn } = {},
): AppearanceRender {
  const out = renderDesignAppearance(appearance, instanceDesign, {
    tokens: explicitTokens(appearance),
    legacyStyle: () => cssVariables(resolveTokens(appearance)),
    frontendApi: options.frontendApi,
    warn: options.warn,
  });
  if (!out.attributes['data-atlas-design']) return out;
  return { ...out, style: { ...out.style, ...designAccessibilityVariables(appearance, options.warn ?? warnOnce) } };
}

/** Characters an inline token may never contain (mirrors the design system's raw-token guard). */
const UNSAFE_INLINE = /[;{}<>\\]|\/\*|url\s*\(|expression\s*\(|@import|javascript:/i;

/**
 * With a design active, the design supplies the primary ink and the focus ring,
 * and the token defaults are not emitted. An EXPLICIT `colorTextOnPrimary` /
 * `colorFocusRing` in `variables` still wins: they go inline on the root. The
 * ring also sets `--atlas-focus-outline-color`, which the design-mode focus
 * outline reads before falling back to the (solid) primary — the design's own
 * `--atlas-color-focus-ring` is translucent, a glow colour, not an outline one.
 */
function designAccessibilityVariables(appearance: Appearance | undefined, warn: DesignWarn): Record<string, string> {
  const vars: Record<string, string> = {};
  const safe = (key: keyof DesignTokens, value: string | undefined): value is string => {
    if (value === undefined) return false;
    if (typeof value === 'string' && value.length <= 200 && !UNSAFE_INLINE.test(value)) return true;
    warn(`appearance.variables.${key} is not a safe CSS value; ignored.`);
    return false;
  };
  const ink = appearance?.variables?.colorTextOnPrimary;
  if (safe('colorTextOnPrimary', ink)) vars['--atlas-color-text-on-primary'] = ink;
  const ring = appearance?.variables?.colorFocusRing;
  if (safe('colorFocusRing', ring)) {
    vars['--atlas-color-focus-ring'] = ring;
    vars['--atlas-focus-outline-color'] = ring;
  }
  return vars;
}
