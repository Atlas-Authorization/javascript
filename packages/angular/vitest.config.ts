import { defineConfig } from 'vitest/config';

/**
 * The service and the flow engine are plain classes, so vitest drives them
 * directly: `AtlasService` is constructed inside an injection context, and the
 * prebuilt components are JIT-compiled (each suite loads `@angular/compiler`).
 * Angular's JIT field decorators (`@Input`) need TypeScript's legacy decorator
 * emit, so the test transform turns it on (the build goes through ng-packagr).
 * Suites that need a DOM opt into happy-dom per file. `atlas.service.spec.ts` is
 * the TestBed starter spec for an Angular CLI runner (Karma/Jasmine), so it is
 * left out here.
 */
export default defineConfig({
  esbuild: {
    tsconfigRaw: {
      compilerOptions: { experimentalDecorators: true, useDefineForClassFields: false },
    },
  },
  test: {
    include: ['src/**/*.spec.ts'],
    exclude: ['src/lib/atlas.service.spec.ts', 'node_modules/**', 'dist/**'],
  },
});
