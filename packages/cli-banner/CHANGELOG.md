# @atlasauth/cli-banner changelog

## 0.1.0

First published release.

### Added
- `showBanner()` renders the animated 3D Atlas mark in the terminal; animates only on an interactive TTY and prints nothing when piped or in CI.
- Respects `NO_COLOR` and `ATLAS_NO_BANNER=1`.
- `animate()`, `staticBanner()` and `bannerAllowed()` for forcing the animation, printing the still frame, or checking the gate.
- Lower-level rendering API: `frame()`, `render()`, `progress()`, `velocity()`, `wordmarkLines()`, `MARK`, and size constants (`COLS`, `ROWS`, `BANNER_HEIGHT`, `WORDMARK_ROWS`, `CRUISE`).
- `atlas-banner` preview binary with `--static` and `--no-color` flags.
- No runtime dependencies.
