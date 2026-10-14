/**
 * `@atlasauth/localizations` — i18n string bundles for the Atlas hosted pages
 * and `@atlasauth/react` components. The Atlas peer of `@clerk/localizations`.
 *
 * Each export is a bundle you hand to `<AtlasProvider localization={…}>`:
 *
 * ```ts
 * import { frFR } from '@atlasauth/localizations';
 * <AtlasProvider publishableKey={pk} localization={frFR}>…</AtlasProvider>
 * ```
 *
 * `en-US`, `es-ES`, `fr-FR`, `de-DE` and `pt-BR` are complete: each is typed
 * as the full `LocalizationResource`, so a key missing from any of them is a
 * compile error. `ja-JP` and `nl-NL` are typed as `DeepPartial` overrides
 * (`Localization`); Atlas layers any partial bundle over `en-US` at render
 * time, so it still renders every surface.
 *
 * Coverage + resolution helpers:
 *
 * ```ts
 * import { missingKeys, resolveLocale, enUS } from '@atlasauth/localizations';
 * missingKeys(myBundle); // [] when complete (CI check)
 * const bundle = resolveLocale(navigator.language) ?? enUS; // 'fr-CA' → frFR
 * ```
 */

export type { LocalizationResource, Localization, DeepPartial } from './types';
export type { CanonicalLocale, LocalizationKey, SupportedLocale } from './coverage';
export { LOCALES, LOCALIZATION_KEYS, missingKeys, resolveLocale } from './coverage';

export { enUS } from './en-US';
export { frFR } from './fr-FR';
export { esES } from './es-ES';
export { deDE } from './de-DE';
export { ptBR } from './pt-BR';
export { jaJP } from './ja-JP';
export { nlNL } from './nl-NL';
