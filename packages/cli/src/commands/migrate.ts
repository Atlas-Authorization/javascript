import { existsSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { MIGRATE_VENDORS, analyzeBetterAuth, formatMigration, resolveVendor, runMigration, unifiedDiff } from '@atlasauth/upgrade';
import { str, type ParsedArgs } from '../args';
import type { RunContext } from '../context';
import { CliError } from '../errors';
import { printJson } from '../output';
import { wantsJson } from './shared';
import { resolveFormat } from './config';
import { migrateBetterAuth } from '../migrate/better-auth/orchestrator';
import { reportJson, summaryLines, writeTranslation } from '../migrate/better-auth/output';
import { translateBetterAuth } from '../migrate/better-auth/translate';
import { hasPlugin, knownVendors, migrateExportAlias, migrateWithPlugin } from '../migrate/framework/commands';

/**
 * `atlas migrate <vendor> [config|export|import|bridge|lazy] [path]` — the
 * vendor-neutral program, one plugin per vendor (src/migrate/framework);
 * `atlas migrate export <vendor>` is the same as `atlas migrate <vendor> export`.
 *
 * `atlas migrate code --from <vendor> [path]` — rewrite an app's auth code onto
 * Atlas (Clerk, Auth.js/NextAuth, Supabase Auth, Auth0, Okta, Kinde, Descope, Better Auth).
 *
 * Safe by default: without `--yes` it is a dry run that prints the diff of every
 * file it would change plus a report of what it could not rewrite (file:line).
 * `--yes` writes the changes. Running it again over migrated code changes nothing.
 * Users move separately, with `atlas migrate <vendor>` (or `atlas import --from <vendor>`).
 */
export async function migrate(ctx: RunContext, args: ParsedArgs): Promise<number> {
  const sub = args.positionals[1];
  if (sub === 'better-auth') {
    if (args.positionals[2] === 'config') return betterAuthConfig(ctx, args, args.positionals[3]);
    return migrateBetterAuth(ctx, args, args.positionals[2]);
  }
  if (sub === 'export') return migrateExportAlias(ctx, args, args.positionals.slice(2));
  if (sub !== 'code' && sub && hasPlugin(sub)) return migrateWithPlugin(ctx, args, sub, args.positionals.slice(2));
  if (sub !== 'code') {
    const others = `Other vendors: ${knownVendors().join(', ')} (atlas migrate <vendor> [config|export|import|bridge|lazy]).`;
    throw new CliError(
      sub ? `Unknown subcommand 'migrate ${sub}'. Try: code, better-auth. ${others}` : `migrate needs a subcommand: code, better-auth. ${others}`,
    );
  }
  const raw = str(args.values, 'from');
  const vendor = resolveVendor(raw);
  if (!vendor) {
    throw new CliError(
      raw
        ? `Unknown --from '${raw}'. Use one of: ${MIGRATE_VENDORS.join(', ')}.`
        : `migrate code needs --from <${MIGRATE_VENDORS.join('|')}>.`,
    );
  }
  const target = resolve(args.positionals[2] ?? process.cwd());
  if (!existsSync(target)) throw new CliError(`Path not found: ${target}`);

  const write = args.values.yes === true && args.values['dry-run'] !== true;
  const result = runMigration(target, { from: vendor, write });

  if (wantsJson(args.values)) {
    printJson(ctx.io, {
      object: 'code_migration',
      vendor: result.vendor,
      written: write,
      env_style: result.envStyle,
      files_scanned: result.filesScanned,
      files_changed: result.filesChanged,
      rewrites: result.rewrites,
      changes: result.changes.map((c) => ({ path: c.path, diff: unifiedDiff(c.before, c.after, c.path) })),
      manual: result.manual,
      packages: result.packages,
      env_to_set: result.envToSet,
    });
    return 0;
  }

  for (const change of result.changes) {
    if (write) ctx.io.out(`updated ${change.path}`);
    else {
      ctx.io.out(unifiedDiff(change.before, change.after, change.path));
      ctx.io.out('');
    }
  }
  for (const line of formatMigration(result, { written: write })) ctx.io.out(line);
  return 0;
}

/**
 * `atlas migrate better-auth config [path]` — offline: read the app's Better Auth
 * setup statically and write the Atlas config-as-code files plus the report.
 * Needs no login; nothing is sent anywhere.
 */
async function betterAuthConfig(ctx: RunContext, args: ParsedArgs, pathArg: string | undefined): Promise<number> {
  const target = resolve(pathArg ?? process.cwd());
  if (!existsSync(target)) throw new CliError(`Path not found: ${target}`);
  const entry = str(args.values, 'entry');
  const analysis = analyzeBetterAuth(target, entry ? { entry } : {});
  if (!analysis.instances.length) {
    throw new CliError(`No betterAuth({...}) call found under ${target}. Point at the app folder, or pass --entry <file>.`);
  }
  const translation = translateBetterAuth(analysis);
  const format = resolveFormat(args.values);
  const root = statSync(target).isDirectory() ? target : dirname(target);
  const dir = resolve(root, str(args.values, 'dir') ?? 'atlas-migrate/config');
  const written = writeTranslation(translation, dir, format);
  if (wantsJson(args.values)) {
    printJson(ctx.io, { ...reportJson(translation), config_dir: dir, files: written });
    return 0;
  }
  for (const line of summaryLines(translation, dir, written)) ctx.io.out(line);
  ctx.io.out('');
  ctx.io.out(`Review the files, then apply them with: atlas config import --dir ${dir} --dry-run`);
  ctx.io.out('Or run the whole program: atlas migrate better-auth');
  return 0;
}
