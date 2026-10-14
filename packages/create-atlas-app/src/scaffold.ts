/**
 * The generator core: copy an authored in-repo template into a target directory,
 * renaming the dot-stripped files and substituting `{{TOKEN}}` placeholders.
 *
 * Pure filesystem work, no prompting and no process access — the CLI (`index.ts`)
 * owns argument parsing, the TTY and stdout; this module is what the tests drive
 * directly with an explicit `templatesDir` and target.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';

export const TEMPLATES = ['next', 'react-vite'] as const;
export type Template = (typeof TEMPLATES)[number];

export const DEFAULT_TEMPLATE: Template = 'next';
export const DEFAULT_DIR = 'my-atlas-app';
/** A visibly-fake key, so a generated app never ships a real credential. */
export const DEFAULT_PUBLISHABLE_KEY = 'pk_test_xxx';

export function isValidTemplate(value: string): value is Template {
  return (TEMPLATES as readonly string[]).includes(value);
}

/**
 * The shipped `templates/` tree, resolved relative to THIS file. It sits beside
 * `src/` (dev) and `dist/` (published), so `../templates` is correct from either.
 * Only ever called when a caller omits `templatesDir`; the tests pass it in.
 */
export function defaultTemplatesDir(): string {
  return join(__dirname, '..', 'templates');
}

/**
 * npm rewrites a published `.gitignore` to `.npmignore`, so the generated
 * project's ignore file is authored as `gitignore` and restored on copy.
 */
const RENAME: Readonly<Record<string, string>> = { gitignore: '.gitignore' };

/** Replace every `{{TOKEN}}`; an unknown token is left verbatim (and would fail
 *  the "no leftover placeholders" test, which is the point — nothing is silent). */
export function applyTokens(content: string, tokens: Readonly<Record<string, string>>): string {
  return content.replace(/\{\{(\w+)\}\}/g, (full, key: string) =>
    Object.prototype.hasOwnProperty.call(tokens, key) ? tokens[key]! : full,
  );
}

function isDirEmpty(dir: string): boolean {
  if (!existsSync(dir)) return true;
  return readdirSync(dir).length === 0;
}

export interface ScaffoldOptions {
  /** Absolute (or cwd-relative) directory to generate into. */
  targetDir: string;
  template: Template;
  /** Written into `package.json`/README; defaults to the target's basename. */
  projectName?: string;
  /** Substituted for `{{PUBLISHABLE_KEY}}`; defaults to the fake test key. */
  publishableKey?: string;
  /** Root of the authored templates; defaults to the shipped `templates/`. */
  templatesDir?: string;
  /** Overwrite into a non-empty directory instead of refusing. */
  force?: boolean;
}

export interface ScaffoldResult {
  targetDir: string;
  template: Template;
  projectName: string;
  /** Generated files, as POSIX-style paths relative to `targetDir`, sorted. */
  files: string[];
}

export function scaffold(opts: ScaffoldOptions): ScaffoldResult {
  const templatesDir = opts.templatesDir ?? defaultTemplatesDir();
  const src = join(templatesDir, opts.template);
  if (!existsSync(src)) {
    throw new Error(`Unknown template "${opts.template}". Expected one of: ${TEMPLATES.join(', ')}.`);
  }

  const projectName = opts.projectName ?? basename(opts.targetDir);
  const publishableKey = opts.publishableKey ?? DEFAULT_PUBLISHABLE_KEY;

  if (!isDirEmpty(opts.targetDir) && !opts.force) {
    throw new Error(
      `Refusing to scaffold into non-empty directory "${opts.targetDir}". Re-run with --force to overwrite.`,
    );
  }

  const tokens: Record<string, string> = {
    PROJECT_NAME: projectName,
    PUBLISHABLE_KEY: publishableKey,
  };

  const files: string[] = [];

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const abs = join(dir, entry);
      if (statSync(abs).isDirectory()) {
        walk(abs);
        continue;
      }
      // Rebuild the relative path with any dot-stripped basename restored.
      const parts = relative(src, abs).split(/[/\\]/);
      const last = parts[parts.length - 1]!;
      parts[parts.length - 1] = RENAME[last] ?? last;
      const outRel = parts.join('/');

      const outAbs = join(opts.targetDir, outRel);
      mkdirSync(dirname(outAbs), { recursive: true });
      writeFileSync(outAbs, applyTokens(readFileSync(abs, 'utf8'), tokens));
      files.push(outRel);
    }
  };

  mkdirSync(opts.targetDir, { recursive: true });
  walk(src);
  files.sort();

  return { targetDir: opts.targetDir, template: opts.template, projectName, files };
}
