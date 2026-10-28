import { defineConfig } from 'vitest/config';

/**
 * The suite exercises the framework-agnostic client, the store-sync logic and
 * the widget mount/cleanup helpers directly — the non-component logic the spec
 * asks us to prioritise — rather than driving Qwik's full SSR render, which
 * needs the Vite+optimizer toolchain. Those units touch the DOM (a mount host,
 * `document`, `window.location`), so the suite still needs a DOM; happy-dom is
 * the same lightweight environment `@atlasauth/js` and `@atlasauth/embed`
 * already use in this workspace.
 */
export default defineConfig({
  test: {
    environment: 'happy-dom',
  },
});
