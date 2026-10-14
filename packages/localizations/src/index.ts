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
 * Only `en-US` is complete; every other locale is a `DeepPartial` override
 * that Atlas layers over `en-US` at render time, so a partial translation
 * still renders every surface.
 */

export type { LocalizationResource, Localization, DeepPartial } from './types';

export { enUS } from './en-US';
export { frFR } from './fr-FR';
export { esES } from './es-ES';
export { deDE } from './de-DE';
export { ptBR } from './pt-BR';
export { jaJP } from './ja-JP';
export { nlNL } from './nl-NL';
