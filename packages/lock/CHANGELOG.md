# @atlasauth/lock changelog

## 0.2.0 — 2026-10-24

- Integrator platform release: see the Atlas changelog for 2026-10-24.

## 0.1.3
- Depends on `@atlasauth/embed` ^0.5.2 (a range, not one exact version): "Email me a code instead" on the email +
  password box.

## 0.1.2
- Depends on `@atlasauth/embed` 0.5.1: email-code sign-in works on instances without password sign-in.

## 0.1.1

### Changed
- Built on the updated `@atlasauth/embed` widget, so the login widget now follows the instance's dashboard design system (presets, colours and interaction settings) when one is configured. Without a design, existing theming is unchanged.
- Smaller standalone CDN bundle (`atlas-lock.min.js`).

## 0.1.0

First published release.

### Added
- `AtlasLock` class and `createLock()` — a drop-in login widget built on `@atlasauth/embed` and `@atlasauth/js`, with `show()`, `hide()` and `switchTo('sign-in' | 'sign-up')`.
- Modal or inline display, an allow-list of sign-in `methods` (`password`, `emailCode`, `emailLink`, `social`, `passkey`), logo/title/redirect options and theming via `@atlasauth/themes` presets, an `Appearance` object or `auto`.
- Accessible modal with focus trapping and focus restore on close.
- ESM build plus a UMD CDN bundle exposing a global `AtlasLock`, with zero-code setup through `data-atlas-*` attributes and `data-atlas-lock-open` triggers.
- Exported helpers and types: `normalizeConfig()`, `normalizeFrontendApi()`, `ALL_METHODS`, `buildWidgetAppearance()`, `resolveTheme()`, `resolveChromeTokens()`, `applyMethodFilter()`, `AtlasLockConfig`, `AtlasLockOptions` and related types.
