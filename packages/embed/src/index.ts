/**
 * `@atlasauth/embed` — the universal, framework-agnostic sign-in widget.
 *
 * Two ways to use it:
 *   - the custom elements `<atlas-sign-in>` / `<atlas-sign-up>` (register with
 *     {@link defineElements}), or
 *   - the imperative {@link mountSignIn} / {@link mountSignUp}.
 *
 * The standalone `dist/embed.js` IIFE bundle registers the elements and exposes
 * `window.Atlas` automatically; this barrel is the module entry for bundler
 * users who want the same API as an import.
 */
export { AtlasWidget, type WidgetOptions } from './widget';
export { defineElements, AtlasSignInElement, AtlasSignUpElement } from './element';
export { mountSignIn, mountSignUp, type MountTarget } from './mount';
export { setScriptDefaults, readScriptTag, type ScriptDefaults } from './config';
export { validateRedirect } from './redirect';
export {
  resolveTokens,
  cssVariables,
  orderedProviders,
  providerLabel,
  classFor,
  resolveSocialButtons,
  type DesignTokens,
  type ElementKey,
  type WidgetAppearance,
  type PublicAppearance,
  type PublicStrategies,
  type AppearanceResponse,
  type SocialButtonsConfig,
  type SocialButtonVariant,
  type SocialButtonSize,
  type SocialButtonLayout,
  type ResolvedSocialButtons,
} from './appearance';
export { providerIcon } from './icons';
