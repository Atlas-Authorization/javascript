import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import jscodeshift from 'jscodeshift';
import type { API } from 'jscodeshift';
import { describe, expect, it } from 'vitest';

import type { EnvStyle, ReportItem } from './engine';
import stytch, { env } from './stytch';

const j = jscodeshift.withParser('tsx');
const api: API = { j, jscodeshift: j, stats: () => undefined, report: () => undefined };
const FIXTURES = join(__dirname, '__fixtures__', 'stytch');

function run(path: string, source: string, envStyle: EnvStyle = 'next') {
  const report: ReportItem[] = [];
  const out = stytch({ path, source }, api, { envStyle, onReport: (r) => report.push(r) });
  return { out, report };
}

describe('--from stytch fixtures', () => {
  for (const name of ['provider', 'env']) {
    it(`${name} matches its .out and is idempotent`, () => {
      const cases = JSON.parse(readFileSync(join(FIXTURES, 'cases.json'), 'utf8')) as Array<{ name: string; path: string; manual?: string[] }>;
      const c = cases.find((x) => x.name === name)!;
      const { out, report } = run(c.path, readFileSync(join(FIXTURES, `${name}.in`), 'utf8'));
      expect(out).toBe(readFileSync(join(FIXTURES, `${name}.out`), 'utf8'));
      for (const m of c.manual ?? []) expect(report.some((r) => r.message.includes(m)), m).toBe(true);
      expect(run(c.path, out!).out).toBeUndefined();
    });
  }
});

describe('Stytch SDK calls', () => {
  it('reports hooks and the login component with the Atlas call to use', () => {
    const { out, report } = run(
      'app/page.tsx',
      `import { useStytchUser, useStytchSession, StytchLogin } from '@stytch/nextjs';\nexport function Page() { const { user } = useStytchUser(); const s = useStytchSession(); return <StytchLogin config={{}} />; }\n`,
    );
    expect(out).toContain('TODO(atlas-migrate)');
    const text = report.map((r) => r.message).join('\n');
    expect(text).toContain('useUser()');
    expect(text).toContain('useAuth() / useSession()');
    expect(text).toContain('<SignIn />');
  });

  it('points the B2B provider at AtlasProvider', () => {
    const { out } = run('app/p.tsx', `import { StytchB2BProvider } from '@stytch/nextjs/b2b';\nexport const P = ({ children }) => <StytchB2BProvider stytch={s}>{children}</StytchB2BProvider>;\n`);
    expect(out).toContain("from '@atlasauth/react'");
    expect(out).not.toContain('StytchB2BProvider');
  });

  it('points the stytch Node SDK at the Atlas Backend API', () => {
    const { report } = run('lib/stytch.ts', `import { Client } from 'stytch';\nexport const client = new Client({ project_id: process.env.STYTCH_PROJECT_ID, secret: process.env.STYTCH_SECRET });\n`);
    expect(report.some((r) => r.message.includes('Atlas Backend API'))).toBe(true);
    expect(report.some((r) => r.message.startsWith('STYTCH_SECRET'))).toBe(true);
  });

  it('points server helpers at auth()', () => {
    const { report } = run('app/s.ts', `import { authenticateOrRedirect } from '@stytch/nextjs/server';\nexport const f = authenticateOrRedirect;\n`);
    expect(report.some((r) => r.message.includes('auth() or currentUser()'))).toBe(true);
  });

  it('ignores files that do not mention Stytch', () => {
    expect(run('a.ts', `export const a = 1;\n`).out).toBeUndefined();
  });
});

describe('env', () => {
  it('maps Stytch keys', () => {
    expect(env('NEXT_PUBLIC_STYTCH_PUBLIC_TOKEN', 'next')).toBe('replace with NEXT_PUBLIC_ATLAS_PUBLISHABLE_KEY');
    expect(env('VITE_STYTCH_PUBLIC_TOKEN', 'vite')).toBe('replace with VITE_ATLAS_PUBLISHABLE_KEY');
    expect(env('STYTCH_SECRET', 'next')).toMatch(/ATLAS_SECRET_KEY/);
    expect(env('STYTCH_PROJECT_ID', 'next')).toMatch(/bridge/);
    expect(env('STYTCH_WEBHOOK_SECRET', 'node')).toMatch(/webhook/);
    expect(env('STYTCH_PROJECT_ENV', 'node')).toMatch(/remove/);
    expect(env('SOMETHING_ELSE', 'node')).toBeNull();
  });
});
