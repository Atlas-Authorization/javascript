import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { main, parseCliArgs, type Logger } from './cli';

let dir: string;
let out: string[];
let err: string[];
const logger: Logger = {
  log: (m = '') => out.push(m),
  error: (m = '') => err.push(m),
};

const CLERK_SOURCE = `import { useClerk } from '@clerk/clerk-react';\nconst c = useClerk();\n`;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'atlas-upgrade-cli-'));
  out = [];
  err = [];
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('parseCliArgs', () => {
  it('parses positionals and flags', () => {
    const cli = parseCliArgs(['./src', '--dry', '--transform', 'version-bump', '--to', '0.2.0']);
    expect(cli.positionals).toEqual(['./src']);
    expect(cli.dry).toBe(true);
    expect(cli.transform).toBe('version-bump');
    expect(cli.to).toBe('0.2.0');
  });
});

describe('main: clerk-to-atlas', () => {
  it('prints a diff and writes nothing with --dry (TTY)', () => {
    writeFileSync(join(dir, 'app.tsx'), CLERK_SOURCE, 'utf8');
    const code = main([dir, '--dry'], { logger, isTty: true });
    expect(code).toBe(0);
    const text = out.join('\n');
    expect(text).toContain('clerk-to-atlas');
    expect(text).toContain('useAtlas');
    expect(text).toContain('dry run');
    expect(readFileSync(join(dir, 'app.tsx'), 'utf8')).toBe(CLERK_SOURCE);
  });

  it('applies changes with --yes', () => {
    writeFileSync(join(dir, 'app.tsx'), CLERK_SOURCE, 'utf8');
    const code = main([dir, '--yes'], { logger, isTty: true });
    expect(code).toBe(0);
    expect(readFileSync(join(dir, 'app.tsx'), 'utf8')).toContain('useAtlas');
  });

  it('defaults to a safe dry run with no TTY and no --yes', () => {
    writeFileSync(join(dir, 'app.tsx'), CLERK_SOURCE, 'utf8');
    const code = main([dir], { logger, isTty: false });
    expect(code).toBe(0);
    expect(out.join('\n')).toContain('safe dry run');
    expect(readFileSync(join(dir, 'app.tsx'), 'utf8')).toBe(CLERK_SOURCE);
  });

  it('rejects an unsupported --from', () => {
    const code = main([dir, '--from', 'ping-identity'], { logger, isTty: true });
    expect(code).toBe(1);
    expect(err.join('\n')).toContain("unsupported --from 'ping-identity'");
  });

  it('runs a vendor migration (--from auth0) as a dry run with a diff and a report', () => {
    const source = `import { useAuth0 } from '@auth0/auth0-react';\nexport const A = () => useAuth0().user;\n`;
    writeFileSync(join(dir, 'app.tsx'), source, 'utf8');
    const code = main([dir, '--from', 'auth0', '--dry'], { logger, isTty: true });
    expect(code).toBe(0);
    const text = out.join('\n');
    expect(text).toContain('+ import { useAuth0Compat } from');
    expect(text).toContain('atlas-upgrade --from auth0');
    expect(readFileSync(join(dir, 'app.tsx'), 'utf8')).toBe(source);
  });
});

describe('main: version-bump', () => {
  it('bumps a target package.json with --yes', () => {
    const pkg = JSON.stringify(
      { name: 'x', dependencies: { '@atlasauth/react': '^0.1.0' } },
      null,
      2,
    );
    writeFileSync(join(dir, 'package.json'), pkg, 'utf8');
    const code = main([dir, '--transform', 'version-bump', '--to', '0.2.0', '--yes'], {
      logger,
      isTty: true,
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    expect(parsed.dependencies['@atlasauth/react']).toBe('^0.2.0');
  });
});

describe('main: misc', () => {
  it('prints help and exits 0', () => {
    expect(main(['--help'], { logger, isTty: true })).toBe(0);
    expect(out.join('\n')).toContain('atlas-upgrade');
  });
  it('errors on a missing path', () => {
    expect(main([join(dir, 'nope')], { logger, isTty: true })).toBe(1);
    expect(err.join('\n')).toContain('path not found');
  });
});
