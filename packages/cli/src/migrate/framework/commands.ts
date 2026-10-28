import type { ParsedArgs } from '../../args';
import type { RunContext } from '../../context';
import { CliError } from '../../errors';
import { registerBuiltInPlugins } from './builtins';
import { migrateVendor, type VendorStepId } from './orchestrator';
import { migrationPlugin, migrationPlugins } from './registry';

/**
 * `atlas migrate <vendor> [step] [path]` and `atlas migrate export <vendor> [path]`
 * for every vendor with a plugin. With no step the whole program runs (see
 * orchestrator.ts); a step runs on its own, reading and updating the same
 * state file, so `export` today and `import` tomorrow work.
 */

/** Steps a user can run on their own. */
export const SINGLE_STEPS = ['config', 'export', 'import', 'bridge', 'lazy', 'verify'] as const;

export function knownVendors(): string[] {
  registerBuiltInPlugins();
  return migrationPlugins().map((p) => p.vendor);
}

/** True when `vendor` names a registered plugin. */
export function hasPlugin(vendor: string | undefined): boolean {
  registerBuiltInPlugins();
  return !!vendor && !!migrationPlugin(vendor);
}

/**
 * Dispatch `atlas migrate <vendor> …`. `positionals` are the words after
 * `migrate` (`[vendor, step?, path?]`); a word that is not a step is the path.
 */
export async function migrateWithPlugin(ctx: RunContext, args: ParsedArgs, vendor: string, rest: string[]): Promise<number> {
  registerBuiltInPlugins();
  const plugin = migrationPlugin(vendor);
  if (!plugin) throw new CliError(`No migration plugin for '${vendor}'. Vendors: ${knownVendors().join(', ')}, better-auth.`);
  const [first, second] = rest;
  const step = first && (SINGLE_STEPS as readonly string[]).includes(first) ? (first as VendorStepId) : undefined;
  const path = step ? second : first;
  if (step === 'config' && !plugin.config) throw new CliError(`${plugin.label} has no configuration translator yet.`);
  if ((step === 'export' || step === 'import') && !plugin.export) throw new CliError(`${plugin.label} has no exporter yet.`);
  if (step === 'bridge' && !plugin.bridge) throw new CliError(`${plugin.label} has no session bridge preset.`);
  if (step === 'lazy' && !plugin.lazy) throw new CliError(`${plugin.label} has no lazy-migration preset.`);
  return migrateVendor(ctx, args, plugin, path, step);
}

/** `atlas migrate export <vendor> [path]` — an alias of `atlas migrate <vendor> export [path]`. */
export async function migrateExportAlias(ctx: RunContext, args: ParsedArgs, rest: string[]): Promise<number> {
  const [vendor, path] = rest;
  if (!vendor) throw new CliError(`migrate export needs a vendor: ${knownVendors().join(', ')}.`);
  return migrateWithPlugin(ctx, args, vendor, path ? ['export', path] : ['export']);
}
