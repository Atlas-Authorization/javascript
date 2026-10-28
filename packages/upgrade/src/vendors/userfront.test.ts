import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import jscodeshift from 'jscodeshift';
import type { API } from 'jscodeshift';
import { describe, expect, it } from 'vitest';

import type { EnvStyle, ReportItem } from './engine';
import userfront, { env } from './userfront';

const j = jscodeshift.withParser('tsx');
const api: API = { j, jscodeshift: j, stats: () => undefined, report: () => undefined };
const FIXTURES = join(__dirname, '__fixtures__', 'userfront');

function run(path: string, source: string, envStyle: EnvStyle = 'next') {
  const report: ReportItem[] = [];
  const out = userfront({ path, source }, api, { envStyle, onReport: (r) => report.push(r) });
  return { out, report };
}

describe('--from userfront fixtures', () => {
  it('env matches its .out and is idempotent', () => {
    const cases = JSON.parse(readFileSync(join(FIXTURES, 'cases.json'), 'utf8')) as Array<{ name: string; path: string; manual?: string[] }>;
    const c = cases.find((x) => x.name === 'env')!;
    const { out, report } = run(c.path, readFileSync(join(FIXTURES, 'env.in'), 'utf8'));
    expect(out).toBe(readFileSync(join(FIXTURES, 'env.out'), 'utf8'));
    for (const m of c.manual ?? []) expect(report.some((r) => r.message.includes(m)), m).toBe(true);
    expect(run(c.path, out!).out).toBeUndefined();
  });
});

describe('Userfront imports', () => {
  it('marks every import with the Atlas replacement and keeps it', () => {
    const { out, report } = run('app/page.tsx', `import Userfront from '@userfront/core';\nexport const token = () => Userfront.tokens.accessToken;\n`);
    expect(out).toContain('TODO(atlas-migrate)');
    expect(report.some((r) => r.message.includes('<AtlasProvider>'))).toBe(true);
  });

  it('ignores files that do not mention Userfront', () => {
    expect(run('a.ts', `export const a = 1;\n`).out).toBeUndefined();
  });
});

describe('env', () => {
  it('maps Userfront keys', () => {
    expect(env('NEXT_PUBLIC_USERFRONT_TENANT_ID', 'next')).toMatch(/NEXT_PUBLIC_ATLAS_PUBLISHABLE_KEY/);
    expect(env('USERFRONT_API_KEY', 'node')).toMatch(/ATLAS_SECRET_KEY/);
    expect(env('USERFRONT_JWT_PUBLIC_KEY', 'node')).toMatch(/JWKS/);
    expect(env('SOMETHING_ELSE', 'node')).toBeNull();
    expect(env('USERFRONT_OTHER', 'node')).toMatch(/remove/);
  });
});
