/**
 * The `version-bump` transform: move a target project's `@atlasauth/*`
 * dependency ranges to a new version.
 *
 * This operates on `package.json` (data, not a JS AST), so it is a plain string
 * transform rather than a jscodeshift codemod. It touches only the four
 * dependency maps and leaves the rest of the manifest — field order, formatting
 * of untouched values, trailing newline — intact, because a version bump should
 * produce a minimal, reviewable diff.
 */

const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
] as const;

export interface VersionBumpResult {
  /** The rewritten package.json text (unchanged if nothing matched). */
  source: string;
  /** Names of the `@atlasauth/*` packages whose range was updated. */
  updated: string[];
}

/**
 * Normalise the requested version into a dependency range.
 *   - `latest`          -> `latest` (a dist-tag, used verbatim)
 *   - `^1.2.3` / `~1.0` -> used as-is (caller already chose an operator)
 *   - `1.2.3`           -> `^1.2.3` (caret is the ecosystem default)
 */
export function toRange(version: string): string {
  const v = version.trim();
  if (v === 'latest' || v === '*') return v;
  if (/^[\^~>=<]/.test(v)) return v;
  return `^${v}`;
}

/**
 * Rewrite every `@atlasauth/*` dependency range in `source` to `version`.
 * `workspace:*` ranges are deliberately NOT touched: inside this monorepo they
 * are correct, and a consumer project will not have them.
 */
export function bumpAtlasDeps(source: string, version: string): VersionBumpResult {
  const manifest = JSON.parse(source) as Record<string, unknown>;
  const range = toRange(version);
  const updated: string[] = [];

  for (const field of DEPENDENCY_FIELDS) {
    const deps = manifest[field];
    if (!deps || typeof deps !== 'object') continue;
    const map = deps as Record<string, string>;
    for (const name of Object.keys(map)) {
      if (!name.startsWith('@atlasauth/')) continue;
      const current = map[name];
      if (current === undefined) continue;
      if (current.startsWith('workspace:')) continue;
      if (current === range) continue;
      map[name] = range;
      updated.push(name);
    }
  }

  if (updated.length === 0) {
    return { source, updated };
  }

  // Preserve the original trailing newline (most tools write one).
  const trailing = source.endsWith('\n') ? '\n' : '';
  return { source: JSON.stringify(manifest, null, 2) + trailing, updated };
}
