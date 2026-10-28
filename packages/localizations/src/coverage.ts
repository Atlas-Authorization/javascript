import { deDE } from './de-DE';
import { enUS } from './en-US';
import { esES } from './es-ES';
import { frFR } from './fr-FR';
import { jaJP } from './ja-JP';
import { nlNL } from './nl-NL';
import { ptBR } from './pt-BR';
import { arSA } from './ar-SA';
import { heIL } from './he-IL';
import { faIR } from './fa-IR';
import { hiIN } from './hi-IN';
import { zhCN } from './zh-CN';
import { zhTW } from './zh-TW';
import { koKR } from './ko-KR';
import { itIT } from './it-IT';
import { plPL } from './pl-PL';
import { trTR } from './tr-TR';
import { ruRU } from './ru-RU';
import { svSE } from './sv-SE';
import { idID } from './id-ID';
import { viVN } from './vi-VN';
import { thTH } from './th-TH';
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
export type CanonicalLocale = 'en-US' | 'es-ES' | 'fr-FR' | 'de-DE' | 'pt-BR' | 'ja-JP' | 'nl-NL' | 'ar-SA' | 'he-IL' | 'fa-IR' | 'hi-IN' | 'zh-CN' | 'zh-TW' | 'ko-KR' | 'it-IT' | 'pl-PL' | 'tr-TR' | 'ru-RU' | 'sv-SE' | 'id-ID' | 'vi-VN' | 'th-TH';

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
  | 'nl-NL'
  | 'ar'
  | 'ar-SA'
  | 'he'
  | 'he-IL'
  | 'fa'
  | 'fa-IR'
  | 'hi'
  | 'hi-IN'
  | 'zh'
  | 'zh-CN'
  | 'zh-Hant'
  | 'zh-TW'
  | 'ko'
  | 'ko-KR'
  | 'it'
  | 'it-IT'
  | 'pl'
  | 'pl-PL'
  | 'tr'
  | 'tr-TR'
  | 'ru'
  | 'ru-RU'
  | 'sv'
  | 'sv-SE'
  | 'id'
  | 'id-ID'
  | 'vi'
  | 'vi-VN'
  | 'th'
  | 'th-TH';

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
  'ar-SA': arSA,
  'he-IL': heIL,
  'fa-IR': faIR,
  'hi-IN': hiIN,
  'zh-CN': zhCN,
  'zh-TW': zhTW,
  'ko-KR': koKR,
  'it-IT': itIT,
  'pl-PL': plPL,
  'tr-TR': trTR,
  'ru-RU': ruRU,
  'sv-SE': svSE,
  'id-ID': idID,
  'vi-VN': viVN,
  'th-TH': thTH,
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
  ['ar', arSA],
  ['ar-sa', arSA],
  ['he', heIL],
  ['iw', heIL],
  ['he-il', heIL],
  ['fa', faIR],
  ['fa-ir', faIR],
  ['hi', hiIN],
  ['hi-in', hiIN],
  ['zh', zhCN],
  ['zh-cn', zhCN],
  ['ko', koKR],
  ['ko-kr', koKR],
  ['it', itIT],
  ['it-it', itIT],
  ['pl', plPL],
  ['pl-pl', plPL],
  ['tr', trTR],
  ['tr-tr', trTR],
  ['ru', ruRU],
  ['ru-ru', ruRU],
  ['sv', svSE],
  ['sv-se', svSE],
  ['id', idID],
  ['id-id', idID],
  ['vi', viVN],
  ['vi-vn', viVN],
  ['th', thTH],
  ['th-th', thTH],
  ['zh-hant', zhTW],
  ['zh-tw', zhTW],
  ['zh-hk', zhTW],
  ['zh-mo', zhTW],
  ['zh-hans', zhCN],
  ['zh-sg', zhCN],
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

const RTL_LANGUAGES: ReadonlySet<string> = new Set(['ar', 'he', 'iw', 'fa', 'ur', 'ps', 'sd', 'yi', 'dv', 'ku']);

/**
 * The text direction for a BCP-47 tag: `'rtl'` for Arabic, Hebrew, Persian and
 * the other right-to-left languages, else `'ltr'`. Set it as `dir` on the
 * element that hosts Atlas components (`<AtlasProvider>` does this itself).
 */
export function localeDirection(tag: string | null | undefined): 'ltr' | 'rtl' {
  const lang = (tag ?? '').trim().replace(/_/g, '-').split('-')[0]!.toLowerCase();
  return RTL_LANGUAGES.has(lang) ? 'rtl' : 'ltr';
}
