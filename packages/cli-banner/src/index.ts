/**
 * `@atlasauth/cli-banner` — the animated Atlas mark for CLIs.
 *
 * The common entry is {@link showBanner}: it animates on an interactive TTY and
 * stays silent (or prints a still) otherwise, so it is safe to call
 * unconditionally at the top of a CLI. Lower-level pieces are exported for
 * callers that want a still image in help text or to assert the renderer.
 */

export { showBanner, animate, staticBanner, bannerAllowed, BANNER_HEIGHT } from './banner';
export { frame, render, COLS, ROWS } from './render';
export { progress, velocity, CRUISE } from './motion';
export { wordmarkLines, WORDMARK_ROWS } from './wordmark';
export { MARK } from './geometry';
