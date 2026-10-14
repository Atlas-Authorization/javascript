import { defineConfig } from 'vitest/config';

/**
 * @solidjs/testing-library mounts real components into a DOM, so the suite needs
 * jsdom.
 *
 * The `resolve.conditions` line is the one piece that is easy to miss: under
 * Node, `solid-js` and `solid-js/web` resolve to Solid's SERVER build, which
 * has no `render` and no reactive DOM — so a test would import a stub and fail
 * in a baffling way. Selecting the `browser`/`development` conditions pins the
 * client build, which is exactly what `vite-plugin-solid` does for JSX projects.
 * We author components with `solid-js/h` (no JSX), so no Babel/plugin transform
 * is needed — just the conditions.
 */
export default defineConfig({
  resolve: {
    conditions: ['development', 'browser'],
  },
  test: {
    environment: 'jsdom',
  },
});
