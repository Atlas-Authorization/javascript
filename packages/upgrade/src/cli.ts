#!/usr/bin/env node
/*
 * `atlas-upgrade` — the Atlas peer of `@clerk/upgrade`.
 *
 * Two jobs:
 *   1. migrate a codebase to Atlas: Clerk (default / `--from clerk` /
 *      `--transform clerk-to-atlas`), or `--from authjs | supabase | auth0 |
 *      better-auth | openid-client | jose | generic-oidc | lucia | passport |
 *      iron-session |
 *      firebase | cognito | azure-ad-b2c | entra-external-id | appwrite |
 *      pocketbase | nhost` (the same engine `atlas migrate code` drives);
 *   2. move a project's `@atlasauth/*` dependency ranges across versions
 *      (`--transform version-bump --to <version>`).
 *
 * Arg parsing is `node:util`'s `parseArgs` — no `commander`, to stay
 * dependency-light. `main()` is exported and returns an exit code rather than
 * calling `process.exit`, so it can be driven from tests.
 */
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import { unifiedDiff } from './diff';
import { formatMigration, MIGRATE_VENDORS, resolveVendor, runMigration } from './migrate';
import { runClerkToAtlas } from './runner';
import { bumpAtlasDeps } from './transforms/version-bump';

const HELP = `atlas-upgrade — migrate Clerk -> Atlas and bump Atlas SDK versions

Usage:
  atlas-upgrade [path] [options]

Options:
  --from <vendor>         Source to migrate from: clerk (default), authjs,
                          supabase, auth0, better-auth, openid-client,
                          jose, generic-oidc, lucia, passport,
                          iron-session, firebase,
                          cognito, azure-ad-b2c, entra-external-id,
                          appwrite, pocketbase, nhost.
  --transform <name>      clerk-to-atlas (default) | version-bump
  --to <version>          Target version for version-bump (default: latest).
  --dry                   Print a diff and write nothing.
  --yes                   Apply changes without prompting / without a TTY.
  --help                  Show this help.

Examples:
  atlas-upgrade ./src --dry
  atlas-upgrade . --yes
  atlas-upgrade . --transform version-bump --to 0.2.0 --yes
`;

interface Cli {
  positionals: string[];
  from?: string;
  transform?: string;
  to?: string;
  dry: boolean;
  yes: boolean;
  help: boolean;
}

export function parseCliArgs(argv: string[]): Cli {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      from: { type: 'string' },
      transform: { type: 'string' },
      to: { type: 'string' },
      dry: { type: 'boolean', default: false },
      yes: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  });
  return {
    positionals,
    from: values.from,
    transform: values.transform,
    to: values.to,
    dry: Boolean(values.dry),
    yes: Boolean(values.yes),
    help: Boolean(values.help),
  };
}

/** A minimal logger seam so tests can capture output instead of the console. */
export interface Logger {
  log: (msg?: string) => void;
  error: (msg?: string) => void;
}

const consoleLogger: Logger = {
  log: (m = '') => process.stdout.write(`${m}\n`),
  error: (m = '') => process.stderr.write(`${m}\n`),
};

export interface MainEnv {
  logger?: Logger;
  /** Overridable for tests; defaults to the real stdout TTY flag. */
  isTty?: boolean;
}

/**
 * Run the CLI. Returns a process exit code (0 ok, 1 usage error).
 */
export function main(argv: string[], env: MainEnv = {}): number {
  const log = env.logger ?? consoleLogger;
  const isTty = env.isTty ?? Boolean(process.stdout.isTTY);

  let cli: Cli;
  try {
    cli = parseCliArgs(argv);
  } catch (err) {
    log.error(`atlas-upgrade: ${(err as Error).message}`);
    log.error(HELP);
    return 1;
  }

  if (cli.help) {
    log.log(HELP);
    return 0;
  }

  const target = cli.positionals[0] ?? process.cwd();
  if (!existsSync(target)) {
    log.error(`atlas-upgrade: path not found: ${target}`);
    return 1;
  }

  // Safety: with no TTY and no explicit --yes, never write. This makes the tool
  // safe to drop into CI/scripts, where an accidental in-place rewrite would be
  // a nasty surprise. --dry forces the same no-write behaviour explicitly.
  let write = cli.yes;
  if (cli.dry) write = false;
  if (!isTty && !cli.yes) {
    write = false;
    if (!cli.dry) {
      log.log('atlas-upgrade: no TTY and no --yes; running a safe dry run (nothing will be written).');
    }
  }

  const transform = cli.transform ?? 'clerk-to-atlas';

  if (transform === 'version-bump') {
    return runVersionBump(target, cli.to ?? 'latest', write, log);
  }
  if (transform === 'clerk-to-atlas') {
    const vendor = cli.from ? resolveVendor(cli.from) : 'clerk';
    if (!vendor) {
      log.error(`atlas-upgrade: unsupported --from '${cli.from}' (one of: ${MIGRATE_VENDORS.join(', ')}).`);
      return 1;
    }
    if (vendor !== 'clerk') return runVendor(target, vendor, write, log);
    return runCodemod(target, write, cli.dry, log);
  }

  log.error(`atlas-upgrade: unknown --transform '${transform}'.`);
  log.error(HELP);
  return 1;
}

function runCodemod(target: string, write: boolean, dry: boolean, log: Logger): number {
  const result = runClerkToAtlas(target, { write });

  for (const change of result.changes) {
    if (dry || !write) {
      log.log(unifiedDiff(change.before, change.after, change.path));
      log.log('');
    } else {
      log.log(`  updated ${change.path}`);
    }
  }

  log.log('atlas-upgrade: clerk-to-atlas');
  log.log(`  files scanned:       ${result.filesScanned}`);
  log.log(`  files changed:       ${result.filesChanged}`);
  log.log(`  symbols rewritten:   ${result.symbolsRewritten}`);
  if (result.todos > 0) {
    log.log(`  TODOs for review:    ${result.todos}  (search for "TODO(atlas-upgrade)")`);
  }
  if (!write && result.filesChanged > 0) {
    log.log('  (dry run — nothing was written; re-run with --yes to apply)');
  }
  return 0;
}

function runVendor(target: string, vendor: Exclude<ReturnType<typeof resolveVendor>, undefined>, write: boolean, log: Logger): number {
  const result = runMigration(target, { from: vendor, write });
  for (const change of result.changes) {
    if (write) log.log(`  updated ${change.path}`);
    else {
      log.log(unifiedDiff(change.before, change.after, change.path));
      log.log('');
    }
  }
  for (const line of formatMigration(result, { written: write, command: 'atlas-upgrade' })) log.log(line);
  return 0;
}

function runVersionBump(target: string, version: string, write: boolean, log: Logger): number {
  // Accept either a directory (use its package.json) or a package.json path.
  const pkgPath = statSync(target).isDirectory() ? join(target, 'package.json') : target;
  if (!existsSync(pkgPath)) {
    log.error(`atlas-upgrade: no package.json at ${pkgPath}`);
    return 1;
  }

  const before = readFileSync(pkgPath, 'utf8');
  const { source: after, updated } = bumpAtlasDeps(before, version);

  if (updated.length === 0) {
    log.log('atlas-upgrade: version-bump — no @atlasauth/* dependencies to update.');
    return 0;
  }

  if (write) {
    writeFileSync(pkgPath, after, 'utf8');
  } else {
    log.log(unifiedDiff(before, after, pkgPath));
    log.log('');
  }

  log.log('atlas-upgrade: version-bump');
  log.log(`  package.json:        ${pkgPath}`);
  log.log(`  packages updated:    ${updated.length}  -> ${version}`);
  for (const name of updated) log.log(`    - ${name}`);
  if (!write) {
    log.log('  (dry run — nothing was written; re-run with --yes to apply)');
  }
  return 0;
}

// Run only when invoked as a script, not when imported by tests.
if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}
