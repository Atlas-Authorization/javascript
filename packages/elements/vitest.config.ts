import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The render tests (`*.render.test.tsx`) mount real primitives into a DOM;
    // the pure machine tests run fine here too.
    environment: 'jsdom',
  },
  // react-jsx so the test TSX compiles without importing React everywhere.
  esbuild: {
    jsx: 'automatic',
  },
});
