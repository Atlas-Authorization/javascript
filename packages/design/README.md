# @atlasauth/design

The Atlas design system: one structured description of how an Atlas sign-in
surface looks, shared by the hosted pages and every Atlas SDK component.

```sh
npm install @atlasauth/design
```

You rarely need this package directly — `@atlasauth/react`, `@atlasauth/vue`,
`@atlasauth/svelte`, `@atlasauth/angular` and `@atlasauth/embed` use it to apply
your dashboard design and the `appearance.preset` / `appearance.design` you pass
in code. Use it when you want the types, the preset list or the compiler itself
(for example to theme your own markup with the same `--atlas-*` variables).

```ts
import { resolveDesign, compileDesignCss, designDataAttributes, PRESET_IDS } from '@atlasauth/design';

const design = resolveDesign({ preset: 'midnight', palette: { primary: '#7c3aed' } });
const css = compileDesignCss(design, { scope: '.my-auth' });
const attrs = designDataAttributes(design); // { 'data-atlas-card': 'solid', ... }
```

- **Settings only, never CSS.** Every field is a closed enum, a bounded number, a
  `#RRGGBB` colour or a catalog id. Invalid input is rejected (or, in the SDKs,
  dropped with a development warning) — it can never reach a stylesheet.
- **Presets:** `minimal`, `atlas`, `glass`, `midnight`, `editorial`, `terminal`,
  `sunrise`, `forest`, `grape`, `slate`, `split-photo`, `bold`.
- **Variables:** `DESIGN_CSS_VARIABLES` lists every `--atlas-*` custom property
  the compiler emits, with its type and description.
- **Fonts:** `FONT_CATALOG` is the curated font list. Web fonts are self-hosted
  by Atlas; a visitor's browser never contacts a third-party font host.
- **Contrast:** `contrastRatio`, `readableOn`, `readableInk` and
  `designWarnings` (WCAG AA checks for a resolved design).

**Two entries.** `@atlasauth/design` is everything, including the zod schemas
and the dashboard validators (`validateDesign`, `applyDesignPatch`).
`@atlasauth/design/runtime` is the zod-free subset a renderer needs — presets,
`resolveDesign`/`layerDesign`, the compiler, data attributes, fonts, contrast
and the SDK composition helpers — with hand-written input guards that accept
exactly what the schema accepts. Use it where bundle size matters.

Runtime dependency: `zod` (full entry only). Works in browsers, Node, Deno, Bun and edge runtimes.

MIT licensed.
