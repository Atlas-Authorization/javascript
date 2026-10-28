import { sourceFromVendor } from '@atlasauth/migrate';
import type { MigrationPlugin } from './plugin';

/**
 * The `atlas migrate <vendor>` plugin registry. A vendor track adds its plugin
 * module under src/migrate/<vendor>/ and one line to BUILT_IN_PLUGINS in
 * ./builtins.ts — nothing else in the framework changes.
 */

const plugins = new Map<string, MigrationPlugin>();

export function registerMigrationPlugin(plugin: MigrationPlugin, options: { replace?: boolean } = {}): void {
  if (plugins.has(plugin.vendor) && !options.replace) throw new Error(`atlas migrate: plugin "${plugin.vendor}" is already registered.`);
  plugins.set(plugin.vendor, plugin);
}

/** Whether a plugin is registered under exactly this vendor name (no alias / source matching). */
export function hasMigrationPlugin(vendor: string): boolean {
  return plugins.has(vendor.toLowerCase());
}

/** The plugin for a vendor spelling (`auth0`, `aws-cognito`, `next-auth` …), or undefined. */
export function migrationPlugin(vendor: string): MigrationPlugin | undefined {
  const direct = plugins.get(vendor.toLowerCase());
  if (direct) return direct;
  const source = sourceFromVendor(vendor);
  if (!source) return undefined;
  for (const p of plugins.values()) if (p.source === source) return p;
  return undefined;
}

export function migrationPlugins(): MigrationPlugin[] {
  return [...plugins.values()].sort((a, b) => a.vendor.localeCompare(b.vendor));
}

/** Test helper: forget every registered plugin. */
export function resetMigrationPlugins(): void {
  plugins.clear();
}
