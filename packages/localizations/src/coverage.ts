import { deDE } from './de-DE';
import { enUS } from './en-US';
import { esES } from './es-ES';
import { frFR } from './fr-FR';
import { jaJP } from './ja-JP';
import { nlNL } from './nl-NL';
import { ptBR } from './pt-BR';
import type { Localization, LocalizationResource } from './types';

/**
 * Coverage + locale-resolution helpers.
 *
 * `LOCALIZATION_KEYS` / `missingKeys` let a CI job assert a bundle is complete
 * (`expect(missingKeys(myBundle)).toEqual([])`); `resolveLocale` maps a
 * BCP-47 tag (from `navigator.language`, an `Accept-Language` pick, a user
 * setting…) to the bundle that serves it.
 */

/** A translatable UI key: every `LocalizationResource` field except the `locale` tag. */
export type LocalizationKey = Exclude<keyof LocalizationResource, 'locale'>;

/** Every UI string key, in `en-US` declaration order. Excludes the `locale` tag. */
export const LOCALIZATION_KEYS: readonly LocalizationKey[] = Object.freeze(
  Object.keys(enUS).filter((key): key is LocalizationKey => key !== 'locale'),
);

/**
 * Anything shaped like a catalog: a bundle from this package, or a plain flat
 * `Record<string, string>` such as `@atlasauth/react`'s `Catalog`. (The
 * `Localization` arm is there because an `interface` like
 * `LocalizationResource` is not implicitly assignable to an index signature.)
 */
type CatalogLike = Localization | Readonly<Record<string, unknown>>;

/**
 * The keys of `reference` (default `en-US`) that `catalog` is missing — absent,
 * not a string, or an empty / whitespace-only string. The `locale` tag is not a
 * UI string and is never reported. An empty result means the catalog is complete.
 */
export function missingKeys(catalog: CatalogLike, reference: CatalogLike = enUS): string[] {
  const entries = catalog as Readonly<Record<string, unknown>>;
  return Object.keys(reference).filter((key) => {
    if (key === 'locale') return false;
    const value = Object.prototype.hasOwnProperty.call(entries, key) ? entries[key] : undefined;
    return typeof value !== 'string' || value.trim() === '';
  });
}

/** The canonical tag of every bundle this package ships. */
export type CanonicalLocale = 'en-US' | 'es-ES' | 'fr-FR' | 'de-DE' | 'pt-BR' | 'ja-JP' | 'nl-NL';

/**
 * Tags `resolveLocale` accepts, listed for autocompletion: every canonical tag
 * plus its language-only short form. `resolveLocale` also takes any other
 * BCP-47 tag (region variants, underscores, any casing), so a prop typed
 * `SupportedLocale | (string & {})` keeps the suggestions without rejecting
 * e.g. `'es-MX'`.
 */
export type SupportedLocale =
  | 'en'
  | 'en-US'
  | 'es'
  | 'es-ES'
  | 'fr'
  | 'fr-FR'
  | 'de'
  | 'de-DE'
  | 'pt'
  | 'pt-BR'
  | 'ja'
  | 'ja-JP'
  | 'nl'
  | 'nl-NL';

/**
 * Every shipped bundle, keyed by canonical tag. `en-US`, `es-ES`, `fr-FR`,
 * `de-DE` and `pt-BR` are complete `LocalizationResource`s; `ja-JP` and
 * `nl-NL` are typed as partial `Localization` overrides.
 */
export const LOCALES: Readonly<Record<CanonicalLocale, Localization>> = Object.freeze({
  'en-US': enUS,
  'es-ES': esES,
  'fr-FR': frFR,
  'de-DE': deDE,
  'pt-BR': ptBR,
  'ja-JP': jaJP,
  'nl-NL': nlNL,
});

/**
 * Lower-cased tag → bundle. Region variants with no bundle of their own map to
 * their language's bundle explicitly here, and any other region falls through
 * to the language-only entry. `pt-PT` (European Portuguese) is served by the
 * Brazilian bundle: the closest available, mutually intelligible, but not a
 * European Portuguese translation.
 */
const TAGS: ReadonlyMap<string, Localization> = new Map<string, Localization>([
  ['en', enUS],
  ['en-us', enUS],
  ['en-gb', enUS],
  ['es', esES],
  ['es-es', esES],
  ['es-mx', esES],
  ['es-419', esES],
  ['fr', frFR],
  ['fr-fr', frFR],
  ['fr-ca', frFR],
  ['de', deDE],
  ['de-de', deDE],
  ['de-at', deDE],
  ['de-ch', deDE],
  ['pt', ptBR],
  ['pt-br', ptBR],
  ['pt-pt', ptBR],
  ['ja', jaJP],
  ['ja-jp', jaJP],
  ['nl', nlNL],
  ['nl-nl', nlNL],
  ['nl-be', nlNL],
]);

/**
 * Resolve a BCP-47 tag to a shipped bundle, or `undefined` if none serves it.
 *
 * Case-insensitive, and `_` is accepted as a separator (`pt_BR`). The tag is
 * matched exactly first, then by its language subtag alone, so `es-AR` gets
 * `esES` and `en-AU` gets `enUS`. An unknown language returns `undefined`;
 * the caller picks the fallback (normally `enUS`).
 */
export function resolveLocale(tag: SupportedLocale | (string & {})): Localization | undefined {
  if (typeof tag !== 'string') return undefined;
  const normalized = tag.trim().replace(/_/g, '-').toLowerCase();
  if (normalized === '') return undefined;
  return TAGS.get(normalized) ?? TAGS.get(normalized.split('-')[0]!);
}
