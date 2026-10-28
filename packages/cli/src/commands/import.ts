import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { str, type ParsedArgs } from '../args';
import type { RunContext } from '../context';
import { CliError } from '../errors';
import { printJson } from '../output';
import { httpFor } from '../project';
import { VENDORS, mapExport, parseExport, summarize, type ImportRow, type Vendor } from '../import/vendors';
import { resolveAuth, wantsJson } from './shared';
import { importBetterAuthBundle } from './import-better-auth';

/**
 * `atlas import --from <vendor> <file>` — move users from another auth provider.
 * (`--from better-auth --bundle <file>` imports a sealed exporter bundle: see
 * import-better-auth.ts.)
 *
 * Reads the vendor's own export, maps every record onto the Atlas bulk-import
 * shape client-side, and sends it in batches to `POST /v1/user_imports`.
 *
 *   --dry-run        map and summarise only; nothing is sent.
 *   --batch-size N   rows per request (1-100, default 100: each batch completes inline).
 *   --state-file F   where progress is kept (default `<file>.atlas-import.json`).
 *                    A re-run resumes after the last finished batch; batches are
 *                    sent with upsert, so re-sending one is safe.
 *   --hash-config F  JSON with the Firebase project hash parameters.
 *   --hashes F       a separate password-hash export merged by email (Auth0, WorkOS).
 *   --create-orgs    create organizations named by memberships that do not exist yet.
 */

interface JobResult {
  id: string;
  status: string;
  total: number;
  succeeded: number;
  failed: number;
}

interface ImportState {
  vendor: string;
  /** SHA-256 of the input, so a state file is never applied to a different export. */
  input_sha256: string;
  next_index: number;
  total: number;
  succeeded: number;
  failed: number;
  jobs: string[];
}

export async function importUsers(ctx: RunContext, args: ParsedArgs): Promise<number> {
  const vendor = str(args.values, 'from') as Vendor | undefined;
  if (!vendor || !(VENDORS as readonly string[]).includes(vendor)) {
    throw new CliError(`import needs --from <${VENDORS.join('|')}>.`);
  }
  // Better Auth: the sealed bundle from `npx atlas-better-auth-export` carries
  // every model (passwords, two-factor, passkeys, orgs, API keys, sessions…);
  // the table-JSON path below stays for exports made without it.
  if (vendor === 'better-auth' && (str(args.values, 'bundle') || str(args.values, 'import') || !args.positionals[1])) {
    return importBetterAuthBundle(ctx, args);
  }
  const file = args.positionals[1];
  if (!file) throw new CliError(`import needs the export file: atlas import --from ${vendor} <file>`);

  const text = ctx.readFile(file);
  let doc: unknown;
  let hashes: unknown;
  try {
    doc = parseExport(text, file);
    const hashesFile = str(args.values, 'hashes');
    if (hashesFile) hashes = parseExport(ctx.readFile(hashesFile), hashesFile);
  } catch (err) {
    throw new CliError(err instanceof Error ? err.message : String(err));
  }

  const { rows, warnings } = mapExport(vendor, doc, hashes);
  const json = wantsJson(args.values);
  const summary = summarize(rows);

  let hashConfig: Record<string, unknown> | undefined;
  const hashConfigFile = str(args.values, 'hash-config');
  if (hashConfigFile) {
    try {
      hashConfig = JSON.parse(ctx.readFile(hashConfigFile)) as Record<string, unknown>;
    } catch {
      throw new CliError(`--hash-config ${hashConfigFile} is not valid JSON.`);
    }
  }
  if (vendor === 'firebase' && (summary.with_password_hash ?? 0) > 0 && !hashConfig && !args.values['dry-run']) {
    throw new CliError(
      'Firebase password hashes need the project hash parameters. Copy them from the Firebase console (Authentication > Users > Password hash parameters) into a JSON file and pass --hash-config <file>.',
    );
  }

  if (args.values['dry-run']) {
    if (json) printJson(ctx.io, { vendor, summary, warnings, sample: rows.slice(0, 3).map(redact) });
    else {
      ctx.io.out(`Dry run: ${rows.length} user(s) mapped from ${vendor}. Nothing was sent.`);
      for (const [k, v] of Object.entries(summary)) ctx.io.out(`  ${k.replace(/_/g, ' ')}: ${v}`);
      for (const w of warnings) ctx.io.out(`  note: ${w}`);
    }
    return 0;
  }
  if (rows.length === 0) throw new CliError('The export contains no users with an email address.');

  const batchSize = Math.min(Math.max(Number(str(args.values, 'batch-size') ?? 100) || 100, 1), 100);
  const statePath = str(args.values, 'state-file') ?? `${file}.atlas-import.json`;
  const sha = createHash('sha256').update(text).digest('hex');
  let state: ImportState = { vendor, input_sha256: sha, next_index: 0, total: rows.length, succeeded: 0, failed: 0, jobs: [] };
  if (existsSync(statePath)) {
    const saved = JSON.parse(readFileSync(statePath, 'utf8')) as ImportState;
    if (saved.input_sha256 !== sha || saved.vendor !== vendor) {
      throw new CliError(`${statePath} belongs to a different export. Delete it or pass --state-file to start over.`);
    }
    state = saved;
    if (state.next_index >= rows.length) {
      ctx.io.out(`Already imported: ${state.succeeded} succeeded, ${state.failed} failed. Delete ${statePath} to run again.`);
      return 0;
    }
    ctx.io.err(`Resuming at user ${state.next_index + 1} of ${rows.length}.`);
  }

  const auth = resolveAuth(ctx, args.values);
  const http = httpFor(ctx, { secretKey: auth.secretKey, apiUrl: auth.apiUrl });
  for (const w of warnings) ctx.io.err(`note: ${w}`);

  while (state.next_index < rows.length) {
    const batch = rows.slice(state.next_index, state.next_index + batchSize);
    const body: Record<string, unknown> = { users: batch, upsert: true };
    if (args.values['create-orgs']) body.create_organizations = true;
    if (hashConfig) body.password_hash_config = { firebase: hashConfig };
    let job = await http.post<JobResult>('/v1/user_imports', body);
    // A batch over the inline limit is queued; poll it to completion.
    while (job.status === 'pending' || job.status === 'processing') {
      await (ctx.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))))(2000);
      job = await http.get<JobResult>(`/v1/jobs/${job.id}`);
    }
    state.next_index += batch.length;
    state.succeeded += job.succeeded;
    state.failed += job.failed;
    state.jobs.push(job.id);
    writeFileSync(statePath, JSON.stringify(state, null, 2));
    if (!json) ctx.io.err(`  ${state.next_index}/${rows.length} sent (job ${job.id}: ${job.succeeded} ok, ${job.failed} issues)`);
  }

  if (json) printJson(ctx.io, { ...state, summary, warnings });
  else {
    ctx.io.out(`Imported ${rows.length} user(s) from ${vendor}: ${state.succeeded} created or updated, ${state.failed} row issue(s).`);
    if (state.failed) ctx.io.out(`Per-row issues: GET /v1/jobs/<job-id>/errors for jobs ${state.jobs.join(', ')}`);
  }
  return state.failed > 0 ? 2 : 0;
}

/** A dry-run sample never prints a password hash. */
function redact(row: ImportRow): ImportRow {
  return row.password_hash ? { ...row, password_hash: '[redacted]', ...(row.password_salt ? { password_salt: '[redacted]' } : {}) } : row;
}
