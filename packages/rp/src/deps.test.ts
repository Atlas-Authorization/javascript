import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * `@atlasauth/rp` ships packages/backend/src/rp.ts and everything it reaches
 * through relative imports (build.mjs). Static checks over that import graph:
 * the only package it may load is `jose`, and nothing in it may need Node.
 */

const pkgDir = process.cwd(); // vitest runs from the package root
function walk(entry: string) {
  const files = new Set<string>();
  const bare = new Map<string, string>(); // specifier -> first file importing it
  const visit = (file: string) => {
    if (files.has(file)) return;
    files.add(file);
    const code = readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
    for (const m of code.matchAll(/(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)['"]([^'"]+)['"]/g)) {
      const spec = m[1]!;
      if (spec.startsWith('.')) {
        const base = resolve(dirname(file), spec.replace(/\.js$/, ''));
        visit(existsSync(`${base}.ts`) ? `${base}.ts` : join(base, 'index.ts'));
      } else if (!bare.has(spec)) {
        bare.set(spec, file);
      }
    }
  };
  visit(entry);
  return { files, bare };
}

describe.each(['rp.ts', 'rp-testing.ts'])('@atlasauth/rp import graph from %s', (name) => {
  const { files, bare } = walk(resolve(pkgDir, '../backend/src', name));

  it('loads no package but jose (no @noble/*, @atlasauth/*, node:*)', () => {
    expect(files.size).toBeGreaterThan(name === 'rp.ts' ? 5 : 1);
    expect(Object.fromEntries(bare)).toEqual({ jose: expect.any(String) });
  });

  it('references no Node globals (Buffer, process, require)', () => {
    for (const file of files) {
      const code = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      expect(/\bBuffer\b/.test(code), `${file} references Buffer`).toBe(false);
      expect(/\bprocess\./.test(code), `${file} references process`).toBe(false);
      expect(/\brequire\s*\(/.test(code), `${file} calls require`).toBe(false);
    }
  });

  it('package.json depends on jose alone, in the range @atlasauth/backend uses', () => {
    const own = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
    const backend = JSON.parse(readFileSync(resolve(pkgDir, '../backend/package.json'), 'utf8'));
    expect(own.dependencies).toEqual({ jose: backend.dependencies.jose });
    expect(own.peerDependencies).toBeUndefined();
  });

  it('the build bundles the shared source with jose external', () => {
    const build = readFileSync(join(pkgDir, 'build.mjs'), 'utf8');
    expect(build).toContain(`'../backend/src/${name}'`);
    expect(build).toMatch(/external:\s*\['jose'\]/);
  });
});
