import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// End-to-end: invoke the BUILT binary the way a developer would. This proves the
// shebang/entrypoint wiring and arg plumbing work, not just the exported funcs.
// It is skipped automatically when `dist/cli.js` has not been built yet.
const CLI = resolve(__dirname, '..', 'dist', 'cli.js');
const built = existsSync(CLI);

let dir: string;
const CLERK_SOURCE = `import { ClerkProvider } from '@clerk/clerk-react';\nexport const A = () => <ClerkProvider />;\n`;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'atlas-upgrade-e2e-'));
  writeFileSync(join(dir, 'app.tsx'), CLERK_SOURCE, 'utf8');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe.skipIf(!built)('atlas-upgrade built CLI', () => {
  it('runs a dry run over a fixture dir and writes nothing', () => {
    // --dry takes precedence over --yes, so this is guaranteed non-destructive.
    const stdout = execFileSync(process.execPath, [CLI, dir, '--dry', '--yes'], {
      encoding: 'utf8',
    });
    expect(stdout).toContain('clerk-to-atlas');
    expect(stdout).toContain('AtlasProvider');
    expect(readFileSync(join(dir, 'app.tsx'), 'utf8')).toBe(CLERK_SOURCE);
  });

  it('preserves the shebang in the built file', () => {
    expect(readFileSync(CLI, 'utf8').startsWith('#!/usr/bin/env node')).toBe(true);
  });
});
