import { existsSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type { CredentialSpec, PluginContext } from '../framework/plugin';
import { localFile } from './plugin-kit';

/**
 * A config file the vendor keeps in the app's repository (appwrite.json,
 * nhost/nhost.toml, pb_schema.json): the path named by the flag / env var, or
 * the first of `candidates` that exists in the project folder. The report
 * shows the path relative to the project.
 */
export function projectFile(p: PluginContext, spec: CredentialSpec, candidates: string[]): { path: string; text: string } | undefined {
  const named = p.credential({ ...spec, required: false });
  if (named) return { path: named, text: localFile(p, spec, 'text')! };
  for (const c of candidates) {
    const full = resolve(p.project, c);
    if (existsSync(full) && statSync(full).isFile()) return { path: relative(resolve(p.project), full) || c, text: p.ctx.readFile(full) };
  }
  return undefined;
}

/** A folder the owner named (a table dump), or the first candidate folder that exists in the project. */
export function projectDir(p: PluginContext, spec: CredentialSpec, candidates: string[] = []): string | undefined {
  const named = p.credential({ ...spec, required: false });
  if (named) return resolve(named);
  for (const c of candidates) {
    const full = join(resolve(p.project), c);
    if (existsSync(full) && statSync(full).isDirectory()) return full;
  }
  return undefined;
}

/** `--set name=true` / an env var set to true, 1 or yes. */
export function truthyCredential(p: PluginContext, spec: CredentialSpec): boolean {
  const v = p.credential({ ...spec, required: false });
  return v !== undefined && /^(1|true|yes|on)$/i.test(v.trim());
}
