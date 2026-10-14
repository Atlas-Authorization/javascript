import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The one test that exercises the SHIPPED artifact rather than the source: it
 * runs `node dist/cli.js` the way a user's shell would. Requires a prior
 * `pnpm build`; cwd is the package root under `pnpm -F ... test`.
 */
const BIN = join(process.cwd(), 'dist', 'cli.js');

describe('built bin', () => {
  it('keeps the #!/usr/bin/env node shebang on the first line of dist/cli.js', () => {
    expect(existsSync(BIN)).toBe(true); // build must run first
    const firstLine = readFileSync(BIN, 'utf8').split('\n', 1)[0];
    expect(firstLine).toBe('#!/usr/bin/env node');
  });

  it('prints the version for --version', () => {
    const out = execFileSync('node', [BIN, '--version'], { encoding: 'utf8' }).trim();
    expect(out).toMatch(/^\d+\.\d+\.\d+$/);
    // Match the shipped manifest rather than a hard-coded literal, so a version
    // bump doesn't break this test.
    const pkgVersion = (JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as {
      version: string;
    }).version;
    expect(out).toBe(pkgVersion);
  });

  it('prints usage for --help and exits 0', () => {
    const out = execFileSync('node', [BIN, '--help'], { encoding: 'utf8' });
    expect(out).toContain('Usage: atlas');
    expect(out).toContain('Commands:');
  });

  it('exits non-zero on an unknown command', () => {
    let code = 0;
    try {
      execFileSync('node', [BIN, 'frobnicate'], { encoding: 'utf8', stdio: 'pipe' });
    } catch (err) {
      code = (err as { status?: number }).status ?? 1;
    }
    expect(code).toBe(1);
  });
});
