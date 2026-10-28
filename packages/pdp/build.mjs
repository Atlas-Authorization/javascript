// Bundle the PDP library and the sidecar CLI. The ABAC and FGA engines live in the private @atlas/core
// package and are inlined from source (they import nothing outside their own folders), so the published
// package has no workspace dependency and runs fully offline.
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { chmodSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const common = { bundle: true, platform: 'node', target: ['node18'], format: 'cjs', sourcemap: true, legalComments: 'none', external: [] };

await build({ ...common, entryPoints: [resolve(here, 'src/index.ts')], outfile: resolve(here, 'dist/index.js') });
await build({ ...common, entryPoints: [resolve(here, 'src/cli.ts')], outfile: resolve(here, 'dist/cli.js'), banner: { js: '#!/usr/bin/env node' } });
chmodSync(resolve(here, 'dist/cli.js'), 0o755);
