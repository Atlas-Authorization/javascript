import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { chooseTemplate, parseCliArgs } from './index';
import { DEFAULT_PUBLISHABLE_KEY, TEMPLATES, scaffold, type Template } from './scaffold';

/**
 * The authored templates sit at `<package>/templates`. Tests run with the
 * package directory as cwd (vitest's default), so resolve from there and never
 * touch `__dirname` — which the compiled CLI relies on but which we keep out of
 * the test entirely.
 */
const TEMPLATES_DIR = join(process.cwd(), 'templates');

const created: string[] = [];
function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'create-atlas-app-'));
  created.push(dir);
  return dir;
}

afterEach(() => {
  // mkdtemp dirs are in the OS temp root; leaving them is harmless, but the
  // overwrite tests reuse their own dirs within a case, so nothing to clean here.
});

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

const EXPECTED_DEP: Record<Template, string> = {
  next: '@atlasauth/nextjs',
  'react-vite': '@atlasauth/react',
};

describe.each(TEMPLATES)('scaffold(%s)', (template) => {
  it('writes the template with the project name and placeholder key substituted', () => {
    const targetDir = join(freshDir(), 'my-cool-app');
    const result = scaffold({ targetDir, template, templatesDir: TEMPLATES_DIR });

    expect(result.template).toBe(template);
    expect(result.projectName).toBe('my-cool-app');
    expect(result.files.length).toBeGreaterThan(0);

    // Expected files exist — incl. AGENTS.md so every scaffold is agent-ready.
    for (const rel of ['package.json', 'README.md', '.env.example', '.gitignore', 'AGENTS.md']) {
      expect(existsSync(join(targetDir, rel)), `${rel} should exist`).toBe(true);
    }

    // Project name substituted into package.json.
    const pkg = readJson(join(targetDir, 'package.json'));
    expect(pkg.name).toBe('my-cool-app');

    // Depends on the right PUBLISHED @atlasauth/* package with a caret range,
    // never a workspace protocol.
    const deps = (pkg.dependencies ?? {}) as Record<string, string>;
    const dep = EXPECTED_DEP[template];
    expect(deps[dep], `${dep} dependency`).toBeDefined();
    expect(deps[dep]!.startsWith('^')).toBe(true);
    expect(deps[dep]).not.toContain('workspace:');
    for (const range of Object.values(deps)) {
      expect(range).not.toContain('workspace:');
    }

    // .env.example carries the placeholder publishable key.
    const env = readFileSync(join(targetDir, '.env.example'), 'utf8');
    expect(env).toContain(DEFAULT_PUBLISHABLE_KEY);

    // No leftover {{token}} placeholders anywhere.
    for (const rel of result.files) {
      const content = readFileSync(join(targetDir, rel), 'utf8');
      expect(content, `${rel} has an unresolved placeholder`).not.toMatch(/\{\{\w+\}\}/);
    }

    // The gitignore was restored from its authored `gitignore` name.
    expect(result.files).toContain('.gitignore');
    expect(result.files).not.toContain('gitignore');
  });

  it('honours a custom publishable key', () => {
    const targetDir = join(freshDir(), 'app');
    scaffold({
      targetDir,
      template,
      templatesDir: TEMPLATES_DIR,
      publishableKey: 'pk_live_substituted',
    });
    const env = readFileSync(join(targetDir, '.env.example'), 'utf8');
    expect(env).toContain('pk_live_substituted');
  });
});

describe('overwrite protection', () => {
  it('refuses a non-empty directory without --force', () => {
    const targetDir = freshDir();
    writeFileSync(join(targetDir, 'existing.txt'), 'keep me');
    expect(() => scaffold({ targetDir, template: 'next', templatesDir: TEMPLATES_DIR })).toThrow(
      /non-empty/i,
    );
  });

  it('succeeds into a non-empty directory with --force', () => {
    const targetDir = freshDir();
    writeFileSync(join(targetDir, 'existing.txt'), 'keep me');
    const result = scaffold({
      targetDir,
      template: 'next',
      templatesDir: TEMPLATES_DIR,
      force: true,
    });
    expect(result.files.length).toBeGreaterThan(0);
    expect(existsSync(join(targetDir, 'package.json'))).toBe(true);
    // The pre-existing file is left in place; force overwrites, it doesn't wipe.
    expect(existsSync(join(targetDir, 'existing.txt'))).toBe(true);
  });

  it('treats a dir that exists but is empty as writable without --force', () => {
    const targetDir = join(freshDir(), 'nested');
    mkdirSync(targetDir, { recursive: true });
    const result = scaffold({ targetDir, template: 'react-vite', templatesDir: TEMPLATES_DIR });
    expect(result.files.length).toBeGreaterThan(0);
  });
});

describe('CLI argument resolution', () => {
  it('defaults the directory and package manager', () => {
    const args = parseCliArgs([]);
    expect(args.dir).toBe('my-atlas-app');
    expect(args.pm).toBe('npm');
    expect(args.template).toBeUndefined();
  });

  it('parses positional dir and flags', () => {
    const args = parseCliArgs(['my-app', '--template', 'react-vite', '--pm', 'pnpm', '--force']);
    expect(args.dir).toBe('my-app');
    expect(args.template).toBe('react-vite');
    expect(args.pm).toBe('pnpm');
    expect(args.force).toBe(true);
  });

  it('rejects an unknown template', () => {
    expect(() => parseCliArgs(['--template', 'svelte'])).toThrow(/template/i);
  });

  it('rejects an unknown package manager', () => {
    expect(() => parseCliArgs(['--pm', 'bun'])).toThrow(/pm/i);
  });

  it('--yes picks the default template non-interactively', () => {
    const args = parseCliArgs(['--yes']);
    expect(chooseTemplate(args, /* isTTY */ true)).toBe('next');
  });

  it('non-TTY picks the default template without prompting', () => {
    const args = parseCliArgs([]);
    expect(chooseTemplate(args, /* isTTY */ false)).toBe('next');
  });

  it('an explicit --template always wins', () => {
    const args = parseCliArgs(['--template', 'react-vite']);
    expect(chooseTemplate(args, false)).toBe('react-vite');
  });

  it('a TTY with no template signals a prompt', () => {
    const args = parseCliArgs([]);
    expect(chooseTemplate(args, true)).toBeNull();
  });
});
