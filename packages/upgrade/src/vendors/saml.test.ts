import jscodeshift from 'jscodeshift';
import type { API } from 'jscodeshift';
import { describe, expect, it } from 'vitest';
import type { ReportItem } from './engine';
import saml from './saml';

const j = jscodeshift.withParser('tsx');
const api: API = { j, jscodeshift: j, stats: () => undefined, report: () => undefined };

function run(source: string, path = 'server/auth.ts') {
  const report: ReportItem[] = [];
  const out = saml({ path, source }, api, { envStyle: 'next', onReport: (i) => report.push(i) });
  return { out, report };
}

describe('--from saml', () => {
  const SRC = `import passport from 'passport';
import { Strategy as SamlStrategy } from '@node-saml/passport-saml';
import { SAML } from '@node-saml/node-saml';
import samlify from 'samlify';

passport.use(new SamlStrategy({ entryPoint: 'https://idp.example/sso' }, (p, done) => done(null, p)));
`;

  it('marks every SAML library import with what replaces it, with file:line', () => {
    const { out, report } = run(SRC);
    expect(out).toBeDefined();
    expect(report.length).toBeGreaterThanOrEqual(3);
    for (const r of report) {
      expect(r.line).toBeGreaterThan(0);
      expect(r.message).toMatch(/Atlas is the SAML service provider/);
    }
    expect(report.map((r) => r.line)).toEqual(expect.arrayContaining([2, 3, 4]));
  });

  it('is idempotent and ignores files without SAML code', () => {
    const first = run(SRC);
    expect(run(first.out!).out).toBeUndefined();
    expect(run("import express from 'express';\n").out).toBeUndefined();
  });
});
