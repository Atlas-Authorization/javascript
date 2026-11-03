// Build @atlasauth/jwt-decode into three consumable shapes from one source:
//   - dist/index.mjs       ESM (import)
//   - dist/index.cjs       CommonJS (require)
//   - dist/index.umd.js    UMD (<script> global `AtlasJwtDecode`, AMD, CJS)
// Types (dist/index.d.ts) are emitted separately by `tsc --emitDeclarationOnly`.
//
// The package has ZERO runtime dependencies, so every bundle is fully
// self-contained and tiny.
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';

const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, 'src/index.ts');
const out = (f) => resolve(here, 'dist', f);
const GLOBAL_NAME = 'AtlasJwtDecode';

const common = {
  entryPoints: [entry],
  bundle: true,
  platform: 'neutral',
  target: ['es2019'],
  legalComments: 'none',
};

// ESM + CJS written straight to disk.
await build({ ...common, format: 'esm', outfile: out('index.mjs') });
await build({ ...common, format: 'cjs', outfile: out('index.cjs') });

// UMD: bundle as CJS in memory, then wrap in the classic UMD preamble so the
// single file works from a <script> tag (global), an AMD loader, or require().
const cjs = await build({ ...common, format: 'cjs', write: false, minify: true });
const code = cjs.outputFiles[0].text.trim();
const umd = `(function (root, factory) {
  if (typeof define === 'function' && define.amd) { define([], factory); }
  else if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.${GLOBAL_NAME} = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var module = { exports: {} };
  var exports = module.exports;
  ${code}
  return module.exports;
});
`;
await writeFile(out('index.umd.js'), umd, 'utf8');

console.log('jwt-decode: wrote dist/index.mjs, dist/index.cjs, dist/index.umd.js');
