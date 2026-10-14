# @atlasauth/design

## 0.1.0

- Initial release: the design schema (`designSchema`, `AtlasDesign`), presets,
  `resolveDesign` / `layerDesign` / `applyDesignPatch`, the safe CSS compiler
  (`compileDesignCss`, `designDataAttributes`, `DESIGN_CSS_VARIABLES`), the
  curated font catalog, contrast helpers and design warnings.
- `@atlasauth/design/runtime`: a zod-free entry with everything a renderer needs (presets, resolver,
  compiler, data attributes, fonts, contrast, composition helpers) and hand-written input guards that
  accept exactly what the schema accepts (fuzz-tested against it). The full entry adds the zod schemas
  and the dashboard validators (`validateDesign`, `applyDesignPatch`).
- `composeDesign`: what an SDK component renders — the instance design from the
  Frontend API, layered with `appearance.preset`, legacy `appearance.variables`
  and `appearance.design`, compiled client-side.
