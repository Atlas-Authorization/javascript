#!/usr/bin/env node
/**
 * `create-atlas-app` — scaffold a starter app pre-wired with Atlas auth.
 *
 *   npm create atlas-app@latest
 *   npx create-atlas-app my-app --template react-vite
 *
 * Dependency-light by design: only the Node builtins (`node:fs`, `node:path`,
 * `node:util` parseArgs, `node:readline`). No external scaffolding libraries.
 */
import { readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { showBanner } from '@atlasauth/cli-banner';
import {
  DEFAULT_DIR,
  DEFAULT_PUBLISHABLE_KEY,
  DEFAULT_TEMPLATE,
  TEMPLATES,
  isValidTemplate,
  scaffold,
  type ScaffoldResult,
  type Template,
} from './scaffold';

const PACKAGE_MANAGERS = ['npm', 'pnpm', 'yarn'] as const;
type PackageManager = (typeof PACKAGE_MANAGERS)[number];

function isValidPm(value: string): value is PackageManager {
  return (PACKAGE_MANAGERS as readonly string[]).includes(value);
}

export interface CliArgs {
  dir: string;
  template?: string;
  pm: PackageManager;
  yes: boolean;
  force: boolean;
  help: boolean;
  version: boolean;
}

/** Parse argv into validated options. Throws on an unknown `--template`/`--pm`. */
export function parseCliArgs(argv: readonly string[]): CliArgs {
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      template: { type: 'string', short: 't' },
      pm: { type: 'string' },
      yes: { type: 'boolean', short: 'y' },
      force: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean' },
    },
  });

  if (values.template !== undefined && !isValidTemplate(values.template)) {
    throw new Error(
      `Unknown --template "${values.template}". Expected one of: ${TEMPLATES.join(', ')}.`,
    );
  }
  if (values.pm !== undefined && !isValidPm(values.pm)) {
    throw new Error(`Unknown --pm "${values.pm}". Expected one of: ${PACKAGE_MANAGERS.join(', ')}.`);
  }

  return {
    dir: positionals[0] ?? DEFAULT_DIR,
    template: values.template,
    pm: (values.pm as PackageManager | undefined) ?? 'npm',
    yes: Boolean(values.yes),
    force: Boolean(values.force),
    help: Boolean(values.help),
    version: Boolean(values.version),
  };
}

/**
 * Resolve the template, or `null` when an interactive prompt is required. An
 * explicit `--template` always wins; otherwise `--yes` or a non-TTY stdin falls
 * back to the default, and only a real TTY gets prompted.
 */
export function chooseTemplate(args: CliArgs, isTTY: boolean): Template | null {
  if (args.template && isValidTemplate(args.template)) return args.template;
  if (args.yes || !isTTY) return DEFAULT_TEMPLATE;
  return null;
}

async function promptTemplate(): Promise<Template> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise<string>((res) => {
      rl.question(`? Template (${TEMPLATES.join(' / ')}) [${DEFAULT_TEMPLATE}]: `, res);
    });
    const trimmed = answer.trim();
    return trimmed && isValidTemplate(trimmed) ? trimmed : DEFAULT_TEMPLATE;
  } finally {
    rl.close();
  }
}

function readPackageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as {
      version?: string;
    };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function printHelp(): void {
  process.stdout.write(
    [
      'create-atlas-app — scaffold a starter app pre-wired with Atlas auth',
      '',
      'Usage:',
      '  create-atlas-app [dir] [options]',
      '',
      'Options:',
      `  -t, --template <name>  Template to use (${TEMPLATES.join(' | ')}). Default: ${DEFAULT_TEMPLATE}`,
      `      --pm <name>        Package manager for the printed steps (${PACKAGE_MANAGERS.join(' | ')}). Default: npm`,
      '  -y, --yes              Skip prompts and accept defaults',
      '      --force            Scaffold into a non-empty directory',
      '  -h, --help             Show this help',
      '      --version          Print the version',
      '',
    ].join('\n'),
  );
}

/** The env file a given template reads at dev time. */
function envFileFor(template: Template): string {
  return template === 'next' ? '.env.local' : '.env';
}

function printNextSteps(result: ScaffoldResult, pm: PackageManager): void {
  const rel = basename(result.targetDir);
  const install = pm === 'npm' ? 'npm install' : pm === 'pnpm' ? 'pnpm install' : 'yarn';
  const dev = pm === 'yarn' ? 'yarn dev' : `${pm} run dev`;
  const envFile = envFileFor(result.template);

  const lines = [
    '',
    `Created a ${result.template} app in ${result.targetDir}`,
    `  ${result.files.length} files written.`,
    '',
    'Next steps:',
    `  cd ${rel}`,
    `  ${install}`,
    `  cp .env.example ${envFile}   # then set your Atlas publishable key`,
    `  ${dev}`,
    '',
    'Get a publishable key from https://atlasauth.net — the template ships with a',
    `placeholder (${DEFAULT_PUBLISHABLE_KEY}).`,
    '',
  ];
  process.stdout.write(lines.join('\n'));
}

export async function run(argv: readonly string[]): Promise<number> {
  let args: CliArgs;
  try {
    args = parseCliArgs(argv);
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    return 1;
  }

  if (args.help) {
    printHelp();
    return 0;
  }
  if (args.version) {
    process.stdout.write(`${readPackageVersion()}\n`);
    return 0;
  }

  // The welcome mark: animates on an interactive TTY, stays silent when piped
  // or in CI, so scripted scaffolding is never slowed down.
  await showBanner();

  const targetDir = resolve(process.cwd(), args.dir);
  const isTTY = Boolean(process.stdin.isTTY && process.stdout.isTTY);

  let template = chooseTemplate(args, isTTY);
  if (template === null) template = await promptTemplate();

  try {
    const result = scaffold({
      targetDir,
      template,
      projectName: basename(targetDir),
      publishableKey: DEFAULT_PUBLISHABLE_KEY,
      force: args.force,
    });
    printNextSteps(result, args.pm);
    return 0;
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    return 1;
  }
}

// Only run when executed as a CLI, not when imported by the tests.
if (require.main === module) {
  void run(process.argv.slice(2)).then((code) => {
    if (code !== 0) process.exitCode = code;
  });
}
