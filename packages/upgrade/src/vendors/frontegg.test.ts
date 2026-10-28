import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import jscodeshift from 'jscodeshift';
import type { API } from 'jscodeshift';
import { describe, expect, it } from 'vitest';

import type { EnvStyle, ReportItem } from './engine';
import frontegg, { env } from './frontegg';

const j = jscodeshift.withParser('tsx');
const api: API = { j, jscodeshift: j, stats: () => undefined, report: () => undefined };
const FIXTURES = join(__dirname, '__fixtures__', 'frontegg');

function run(path: string, source: string, envStyle: EnvStyle = 'next') {
  const report: ReportItem[] = [];
  const out = frontegg({ path, source }, api, { envStyle, onReport: (r) => report.push(r) });
  return { out, report };
}

describe('--from frontegg fixtures', () => {
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

describe('Frontegg SDK calls', () => {
  it('reports hooks and the admin portal with the Atlas call to use', () => {
    const { out, report } = run(
      'components/nav.tsx',
      `import { useAuth, useLoginWithRedirect, useLogout, AdminPortal } from '@frontegg/react';\nexport function Nav() { const { user } = useAuth(); const login = useLoginWithRedirect(); const logout = useLogout(); return <button onClick={() => AdminPortal.show()}>x</button>; }\n`,
    );
    expect(out).toContain('TODO(atlas-migrate)');
    const text = report.map((r) => r.message).join('\n');
    expect(text).toContain('useUser() from @atlasauth/react');
    expect(text).toContain("'/sign-in' page");
    expect(text).toContain('<SignOutButton />');
    expect(text).toContain('<UserProfile />');
  });

  it('reports the Next.js session helpers and middleware', () => {
    const { report } = run(
      'middleware.ts',
      `import { getSession, FronteggAppMiddleware } from '@frontegg/nextjs/edge';\nexport const middleware = FronteggAppMiddleware;\nexport const s = getSession;\n`,
    );
    const text = report.map((r) => r.message).join('\n');
    expect(text).toContain('createAtlasMiddleware()');
    expect(text).toContain('auth() or currentUser()');
  });

  it('points @frontegg/client at the Atlas Backend API', () => {
    const { report } = run('lib/frontegg.ts', `import { FronteggContext } from '@frontegg/client';\nFronteggContext.init({ FRONTEGG_CLIENT_ID: process.env.FRONTEGG_CLIENT_ID });\n`);
    expect(report.some((r) => r.message.includes('Atlas Backend API'))).toBe(true);
  });

  it('ignores files that do not mention Frontegg', () => {
    expect(run('a.ts', `export const a = 1;\n`).out).toBeUndefined();
  });
});

describe('env', () => {
  it('maps Frontegg keys', () => {
    expect(env('NEXT_PUBLIC_FRONTEGG_CLIENT_ID', 'next')).toBe('replace with NEXT_PUBLIC_ATLAS_PUBLISHABLE_KEY');
    expect(env('VITE_FRONTEGG_CLIENT_ID', 'vite')).toBe('replace with VITE_ATLAS_PUBLISHABLE_KEY');
    expect(env('FRONTEGG_CLIENT_SECRET', 'next')).toMatch(/ATLAS_SECRET_KEY/);
    expect(env('FRONTEGG_BASE_URL', 'next')).toMatch(/bridge preset/);
    expect(env('FRONTEGG_ENCRYPTION_PASSWORD', 'next')).toMatch(/bridge/);
    expect(env('FRONTEGG_COOKIE_SAME_SITE', 'node')).toMatch(/remove/);
    expect(env('SOMETHING_ELSE', 'node')).toBeNull();
  });
});
