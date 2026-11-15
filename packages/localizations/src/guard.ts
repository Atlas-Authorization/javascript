import { enUS } from './en-US';

/**
 * A guard for translation bundles, beyond "no duplicate lines": what a reviewer would check by eye and
 * a CI job can check for them.
 *
 *  - `missing`              a key the reference has and the bundle lacks
 *  - `extra`                a key the reference does not have (a typo, or a removed string left behind)
 *  - `empty`                a blank string
 *  - `placeholder_mismatch` the bundle uses different `{placeholders}` than the reference (a translation that drops
 *                           `{email}` shows a sentence with a hole in it)
 *  - `untranslated`         identical to the reference text, with words in it (a warning: brand names and
 *                           codes legitimately repeat; see `allowUntranslated`)
 *
 * The first four are failures; `untranslated` is reported separately.
 */
export type GuardIssueKind = 'missing' | 'extra' | 'empty' | 'placeholder_mismatch' | 'untranslated';

export interface GuardIssue {
  kind: GuardIssueKind;
  key: string;
  message: string;
}

export interface GuardResult {
  /** Problems that must be fixed. */
  failures: GuardIssue[];
  /** Worth a look, not a failure. */
  warnings: GuardIssue[];
}

const placeholders = (s: string): string[] => [...new Set([...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!))].sort();
const hasWords = (s: string): boolean => (s.match(/\p{L}{3,}/gu) ?? []).length > 0;

export function checkBundle(
  bundle: Readonly<Record<string, unknown>>,
  reference: Readonly<Record<string, unknown>> = enUS as unknown as Readonly<Record<string, unknown>>,
  opts: { allowUntranslated?: readonly string[] } = {},
): GuardResult {
  const failures: GuardIssue[] = [];
  const warnings: GuardIssue[] = [];
  const allow = new Set(opts.allowUntranslated ?? []);
  for (const [key, ref] of Object.entries(reference)) {
    if (key === 'locale') continue;
    const value = bundle[key];
    if (value === undefined) {
      failures.push({ kind: 'missing', key, message: `"${key}" has no translation.` });
      continue;
    }
    if (typeof value !== 'string' || typeof ref !== 'string') continue;
    if (!value.trim()) {
      failures.push({ kind: 'empty', key, message: `"${key}" is empty.` });
      continue;
    }
    const want = placeholders(ref);
    const got = placeholders(value);
    if (want.join() !== got.join()) {
      failures.push({ kind: 'placeholder_mismatch', key, message: `"${key}" uses {${got.join(', ')}} but the reference uses {${want.join(', ')}}.` });
    }
    if (value === ref && hasWords(ref) && !allow.has(key)) warnings.push({ kind: 'untranslated', key, message: `"${key}" is identical to the reference text.` });
  }
  for (const key of Object.keys(bundle)) {
    if (key === 'locale') continue;
    if (!(key in reference)) failures.push({ kind: 'extra', key, message: `"${key}" is not a key of the reference.` });
  }
  return { failures, warnings };
}
