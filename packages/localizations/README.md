# @atlasauth/localizations

i18n string bundles for the Atlas hosted pages and `@atlasauth/react` components — the Atlas peer of [`@clerk/localizations`](https://www.npmjs.com/package/@clerk/localizations).

## Install

```sh
npm install @atlasauth/localizations
```

## Use

Hand a bundle to `<AtlasProvider>`'s `localization` prop:

```tsx
import { AtlasProvider } from '@atlasauth/react';
import { frFR } from '@atlasauth/localizations';

<AtlasProvider publishableKey={pk} localization={frFR}>
  {children}
</AtlasProvider>;
```

Per-locale subpath imports are available if you only need one:

```ts
import { frFR } from '@atlasauth/localizations/fr-FR';
```

## Available locales

| Export | Locale               | Coverage        |
| ------ | -------------------- | --------------- |
| `enUS` | English (US) `en-US` | complete (base) |
| `frFR` | French `fr-FR`       | common keys     |
| `esES` | Spanish `es-ES`      | common keys     |
| `deDE` | German `de-DE`       | common keys     |
| `ptBR` | Portuguese `pt-BR`   | common keys     |
| `jaJP` | Japanese `ja-JP`     | common keys     |
| `nlNL` | Dutch `nl-NL`        | common keys     |

Export names follow Clerk's convention (`enUS`, `frFR`, …).

## What the keys are

This package **tracks the hosted-page strings**: the key namespace mirrors the
canonical i18n catalog Atlas's hosted pages and React components actually read,
defined in the Atlas monorepo at `packages/react/src/i18n.ts` (`EN_US`). That
catalog is deliberately **flat** — dotted keys such as `signIn.title` and
`formButtonPrimary`-style leaf names — rather than the deeply-nested Clerk
`LocalizationResource` (`signIn.start.title`, `formFieldLabel__emailAddress`).
Because Atlas already defines its own key set, we mirror it 1:1 instead of
re-deriving a Clerk shape. The only addition over the raw catalog is a `locale`
field tagging each bundle with its BCP-47 locale.

Key groups: `signIn.*`, `signUp.*`, `mfa.*`, `reset.*`, `userButton.*`,
`commerce.*`, `userProfile.*`, `organization.*`, `waitlist.*`,
`reverification.*`, `error.*`.

`{application}` and `{provider}` are interpolation placeholders Atlas fills at
render time; translations must keep them verbatim.

## Types

- `LocalizationResource` — the complete, strongly-typed key set (every key +
  `locale`). `en-US` satisfies it in full.
- `Localization` = `DeepPartial<LocalizationResource>` — a non-base bundle. Any
  key may be omitted; Atlas's `withFallback()` layers the bundle over `en-US`
  at render time, so a partial translation still renders every surface.

## Contributing a locale

1. Copy an existing locale file in `src/` (e.g. `src/fr-FR.ts`) to
   `src/<bcp47>.ts`.
2. Set `locale` to the file's BCP-47 tag and translate the values. Keep every
   `{placeholder}` intact. You may leave keys out — they fall back to English.
3. Export it from `src/index.ts` (and add a subpath to `exports` in
   `package.json`).
4. `pnpm -F @atlasauth/localizations test` — the suite enforces that your keys
   are a strict subset of `en-US` (no typos), that no value is empty, and that
   `locale` matches the file.
