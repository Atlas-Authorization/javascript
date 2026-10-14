/**
 * Component theming types.
 *
 * COPIED from `@atlasauth/react` (`src/appearance.ts`). That package ships the
 * `THEMES` values, the resolver runtime, and the React components, so only the
 * pure types are mirrored here. `Appearance.baseTheme` is inlined as its
 * resolved string-literal union — the prebuilt theme names — rather than
 * `keyof typeof THEMES`, so this package needs no value import.
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
  /** Text/icon colour on a `colorPrimary` fill. Defaults to a contrast-picked white or near-black. */
  colorTextOnPrimary?: string;
  /** The keyboard focus ring (solid outline). Defaults to `colorPrimary`. */
  colorFocusRing?: string;
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
  /** A prebuilt theme to start from (the names of the shipped `THEMES`). */
  baseTheme?: 'default' | 'dark' | 'neobrutalist';
  variables?: DesignTokens;
  elements?: Partial<Record<ElementKey, string>>;
}
