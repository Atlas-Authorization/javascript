// Bundle the standalone widget into a single, self-contained IIFE that runs
// from a plain <script src=".../embed.js"> with no bare imports at runtime.
//
// `@atlasauth/js` is aliased to its TypeScript SOURCE so the bundle does not depend
// on that package having been built first, and so the whole widget ships as one
// file. `@atlasauth/js` has zero runtime dependencies, which keeps the bundle small.
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

await build({
  entryPoints: [resolve(here, 'src/standalone.ts')],
  outfile: resolve(here, 'dist/embed.js'),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['es2019'],
  minify: true,
  sourcemap: false,
  legalComments: 'none',
  alias: {
    '@atlasauth/js': resolve(here, '../js/src/index.ts'),
  },
});

