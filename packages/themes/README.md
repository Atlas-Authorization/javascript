# @atlasauth/themes

Prebuilt appearance presets for Atlas hosted pages and React components — the
Atlas peer of [`@clerk/themes`](https://www.npmjs.com/package/@clerk/themes).

Each export is a plain, well-formed value of the `Appearance` type that Atlas
components already accept (from `@atlasauth/react`). A theme is just a set of
design tokens (`variables`) plus a few per-element class overrides (`elements`).
There are no special fields and no runtime dependency — themes are inert data.

## Install

```sh
pnpm add @atlasauth/themes
```

## Use

Pass a theme straight to the `appearance` prop:

```tsx
import { dark } from '@atlasauth/themes';
import { SignIn } from '@atlasauth/react';

export default function Page() {
  return <SignIn appearance={dark} />;
}
```

## Themes

| Export         | Looks like                                                      |
| -------------- | --------------------------------------------------------------- |
| `base`         | Neutral light — the Atlas default tokens, as an `Appearance`.   |
| `dark`         | Polished dark: near-black surface, light text, indigo accent.   |
| `midnight`     | Deep blue / indigo dark variant, richer and cooler than `dark`. |
| `neobrutalism` | Bold black borders, vivid yellow accent, hard offset shadows.   |
| `shadcn`       | Neutral, subtle radius, shadcn/ui-like tokens.                  |

`themes` is also exported as a name → theme map, handy for a theme picker.

## Building a custom theme

`experimental_createTheme(overrides, from?)` deep-merges `overrides` onto a base
theme (defaulting to `base`), the Atlas peer of Clerk's `createTheme`:

```ts
import { experimental_createTheme, dark } from '@atlasauth/themes';

const brand = experimental_createTheme(
  {
    variables: { colorPrimary: '#16a34a' },
    elements: { card: 'rounded-2xl' },
  },
  dark,
);
```

`variables` and `elements` merge field-by-field, so you only restate what you
change. Inputs are never mutated. The `experimental_` prefix mirrors Clerk: the
preset themes are stable, but the builder's exact merge semantics may still move.

## License

See the repository root.
