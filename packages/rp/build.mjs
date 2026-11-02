// Build @atlasauth/rp from the SAME source as `@atlasauth/backend/rp`
// (packages/backend/src/rp.ts and the modules it imports), so the two never drift:
//   - dist/rp.mjs   ESM (import)
//   - dist/rp.cjs   CommonJS (require)
// Types (dist/types/*.d.ts) are emitted by `tsc -p tsconfig.build.json`.
//
// `jose` is the only runtime dependency and stays external; everything else is
// bundled. src/deps.test.ts keeps it that way.
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const common = {
  entryPoints: [resolve(here, '../backend/src/rp.ts')],
  bundle: true,
  platform: 'neutral',
  target: ['es2022'],
  external: ['jose'],
  legalComments: 'none',
  sourcemap: true,
};

await build({ ...common, format: 'esm', outfile: resolve(here, 'dist/rp.mjs') });
await build({ ...common, format: 'cjs', outfile: resolve(here, 'dist/rp.cjs') });

console.log('rp: wrote dist/rp.mjs, dist/rp.cjs');
