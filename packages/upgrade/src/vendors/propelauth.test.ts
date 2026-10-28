import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import jscodeshift from 'jscodeshift';
import type { API } from 'jscodeshift';
import { describe, expect, it } from 'vitest';

import type { EnvStyle, ReportItem } from './engine';
import propelauth, { env } from './propelauth';

const j = jscodeshift.withParser('tsx');
const api: API = { j, jscodeshift: j, stats: () => undefined, report: () => undefined };
const FIXTURES = join(__dirname, '__fixtures__', 'propelauth');

function run(path: string, source: string, envStyle: EnvStyle = 'next') {
  const report: ReportItem[] = [];
  const out = propelauth({ path, source }, api, { envStyle, onReport: (r) => report.push(r) });
  return { out, report };
}

describe('--from propelauth fixtures', () => {
  it('env matches its .out and is idempotent', () => {
    const cases = JSON.parse(readFileSync(join(FIXTURES, 'cases.json'), 'utf8')) as Array<{ name: string; path: string; manual?: string[] }>;
    const c = cases.find((x) => x.name === 'env')!;
    const { out, report } = run(c.path, readFileSync(join(FIXTURES, 'env.in'), 'utf8'));
    expect(out).toBe(readFileSync(join(FIXTURES, 'env.out'), 'utf8'));
    for (const m of c.manual ?? []) expect(report.some((r) => r.message.includes(m)), m).toBe(true);
    expect(run(c.path, out!).out).toBeUndefined();
  });
});

describe('PropelAuth imports', () => {
  it('marks every import with the Atlas replacement and keeps it', () => {
    const { out, report } = run('app/page.tsx', `import { useAuthInfo } from '@propelauth/react';\nexport const useUserId = () => useAuthInfo().user?.userId;\n`);
    expect(out).toContain('TODO(atlas-migrate)');
    expect(report.some((r) => r.message.includes('<AtlasProvider>'))).toBe(true);
  });

  it('ignores files that do not mention PropelAuth', () => {
    expect(run('a.ts', `export const a = 1;\n`).out).toBeUndefined();
  });
});

describe('env', () => {
  it('maps PropelAuth keys', () => {
    expect(env('PROPELAUTH_API_KEY', 'next')).toMatch(/ATLAS_SECRET_KEY/);
    expect(env('PROPELAUTH_VERIFIER_KEY', 'node')).toMatch(/propelauth bridge/);
    expect(env('NEXT_PUBLIC_AUTH_URL', 'next')).toMatch(/NEXT_PUBLIC_ATLAS_PUBLISHABLE_KEY/);
    expect(env('PROPELAUTH_SAME_SITE_COOKIE_OVERRIDE', 'node')).toMatch(/remove/);
    expect(env('SOMETHING_ELSE', 'node')).toBeNull();
  });
});
