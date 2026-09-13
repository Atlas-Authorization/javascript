import { defineConfig } from 'vitest/config';

// The server-auth helper is plain TypeScript over @atlasauth/backend + h3 — no Nuxt
// kit runtime and no DOM — so it runs under the default Node environment.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
