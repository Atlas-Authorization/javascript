import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import jscodeshift from 'jscodeshift';
import type { API } from 'jscodeshift';
import { describe, expect, it } from 'vitest';

import auth0 from './auth0';
import authjs from './authjs';
import betterAuth from './better-auth';
import type { EnvStyle, ReportItem, VendorTransform } from './engine';
import ironSession from './iron-session';
import lucia from './lucia';
import { genericOidcToAtlas, joseToAtlas, openidClientToAtlas } from './oidc';
import descope from './descope';
import kinde from './kinde';
import okta from './okta';
import passport from './passport';
import { OSS_IDP_TRANSFORMS } from './oss-idps';
import supabase from './supabase';
import firebase from './firebase';
import cognito from './cognito';
import azure from './azure';
import appwrite from './appwrite';
import pocketbase from './pocketbase';
import nhost from './nhost';

/**
 * Fixture-driven tests: `__fixtures__/<vendor>/<case>.in` is a source file as an
 * app would have it, `<case>.out` the exact migrated result. `cases.json` gives
 * each case the path it lives at (which decides browser vs server vs middleware),
 * the project's env style, and report lines that must appear.
 *
 * Every case is also run a SECOND time over its own output, which must produce no
 * change at all: the codemod is idempotent.
 *
 * `UPDATE_FIXTURES=1` rewrites the `.out` files from the current transforms (for
 * reviewing a deliberate change as a diff).
 */
const j = jscodeshift.withParser('tsx');
const api: API = { j, jscodeshift: j, stats: () => undefined, report: () => undefined };

const VENDORS: Record<string, VendorTransform> = {
  authjs,
  supabase,
  auth0,
  'better-auth': betterAuth,
  okta,
  kinde,
  descope,
  'openid-client': openidClientToAtlas,
  jose: joseToAtlas,
  'generic-oidc': genericOidcToAtlas,
  lucia,
  passport,
  'iron-session': ironSession,
  firebase,
  cognito,
  azure,
  appwrite,
  pocketbase,
  nhost,
  ...OSS_IDP_TRANSFORMS,
};
const ROOT = join(__dirname, '__fixtures__');
const UPDATE = process.env.UPDATE_FIXTURES === '1';

interface Case {
  name: string;
  path: string;
  envStyle?: EnvStyle;
  unchanged?: boolean;
  manual?: string[];
}

function run(transform: VendorTransform, c: Case, source: string) {
  const report: ReportItem[] = [];
  const out = transform({ path: c.path, source }, api, {
    envStyle: c.envStyle ?? 'next',
    onReport: (item) => report.push(item),
  });
  return { out, report };
}

for (const vendor of readdirSync(ROOT)) {
  const transform = VENDORS[vendor];
  if (!transform) continue;
  const cases = JSON.parse(readFileSync(join(ROOT, vendor, 'cases.json'), 'utf8')) as Case[];

  describe(`--from ${vendor}`, () => {
    for (const c of cases) {
      it(`${c.name} (${c.path})`, () => {
        const input = readFileSync(join(ROOT, vendor, `${c.name}.in`), 'utf8');
        const { out, report } = run(transform, c, input);
        const outPath = join(ROOT, vendor, `${c.name}.out`);

        if (c.unchanged) {
          expect(out).toBeUndefined();
        } else {
          expect(out, 'expected a rewrite').toBeDefined();
          if (UPDATE) writeFileSync(outPath, out!, 'utf8');
          expect(existsSync(outPath), `missing fixture ${outPath}`).toBe(true);
          expect(out).toBe(readFileSync(outPath, 'utf8'));
        }

        for (const expected of c.manual ?? []) {
          expect(
            report.some((r) => r.message.includes(expected)),
            `report should mention: ${expected}\n${report.map((r) => `${r.line}: ${r.message}`).join('\n')}`,
          ).toBe(true);
        }
        // Every report entry carries a real line in the input.
        for (const r of report) expect(r.line, r.message).toBeGreaterThan(0);

        // Idempotent: a second run over the result changes nothing.
        const again = run(transform, c, out ?? input);
        expect(again.out).toBeUndefined();
        // …and reports nothing new beyond what is still there to do.
        const firstMessages = new Set(report.map((r) => r.message));
        for (const r of again.report) {
          if (!firstMessages.has(r.message)) {
            // Lines only shift when markers were added; the message set is stable.
            throw new Error(`second run reported something new: ${r.message}`);
          }
        }
      });
    }
  });
}
