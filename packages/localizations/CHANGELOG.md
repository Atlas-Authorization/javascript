# @atlasauth/localizations changelog

## 0.3.0
- **Added key** `signUp.emailUnavailable` — the "can't send email" notice the prebuilt sign-up (and sign-in)
  components show when the app cannot deliver email. Translated in every shipped locale (en-US, es-ES, fr-FR,
  de-DE, pt-BR, ja-JP, nl-NL).

## 0.2.0
- **Added keys** for the create-account form and captcha messages of the prebuilt components:
  `signUp.emailLabel`, `signUp.passwordLabel`, `signUp.optionalField` (keeps the `{label}`
  placeholder), `signUp.selectPlaceholder`, `signUp.consentAgree`, `signUp.consentNotice`,
  `signUp.terms`, `signUp.privacy`, `signUp.and`, `captcha.prompt`, `captcha.required`,
  `captcha.failed`. Translated in every shipped locale (en-US, es-ES, fr-FR, de-DE, pt-BR, ja-JP, nl-NL).
- **Complete Spanish, French, German and Brazilian Portuguese.** `esES`, `frFR`, `deDE` and `ptBR` are now typed
  as the full `LocalizationResource` (every en-US key; a missing key is a compile error). `jaJP` and `nlNL`
  also cover every key today but stay typed as partial `Localization`.
- **New: `LOCALIZATION_KEYS`** (`readonly LocalizationKey[]`, the en-US key list) and
  **`missingKeys(catalog, reference = enUS): string[]`** for CI coverage checks (absent, empty or non-string
  keys are reported).
- **New: `resolveLocale(tag)`** → bundle or `undefined`, and **`LOCALES`** (canonical tag → bundle). Accepts
  BCP-47 tags case-insensitively, with `_` or `-`; a region without its own bundle falls back to its language
  (`es-MX` → `esES`, `pt-PT` → `ptBR`).
- **New types:** `LocalizationKey`, `CanonicalLocale` (`'en-US' | 'es-ES' | 'fr-FR' | 'de-DE' | 'pt-BR' | 'ja-JP' | 'nl-NL'`),
  `SupportedLocale` (canonical tags plus `'en' | 'es' | 'fr' | 'de' | 'pt' | 'ja' | 'nl'`).
- Added the `apiKeys.*` strings used by `<ApiKeys/>` (32 keys) to `LocalizationResource` and the
  `en-US` bundle, translated in every shipped locale.

## 0.1.0

First published release.

### Added
- Translation bundles for Atlas hosted pages and `@atlasauth/react` components, passed to `<AtlasProvider>`'s `localization` prop.
- Locales: `enUS`, `frFR`, `esES`, `deDE`, `ptBR`, `jaJP`, `nlNL`.
- Per-locale entry points (e.g. `@atlasauth/localizations/fr-FR`) so only the bundles you import are included.
- `LocalizationResource`, `Localization` and `DeepPartial` types for writing or partially overriding a bundle.
- Initial release.

