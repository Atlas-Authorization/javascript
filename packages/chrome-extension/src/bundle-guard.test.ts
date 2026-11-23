import { resolve } from 'node:path';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';

const JS_SRC = resolve(__dirname, '../../js/src');

// A background bundle must never carry DOM UI or HTML-string sinks (addons-linter rejects them).
describe('background bundle', () => {
  it('has no innerHTML-style sinks and no policy viewer', async () => {
    const result = await build({
      entryPoints: [resolve(__dirname, 'background.ts')],
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'browser',
      logLevel: 'silent',
      plugins: [
        {
          name: 'atlas-js-source',
          setup(b) {
            b.onResolve({ filter: /^@atlasauth\/js(\/.*)?$/ }, (args) => {
              const sub = args.path.slice('@atlasauth/js'.length).replace(/^\//, '');
              return { path: resolve(JS_SRC, sub ? `${sub}.ts` : 'index.ts') };
            });
          },
        },
      ],
    });
    const code = result.outputFiles.map((f) => f.text).join('\n');
    for (const bad of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(', 'new Function', 'atlas-policy']) {
      expect(code, bad).not.toContain(bad);
    }
  });
});
