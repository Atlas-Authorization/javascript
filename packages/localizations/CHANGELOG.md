# @atlasauth/localizations changelog

## 0.4.0
- **Added 38 keys `error.<reason>`** — one per stable `reason` the Frontend API now sends on its errors, so the
  prebuilt components show server errors in the app's language instead of the server's English `message`.
  Translated in every shipped locale (en-US, es-ES, fr-FR, de-DE, pt-BR, ja-JP, nl-NL): `error.form_password_incorrect`,
  `error.form_code_incorrect`, `error.form_code_already_used`, `error.form_code_expired`,
  `error.form_code_max_attempts`, `error.form_link_invalid`, `error.form_identifier_not_found`,
  `error.form_identifier_exists` (`{methods}`), `error.form_password_pwned`, `error.form_password_too_short`
  (`{min_length}`), `error.form_password_too_long` (`{max_length}`), `error.form_password_requires_uppercase`,
  `error.form_password_requires_lowercase`, `error.form_password_requires_number`,
  `error.form_password_requires_symbol`, `error.form_password_not_allowed`,
  `error.form_password_contains_identifier`, `error.form_password_same_as_current`, `error.form_password_reused`
  (`{history_count}`), `error.password_expired`, `error.email_not_verified`, `error.sign_in_token_invalid`,
  `error.too_many_attempts`,
  `error.too_many_requests`, `error.captcha_required`, `error.captcha_failed`, `error.captcha_unavailable`,
  `error.email_delivery_unavailable`, `error.strategy_disabled`, `error.sign_up_restricted`, `error.waitlisted`,
  `error.identifier_not_allowed`, `error.disposable_email_blocked`, `error.sso_required`, `error.sign_ins_disabled`,
  `error.sign_ups_disabled`, `error.high_risk_blocked`, `error.sms_region_blocked`.
- `LocalizationResource` gains the same 38 members, so the complete bundles (`esES`, `frFR`, `deDE`, `ptBR`) fail
  to compile without them; `jaJP` and `nlNL` cover them too. `missingKeys(resolveLocale('es'), enUS)` stays `[]`.


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

