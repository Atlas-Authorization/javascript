import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/**
 * Consumed by `svelte-package` (the build) and `svelte-check` (typecheck).
 * `vitePreprocess` compiles the `<script lang="ts">` blocks in the components.
 */
export default {
  preprocess: vitePreprocess(),
};
