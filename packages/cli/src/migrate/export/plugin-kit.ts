import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { MigrationBundleWriter } from '@atlasauth/migrate';
import { CliError } from '../../errors';
import type { CredentialSpec, ExportCursor, PluginContext } from '../framework/plugin';
import type { RecordSet } from './record-set';

/**
 * What every vendor plugin shares: replaying an exporter's {@link RecordSet}
 * through the framework's bundle writer, and reading the owner's local files
 * and flags.
 */

/** Records between two export checkpoints. */
const CHECKPOINT_EVERY = 1000;

/**
 * Write a vendor export through the sealed-bundle writer: the manifest fields
 * and warnings the exporter learned, what it had to leave out, then every
 * record in canonical order. On `--resume` the vendor is read again and the
 * records an earlier segment already holds are skipped (vendor listings are
 * returned in a stable order).
 */
export async function writeRecordSet(
  set: RecordSet,
  writer: MigrationBundleWriter,
  resume: { cursor: ExportCursor | null; checkpoint(cursor: ExportCursor): void },
  say: (line: string) => void,
): Promise<void> {
  const start = typeof resume.cursor === 'number' ? resume.cursor : 0;
  writer.describe(set.manifest);
  for (const w of set.warnings) writer.warn(w);
  if (!start) for (const [model, o] of Object.entries(set.omitted)) writer.omit(model, o.reason, o.count);
  if (start) say(`  resuming after record ${start}`);
  let i = 0;
  for (const r of set.ordered()) {
    i++;
    if (i <= start) continue;
    const issues = await writer.add(r.model, r.data as never);
    if (issues.length) say(`  left out ${r.model} #${i}: ${issues[0]!.message}`);
    if (i % CHECKPOINT_EVERY === 0) resume.checkpoint(i);
  }
}

/** A credential, or a CliError naming every way to pass it. */
export function need(p: PluginContext, spec: CredentialSpec): string {
  return p.credential({ ...spec, required: true })!;
}

/** A boolean flag (`--factors`). */
export function flag(p: PluginContext, name: string): boolean {
  return (p.args.values as Record<string, unknown>)[name] === true;
}

/** A local file named by a credential spec (flag or env var), as text or bytes; undefined when not given. */
export function localFile(p: PluginContext, spec: CredentialSpec, as: 'text'): string | undefined;
export function localFile(p: PluginContext, spec: CredentialSpec, as: 'bytes'): Buffer | undefined;
export function localFile(p: PluginContext, spec: CredentialSpec, as: 'text' | 'bytes'): string | Buffer | undefined {
  const path = p.credential({ ...spec, required: false });
  if (!path) return undefined;
  try {
    return as === 'text' ? p.ctx.readFile(resolve(path)) : readFileSync(resolve(path));
  } catch (err) {
    throw new CliError(`Could not read ${spec.label} at ${path}: ${(err as Error).message}`);
  }
}

/** A vendor host (`acme.us.auth0.com`) from a host or URL. */
export function hostOf(raw: string): string {
  return raw.trim().replace(/^https?:\/\//, '').replace(/[/?#].*$/, '');
}

/** Vendor errors become CLI errors with the vendor's own words (never a stack). */
export async function vendorStep<T>(label: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof CliError) throw err;
    throw new CliError(`${label}: ${(err as Error).message}`);
  }
}
