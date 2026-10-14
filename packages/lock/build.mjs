// Bundle the standalone Lock widget into a single, self-contained IIFE that
// runs from a plain <script src=".../atlas-lock.min.js"> with no bare imports.
//
// The workspace deps are aliased to their TypeScript SOURCE so the bundle does
// not depend on those packages having been built first, and so the whole widget
// — shell, embedded auth widget, flow driver and theme presets — ships as one
// file. The result assigns `window.AtlasLock` itself (see src/standalone.ts).
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = (name) => resolve(here, '..', name, 'src/index.ts');

await build({
  entryPoints: [resolve(here, 'src/standalone.ts')],
  outfile: resolve(here, 'dist/atlas-lock.min.js'),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['es2019'],
  minify: true,
  sourcemap: false,
  legalComments: 'none',
  alias: {
    '@atlasauth/embed': pkg('embed'),
    '@atlasauth/js': pkg('js'),
    '@atlasauth/themes': pkg('themes'),
    // A directory alias so `@atlasauth/design/runtime` (the widget's zod-free
    // design entry) resolves to src/runtime.ts.
    '@atlasauth/design': resolve(here, '..', 'design', 'src'),
  },
});
