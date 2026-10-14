/**
 * Localization types.
 *
 * RE-EXPORTED (type-only) from `@atlasauth/localizations`. That package is
 * itself dependency-free, and a type-only re-export pulls in none of its bundle
 * values — so `@atlasauth/types` stays runtime-free while keeping ONE definition
 * of these shapes. `LocalizationResource` is the full set of UI strings Atlas's
 * hosted pages + React components read; `Localization` is a `DeepPartial`
 * override layered over `en-US` at render time.
 */
export type { LocalizationResource, Localization, DeepPartial } from '@atlasauth/localizations';
