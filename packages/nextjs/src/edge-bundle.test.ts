import { describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// Regression: Next 15 edge middleware failed to build because the SDK bundle
// pulled in a Node builtin (node:crypto, via @atlasauth/backend).
describe('edge bundle', () => {
  it('bundles the middleware entry for the edge with no Node builtin', async () => {
    const result = await build({
      entryPoints: [here('./index.ts')],
      bundle: true,
      write: false,
      metafile: true,
      format: 'esm',
      platform: 'neutral',
      mainFields: ['module', 'main'],
      conditions: ['edge-light', 'worker', 'browser'],
      // Test against the workspace source, not a (possibly stale) dist.
      alias: { '@atlasauth/backend': here('../../backend/src/index.ts') },
      // An unresolvable builtin fails the build, which is the point.
      logLevel: 'silent',
    });
    const imported = Object.values(result.metafile.inputs).flatMap((i) => i.imports.map((x) => x.path));
    const nodeBuiltins = imported.filter((p) => /^node:/.test(p) || /^(http|https|net|fs|crypto|stream|zlib|os|path|tls|dns)$/.test(p));
    expect(nodeBuiltins).toEqual([]);
  });
});
