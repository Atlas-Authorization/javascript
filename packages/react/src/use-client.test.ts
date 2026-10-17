import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * React Server Components: every module that renders a component or calls a
 * hook starts with 'use client', so `<AtlasProvider>` and the prebuilt UI can be
 * used straight from a server layout. The entry and the plain helpers carry no
 * directive, so `fetchAtlasInitialState` stays callable on the server.
 */

const dir = __dirname;
const sources = readdirSync(dir).filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f));
const usesClientApis = (src: string) =>
  /\b(use[A-Z]\w*)\(/.test(src) || /\bcreateContext\b/.test(src) || /\bon[A-Z]\w*=\{|\bonClick\b/.test(src);
const isBarrel = (src: string) => !/\bfunction\b|=>/.test(src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ''));
const marked = (src: string) => /^'use client';/.test(src);

describe("'use client'", () => {
  it.each(sources.filter((f) => !isBarrel(readFileSync(join(dir, f), 'utf8'))))('%s is marked iff it renders or calls hooks', (f) => {
    const src = readFileSync(join(dir, f), 'utf8');
    expect(marked(src)).toBe(usesClientApis(src));
  });

  it('never re-exports a client module with `export *` (a client reference has no keys to copy)', () => {
    for (const barrel of sources.filter((f) => !marked(readFileSync(join(dir, f), 'utf8')))) {
      const src = readFileSync(join(dir, barrel), 'utf8');
      for (const m of src.matchAll(/^export \* from '\.\/([\w-]+)'/gm)) {
        const target = sources.find((f) => f.replace(/\.tsx?$/, '') === m[1])!;
        expect(marked(readFileSync(join(dir, target), 'utf8')), `${barrel} -> ${target}`).toBe(false);
      }
    }
  });

  it('leaves the entry and the server helpers unmarked', () => {
    expect(marked(readFileSync(join(dir, 'index.ts'), 'utf8'))).toBe(false);
    expect(marked(readFileSync(join(dir, '..', '..', 'js', 'src', 'initial-state.ts'), 'utf8'))).toBe(false);
  });
});
