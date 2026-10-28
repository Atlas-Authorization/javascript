# @atlasauth/design

## 0.3.0 — 2026-10-24

### Added

- `compileDesignCss(…, { hostVariables: true })` lets a host page's `--atlas-host-*` variables win where set; `hostVariableBridgeCss()`, `HOST_VARIABLE_MAP`.
- `adoptStylesheet()` / `adoptConstructable()` / `setStyleNonce()`: strict-CSP-friendly stylesheet injection (constructable sheets, else a nonced `<style>`).
- Self-hosted brand fonts: `typography.font` / `headingFont` accept `custom-<hash>` ids (imported from a brand document).

## 0.2.0

- **Added** `focusRingColor(primary, papers)`: the primary when it has 3:1 contrast (WCAG 1.4.11) against
  every paper, else the primary moved along its lightness axis until it does.
- **Added CSS variable** `--atlas-focus-outline-color` (per mode) to the compiler output and
  `DESIGN_CSS_VARIABLES`: the solid keyboard focus outline, the primary adjusted to 3:1 on the background
  and surface. Hosted pages and the React SDK's design mode use it for `:focus-visible` outlines.

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
