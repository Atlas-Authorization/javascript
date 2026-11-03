// Build @atlasauth/rp from the SAME source as `@atlasauth/backend/rp`
// (packages/backend/src/rp.ts and the modules it imports), so the two never drift:
//   - dist/rp.mjs   ESM (import)
//   - dist/rp.cjs   CommonJS (require)
//   - dist/testing.mjs / dist/testing.cjs   `@atlasauth/rp/testing` (rp-testing.ts)
// Types (dist/types/*.d.ts) are emitted by `tsc -p tsconfig.build.json`.
//
// `jose` is the only runtime dependency and stays external; everything else is
// bundled. src/deps.test.ts keeps it that way.
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const common = {
  bundle: true,
  platform: 'neutral',
  target: ['es2022'],
  external: ['jose'],
  legalComments: 'none',
  sourcemap: true,
};

for (const [src, out] of [['../backend/src/rp.ts', 'rp'], ['../backend/src/rp-testing.ts', 'testing']]) {
  const entryPoints = [resolve(here, src)];
  await build({ ...common, entryPoints, format: 'esm', outfile: resolve(here, `dist/${out}.mjs`) });
  await build({ ...common, entryPoints, format: 'cjs', outfile: resolve(here, `dist/${out}.cjs`) });
}

console.log('rp: wrote dist/rp.{mjs,cjs}, dist/testing.{mjs,cjs}');
