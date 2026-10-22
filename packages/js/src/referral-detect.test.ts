import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { detectConsent, detectConsentProvider, detectReferralSource, resetConsentDetection } from './referral-detect';

/**
 * The shared fixtures (test-fixtures/referral-detect.json): the same cases run
 * against the ES5 copy in the Atlas API, so both readers agree.
 */

interface Fixture {
  name: string;
  win: Record<string, unknown>;
  fns?: Record<string, unknown>;
  cookies?: string;
}
const fixtures = JSON.parse(readFileSync(join(__dirname, '..', 'test-fixtures', 'referral-detect.json'), 'utf8')) as {
  sources: Array<Fixture & { sources: string[]; expect: Record<string, unknown> | null }>;
  consent: Array<Fixture & { categories: string[]; provider?: string; appConsent?: string; expect: { granted: boolean; by: string } }>;
};

/** A window from a fixture: plain data plus functions at dotted paths. */
export function windowFrom(f: Fixture): Record<string, unknown> {
  const win = JSON.parse(JSON.stringify(f.win)) as Record<string, unknown>;
  for (const [path, value] of Object.entries(f.fns ?? {})) {
    const keys = path.split('.');
    let o = win;
    for (const k of keys.slice(0, -1)) o = (o[k] ??= {}) as Record<string, unknown>;
    const last = keys[keys.length - 1]!;
    o[last] =
      value === '__throw__'
        ? () => {
            throw new Error('boom');
          }
        : last === 'cmplz_has_consent'
          ? (k: string) => (value as Record<string, unknown>)[k]
          : last === '__tcfapi'
            ? (cmd: string, _v: number, cb: (d: unknown, ok: boolean) => void) => {
                if (cmd === 'getTCData' || cmd === 'addEventListener') cb(value, true);
              }
            : () => value;
  }
  return win;
}

afterEach(() => resetConsentDetection());

describe('browser referral sources (shared fixtures)', () => {
  for (const f of fixtures.sources) {
    it(f.name, () => {
      expect(detectReferralSource({ win: windowFrom(f), cookies: f.cookies ?? '' }, f.sources)).toEqual(f.expect);
    });
  }
});

describe('consent managers (shared fixtures)', () => {
  for (const f of fixtures.consent) {
    it(f.name, () => {
      expect(detectConsent(windowFrom(f), f.categories, { provider: f.provider, appConsent: f.appConsent as 'granted' | undefined })).toEqual(
        f.expect,
      );
    });
  }
});

describe('detectConsentProvider', () => {
  it('names the manager on the page, or null', () => {
    expect(detectConsentProvider({ OnetrustActiveGroups: ',C0001,' })).toBe('onetrust');
    expect(detectConsentProvider({})).toBeNull();
    expect(detectConsentProvider(undefined)).toBeNull();
  });
});
