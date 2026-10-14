import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import jscodeshift from 'jscodeshift';
import type { API, FileInfo } from 'jscodeshift';

import clerkToAtlas, { type ClerkToAtlasOptions } from './transforms/clerk-to-atlas';

/** Source extensions we feed to the codemod. */
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];

/**
 * Directories we never descend into. `node_modules`/`dist`/`.git` are the three
 * the brief calls out; the rest are conventional build/output dirs that only
 * ever contain generated code, which must not be rewritten.
 */
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'build', 'coverage', '.next', 'out', '.turbo']);

export interface FileChange {
  /** Path relative to the scanned root, for stable, readable output. */
  path: string;
  before: string;
  after: string;
}

export interface RunResult {
  filesScanned: number;
  filesChanged: number;
  symbolsRewritten: number;
  /** Count of `// TODO(atlas-upgrade)` markers added, surfaced so the summary
   * can tell a developer how much still needs a manual look. */
  todos: number;
  changes: FileChange[];
}

export interface RunClerkToAtlasOptions {
  /** When false, nothing is written to disk regardless of what changed. */
  write: boolean;
}

/**
 * Recursively collect source files under `dir`, skipping the directories in
 * `SKIP_DIRS`. Hand-rolled (no glob dependency) to stay dependency-light and to
 * keep the skip rules explicit.
 */
export function collectSourceFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string) => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return; // unreadable dir — skip rather than crash the whole run
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(full);
      } else if (entry.isFile() && SOURCE_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) {
        out.push(full);
      }
    }
  };

  const root = statSync(dir);
  if (root.isFile()) return [dir];
  walk(dir);
  return out.sort();
}

/** Build the jscodeshift `api` object a transform expects, parsing TS/JSX. */
function makeApi(): API {
  // The `tsx` parser handles .ts/.tsx/.js/.jsx uniformly, so one api serves all
  // our source extensions.
  const j = jscodeshift.withParser('tsx');
  return {
    j,
    jscodeshift: j,
    stats: () => undefined,
    report: () => undefined,
  };
}

/**
 * Run the clerk-to-atlas codemod across every source file under `root`.
 *
 * This always computes the full set of changes (so a caller can print a dry-run
 * diff); it only touches disk when `write` is true. That split is what makes
 * `--dry` safe and the behaviour unit-testable without a filesystem round-trip.
 */
export function runClerkToAtlas(root: string, { write }: RunClerkToAtlasOptions): RunResult {
  const api = makeApi();
  const files = collectSourceFiles(root);
  const changes: FileChange[] = [];
  let symbolsRewritten = 0;
  let todos = 0;

  for (const file of files) {
    const before = readFileSync(file, 'utf8');
    const options: ClerkToAtlasOptions = {
      onCount: (kind) => {
        // "symbols rewritten" is the migrated surface (imports/identifiers/env);
        // TODO markers are tracked apart since they are deferrals, not rewrites.
        if (kind === 'todo') todos++;
        else symbolsRewritten++;
      },
    };
    const info: FileInfo = { path: file, source: before };

    let after: string | undefined;
    try {
      after = clerkToAtlas(info, api, options);
    } catch {
      // A file that fails to parse (e.g. exotic syntax) is left untouched; the
      // migration of one file must not abort the whole run.
      continue;
    }

    if (after !== undefined && after !== before) {
      changes.push({ path: relative(root, file) || file, before, after });
      if (write) writeFileSync(file, after, 'utf8');
    }
  }

  return {
    filesScanned: files.length,
    filesChanged: changes.length,
    symbolsRewritten,
    todos,
    changes,
  };
}
