import { splitBundleParts, type BetterAuthImport, type BetterAuthImportKey } from '@atlasauth/backend';
import { str, type ParsedArgs } from '../args';
import type { RunContext } from '../context';
import { CliError } from '../errors';
import { printJson } from '../output';
import { httpFor } from '../project';
import { resolveAuth, wantsJson } from './shared';

/**
 * `atlas import --from better-auth --bundle <file>` — import a sealed bundle
 * written by `npx atlas-better-auth-export` (package @atlasauth/better-auth-migrate).
 *
 *   --bundle <file>       upload the bundle, run the dry run, then apply
 *   --import <id>         continue an import already uploaded (e.g. with --upload)
 *   --dry-run             stop after the dry-run report; nothing is imported
 *   --confirm-conflicts   apply even though the dry run found conflicts
 *   --options <json|@f>   import options, e.g. '{"import_sessions":false}'
 *   --yes                 do not ask before applying
 *
 * Without --bundle or --import it prints the instance's import public key and
 * the export command to run in the Better Auth app.
 *
 * Re-running is safe: every record is an idempotent upsert, and running it on a
 * failed import resumes where it stopped.
 */

type Http = ReturnType<typeof httpFor>;

function parseOptions(ctx: RunContext, raw: string | undefined): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  const text = raw.startsWith('@') ? ctx.readFile(raw.slice(1)) : raw;
  try {
    const v = JSON.parse(text) as unknown;
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object');
    return v as Record<string, unknown>;
  } catch {
    throw new CliError('--options must be a JSON object, or @<file> holding one.');
  }
}

function printReport(ctx: RunContext, imp: BetterAuthImport): void {
  const out = (s: string) => ctx.io.out(s);
  const r = imp.report;
  if (!r) return;
  out('Dry run (nothing imported yet):');
  for (const m of r.models) {
    out(`  ${m.label.padEnd(44)} ${String(m.found).padStart(6)} found  ${String(m.will_create).padStart(6)} new  ${String(m.will_update).padStart(6)} existing  ${String(m.will_skip).padStart(6)} skipped`);
  }
  if (r.conflicts_total) {
    out(`Conflicts with existing Atlas data: ${r.conflicts_total}`);
    for (const c of r.conflicts.slice(0, 10)) out(`  [${c.resolution}] ${c.model} ${c.row_id ?? ''}: ${c.message}`);
  }
  for (const a of r.action_items) out(`${a.severity === 'required' ? 'REQUIRED' : a.severity === 'recommended' ? 'todo' : 'note'}: ${a.message} (${a.count}${a.items.length ? `: ${a.items.slice(0, 5).join(', ')}` : ''})`);
  for (const w of r.warnings) out(`warning: ${w}`);
  if (r.skipped_total) {
    out(`Skipped rows: ${r.skipped_total}`);
    for (const [code, n] of Object.entries(r.skipped_by_code)) out(`  ${code}: ${n}`);
  }
}

function printResult(ctx: RunContext, imp: BetterAuthImport): void {
  const r = imp.result;
  if (!r) return;
  ctx.io.out(`Imported (import ${imp.id}):`);
  for (const m of r.models) {
    ctx.io.out(`  ${m.label.padEnd(44)} ${m.created} created, ${m.updated + m.unchanged} existing, ${m.skipped} skipped, ${m.failed} failed`);
  }
}

async function poll(ctx: RunContext, http: Http, imp: BetterAuthImport, json: boolean): Promise<BetterAuthImport> {
  const sleep = ctx.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let last = -1;
  while (['analyzing', 'queued', 'applying'].includes(imp.status)) {
    await sleep(2000);
    imp = await http.get<BetterAuthImport>(`/v1/better_auth_imports/${encodeURIComponent(imp.id)}`);
    const pct = imp.progress?.percent ?? -1;
    if (!json && pct !== last && imp.progress) ctx.io.err(`  ${imp.status}: ${imp.progress.processed}/${imp.progress.total} (${pct}%)`);
    last = pct;
  }
  return imp;
}

export async function importBetterAuthBundle(ctx: RunContext, args: ParsedArgs): Promise<number> {
  const json = wantsJson(args.values);
  const auth = resolveAuth(ctx, args.values);
  const http = httpFor(ctx, { secretKey: auth.secretKey, apiUrl: auth.apiUrl });
  const bundle = str(args.values, 'bundle');
  const existing = str(args.values, 'import');
  const options = parseOptions(ctx, str(args.values, 'options'));

  if (!bundle && !existing) {
    const key = await http.get<BetterAuthImportKey>('/v1/better_auth_imports/public_key');
    if (json) printJson(ctx.io, key);
    else {
      ctx.io.out(`Import key ${key.kid} (fingerprint ${key.fingerprint}).`);
      ctx.io.out('In your Better Auth app, run:');
      ctx.io.out(`  npx atlas-better-auth-export --out better-auth.atlas-bundle --public-key ${key.compact}`);
      ctx.io.out('then:');
      ctx.io.out('  atlas import --from better-auth --bundle better-auth.atlas-bundle');
    }
    return 0;
  }

  let imp: BetterAuthImport;
  if (bundle) {
    const text = ctx.readFile(bundle);
    const parts = splitBundleParts(text);
    if (parts.length === 0) throw new CliError(`${bundle} is empty.`);
    imp = await http.post<BetterAuthImport>('/v1/better_auth_imports', options ? { options } : {});
    for (let i = 0; i < parts.length; i++) {
      await http.put(`/v1/better_auth_imports/${encodeURIComponent(imp.id)}/parts/${i + 1}`, { data: parts[i] });
      if (!json) ctx.io.err(`  uploaded part ${i + 1}/${parts.length}`);
    }
    imp = await http.post<BetterAuthImport>(`/v1/better_auth_imports/${encodeURIComponent(imp.id)}/finalize`, {});
  } else {
    imp = await http.get<BetterAuthImport>(`/v1/better_auth_imports/${encodeURIComponent(existing!)}`);
    if (imp.status === 'uploading') {
      imp = await http.post<BetterAuthImport>(`/v1/better_auth_imports/${encodeURIComponent(imp.id)}/finalize`, {});
    } else if (options && ['ready', 'failed', 'completed'].includes(imp.status)) {
      imp = await http.post<BetterAuthImport>(`/v1/better_auth_imports/${encodeURIComponent(imp.id)}/dry_run`, { options });
    }
  }
  imp = await poll(ctx, http, imp, json);

  if (imp.status === 'invalid' || (imp.status === 'failed' && !imp.analyzed_at)) {
    if (json) printJson(ctx.io, imp);
    throw new CliError(`Atlas could not read the bundle: ${imp.error?.message ?? imp.status} (${imp.error?.code ?? imp.status}).`);
  }
  if (imp.status === 'completed' && !options) {
    if (json) printJson(ctx.io, imp);
    else {
      ctx.io.out(`Import ${imp.id} is already complete.`);
      printResult(ctx, imp);
    }
    return 0;
  }
  if (!json) printReport(ctx, imp);

  if (args.values['dry-run']) {
    if (json) printJson(ctx.io, imp);
    else ctx.io.out(`Nothing was imported. Apply it with: atlas import --from better-auth --import ${imp.id}`);
    return 0;
  }
  const conflicts = imp.report?.conflicts_total ?? 0;
  if (conflicts > 0 && !args.values['confirm-conflicts']) {
    if (json) printJson(ctx.io, imp);
    throw new CliError(`The dry run found ${conflicts} conflict(s). Review them, then re-run with --import ${imp.id} --confirm-conflicts.`);
  }
  if (!args.values.yes && !json) {
    const answer = (await ctx.prompt.text(`Import into Atlas now? [y/N] `)).trim().toLowerCase();
    if (answer !== 'y' && answer !== 'yes') {
      ctx.io.out(`Not applied. Apply later with: atlas import --from better-auth --import ${imp.id}`);
      return 0;
    }
  }
  imp = await http.post<BetterAuthImport>(`/v1/better_auth_imports/${encodeURIComponent(imp.id)}/apply`, conflicts > 0 ? { confirm_conflicts: true } : {});
  imp = await poll(ctx, http, imp, json);
  if (json) printJson(ctx.io, imp);
  else printResult(ctx, imp);
  if (imp.status !== 'completed') {
    throw new CliError(`The import stopped (${imp.error?.message ?? imp.status}). Run the same command with --import ${imp.id} to resume.`);
  }
  const failed = imp.progress?.failed ?? 0;
  if (!json) ctx.io.out(`Done. Next: turn on the session bridge so signed-in users stay signed in, then switch your app's SDK to Atlas.`);
  return failed > 0 ? 2 : 0;
}
