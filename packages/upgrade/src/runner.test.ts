import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { collectSourceFiles, runClerkToAtlas } from './runner';

let dir: string;

const CLERK_SOURCE = [
  `import { ClerkProvider } from '@clerk/clerk-react';`,
  `export const App = () => <ClerkProvider><div /></ClerkProvider>;`,
].join('\n');

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'atlas-upgrade-'));
  // a source file that should be transformed
  writeFileSync(join(dir, 'app.tsx'), CLERK_SOURCE, 'utf8');
  // a non-source file that must be ignored
  writeFileSync(join(dir, 'README.md'), '# @clerk/clerk-react', 'utf8');
  // a file under node_modules that must be skipped entirely
  mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true });
  writeFileSync(join(dir, 'node_modules', 'pkg', 'index.js'), CLERK_SOURCE, 'utf8');
  // a file under dist that must be skipped
  mkdirSync(join(dir, 'dist'), { recursive: true });
  writeFileSync(join(dir, 'dist', 'app.js'), CLERK_SOURCE, 'utf8');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('collectSourceFiles', () => {
  it('finds source files and skips node_modules/dist/non-source', () => {
    const files = collectSourceFiles(dir);
    expect(files).toEqual([join(dir, 'app.tsx')]);
  });

  it('accepts a single file path', () => {
    const file = join(dir, 'app.tsx');
    expect(collectSourceFiles(file)).toEqual([file]);
  });
});

describe('runClerkToAtlas', () => {
  it('computes changes but writes nothing in dry mode', () => {
    const result = runClerkToAtlas(dir, { write: false });
    expect(result.filesScanned).toBe(1);
    expect(result.filesChanged).toBe(1);
    expect(result.symbolsRewritten).toBeGreaterThan(0);
    // the diff is available...
    expect(result.changes[0]?.after).toContain('AtlasProvider');
    // ...but the file on disk is untouched.
    expect(readFileSync(join(dir, 'app.tsx'), 'utf8')).toBe(CLERK_SOURCE);
  });

  it('writes changes to disk when write is true', () => {
    const result = runClerkToAtlas(dir, { write: true });
    expect(result.filesChanged).toBe(1);
    const written = readFileSync(join(dir, 'app.tsx'), 'utf8');
    expect(written).toContain(`from '@atlasauth/react'`);
    expect(written).toContain('<AtlasProvider>');
    // skipped dirs were never rewritten
    expect(readFileSync(join(dir, 'dist', 'app.js'), 'utf8')).toBe(CLERK_SOURCE);
    expect(readFileSync(join(dir, 'node_modules', 'pkg', 'index.js'), 'utf8')).toBe(CLERK_SOURCE);
  });
});
