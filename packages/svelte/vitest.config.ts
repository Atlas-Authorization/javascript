import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';

export default defineConfig({
  plugins: [svelte({ hot: false })],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/tests/setup.ts'],
  },
  resolve: {
    // @testing-library/svelte needs the browser condition to import the client
    // component runtime.
    conditions: ['browser'],
  },
});
