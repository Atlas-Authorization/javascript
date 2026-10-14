# @atlasauth/embed changelog

## 0.2.0
- **Design system.** `<atlas-sign-in>` / `<atlas-sign-up>` and `mount()` apply the design configured in
  the Atlas dashboard (from `/v1/appearance`): palette, radius, font, button/input style, shadow,
  density and social layout map onto the widget's tokens and interaction settings.
- **New inline `appearance.preset` and `appearance.design`** (and `data-atlas-preset` on the element) —
  the same settings and semantics as `@atlasauth/react`: tenant branding < dashboard design < `preset`
  < `variables` < `design`. Opt out of the dashboard design with `appearance.instanceDesign: false`.
- The widget root carries the stable `data-atlas-*` design attributes (the widget keeps styling itself
  through its `--atlas-embed-*` tokens; it does not ship the `--atlas-*` design stylesheet).
- Without a design, theming is unchanged.
- New dependency: `@atlasauth/design` — only its zod-free runtime entry is bundled into `embed.js`
  (about +21 KB minified).

