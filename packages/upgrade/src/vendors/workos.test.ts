import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import jscodeshift from 'jscodeshift';
import type { API } from 'jscodeshift';
import { describe, expect, it } from 'vitest';

import type { EnvStyle, ReportItem } from './engine';
import workos, { env } from './workos';

const j = jscodeshift.withParser('tsx');
const api: API = { j, jscodeshift: j, stats: () => undefined, report: () => undefined };
const FIXTURES = join(__dirname, '__fixtures__', 'workos');

function run(path: string, source: string, envStyle: EnvStyle = 'next') {
  const report: ReportItem[] = [];
  const out = workos({ path, source }, api, { envStyle, onReport: (r) => report.push(r) });
  return { out, report };
}

/** Whitespace-free, so the checks do not depend on how recast lays out a rebuilt argument. */
const squash = (s: string | undefined) => (s ?? '').replace(/\s+/g, '');

describe('--from workos fixtures', () => {
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

describe('authkitMiddleware', () => {
  it('turns unauthenticatedPaths into publicRoutes when middlewareAuth is enabled', () => {
    const { out, report } = run(
      'middleware.ts',
      `import { authkitMiddleware } from '@workos-inc/authkit-nextjs';\nexport default authkitMiddleware({ middlewareAuth: { enabled: true, unauthenticatedPaths: ['/', '/pricing', '/blog/*'] }, debug: true });\n`,
    );
    expect(out).toContain("import { createAtlasMiddleware } from '@atlasauth/nextjs/compat'");
    expect(out).not.toContain('@workos-inc');
    expect(squash(out)).toContain("createAtlasMiddleware({publicRoutes:['/','/pricing','/blog/(.*)']})");
    expect(report.some((r) => r.message.includes('removed authkitMiddleware options') && r.message.includes('debug'))).toBe(true);
  });

  it('keeps every route public when middlewareAuth is not enabled (as AuthKit did)', () => {
    const { out, report } = run('middleware.ts', `import { authkitMiddleware } from '@workos-inc/authkit-nextjs';\nexport default authkitMiddleware();\n`);
    expect(squash(out)).toContain("createAtlasMiddleware({publicRoutes:['/(.*)']})");
    expect(report.some((r) => r.message.includes('did not protect pages'))).toBe(true);
  });

  it('leaves options it cannot convert on the vendor import and says why', () => {
    const src = `import { authkitMiddleware } from '@workos-inc/authkit-nextjs';\nexport default authkitMiddleware({ middlewareAuth: { enabled: true, unauthenticatedPaths: ['/blog/:slug'] } });\n`;
    const { out, report } = run('middleware.ts', src);
    expect(out ?? src).toContain('@workos-inc/authkit-nextjs');
    expect(report.some((r) => r.message.includes('unauthenticatedPaths'))).toBe(true);
  });
});

describe('other AuthKit and WorkOS calls', () => {
  it('reports withAuth, getSignInUrl and handleAuth with the Atlas call to use', () => {
    const { out, report } = run(
      'app/page.tsx',
      `import { withAuth, getSignInUrl, handleAuth } from '@workos-inc/authkit-nextjs';\nexport const GET = handleAuth();\nexport async function Page() { const { user } = await withAuth(); return getSignInUrl(); }\n`,
    );
    expect(out).toContain('TODO(atlas-migrate)');
    const text = report.map((r) => r.message).join('\n');
    expect(text).toContain('auth() or currentUser()');
    expect(text).toContain("'/sign-in' page");
    expect(text).toContain('callback route is no longer used');
  });

  it('points @workos-inc/node at the Atlas Backend API', () => {
    const { report } = run('lib/workos.ts', `import { WorkOS } from '@workos-inc/node';\nexport const workos = new WorkOS(process.env.WORKOS_API_KEY);\n`);
    expect(report.some((r) => r.message.includes('Atlas Backend API'))).toBe(true);
    expect(report.some((r) => r.message.startsWith('WORKOS_API_KEY'))).toBe(true);
  });

  it('ignores files that do not mention WorkOS', () => {
    expect(run('a.ts', `export const a = 1;\n`).out).toBeUndefined();
  });
});

describe('env', () => {
  it('maps WorkOS keys', () => {
    expect(env('NEXT_PUBLIC_WORKOS_CLIENT_ID', 'next')).toBe('replace with NEXT_PUBLIC_ATLAS_PUBLISHABLE_KEY');
    expect(env('VITE_WORKOS_CLIENT_ID', 'vite')).toBe('replace with VITE_ATLAS_PUBLISHABLE_KEY');
    expect(env('WORKOS_API_KEY', 'next')).toMatch(/ATLAS_SECRET_KEY/);
    expect(env('WORKOS_COOKIE_PASSWORD', 'next')).toMatch(/workosSessionTokenExtractor/);
    expect(env('WORKOS_WEBHOOK_SECRET', 'node')).toMatch(/webhook/);
    expect(env('WORKOS_COOKIE_SAMESITE', 'node')).toMatch(/remove/);
    expect(env('SOMETHING_ELSE', 'node')).toBeNull();
  });
});
