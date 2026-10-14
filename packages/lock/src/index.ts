/**
 * `@atlasauth/lock` — a drop-in, batteries-included sign-in/up widget for Atlas.
 *
 * It wraps the `@atlasauth/embed` widget (which drives the `@atlasauth/js` flow
 * machine) and themes its chrome with `@atlasauth/themes`, adding a modal/inline
 * shell, a sign-in/up tab switcher, a method allow-list, accessibility, and
 * `onAuthenticated` / `onError` callbacks. Two ways to use it:
 *
 *   - as a module:  `new AtlasLock({ publishableKey, domain, options }).show()`
 *   - as a script:  `<script src=".../atlas-lock.min.js" data-atlas-key …>`
 *     (the IIFE bundle, which also defines `window.AtlasLock`).
 *
 * @packageDocumentation
 */
export { AtlasLock, createLock } from './lock';
export { normalizeConfig, normalizeFrontendApi, ALL_METHODS } from './options';
export type {
  AtlasLockConfig,
  AtlasLockOptions,
  AtlasLockScreen,
  AtlasLockMethod,
  AtlasLockDisplay,
  AtlasLockTheme,
  AtlasLockSession,
  AtlasLockError,
  NormalizedConfig,
} from './options';
export { buildWidgetAppearance, resolveTheme, resolveChromeTokens } from './theme';
export type { ChromeTokens } from './theme';
export { applyMethodFilter } from './methods';
