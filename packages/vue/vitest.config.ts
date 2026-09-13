import { defineConfig } from 'vitest/config';

/**
 * @vue/test-utils mounts real components, so the suite needs a DOM. happy-dom
 * is the same lightweight environment `@atlasauth/js` and `@atlasauth/embed` already
 * use in this workspace. Components are plain render functions, so no Vue SFC
 * compiler plugin is required — the same reason the package builds with `tsc`.
 */
export default defineConfig({
  test: {
    environment: 'happy-dom',
  },
});
