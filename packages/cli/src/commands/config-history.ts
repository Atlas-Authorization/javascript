import type { ParsedArgs } from '../args';
import { limit, str } from '../args';
import type { RunContext } from '../context';
import { CliError } from '../errors';
import { printJson, renderTable, type Column } from '../output';
import { httpFor } from '../project';
import { resolveAuth, wantsJson } from './shared';

interface Snapshot {
  id: string;
  version: number;
  label: string | null;
  source: string;
  created_at: number;
  redacted_paths: string[];
}
interface Change {
  path: string;
  before: unknown;
  after: unknown;
}
interface Diff {
  from: string;
  to: string;
  changes: Change[];
  allowed_origins: { before: string[]; after: string[] } | null;
  unchanged: boolean;
}
interface Restore {
  snapshot_id: string;
  version: number;
  dry_run: boolean;
  applied: boolean;
  current_sha256: string;
  changes: Change[];
  allowed_origins_changed: boolean;
}

const SNAPSHOT_COLUMNS: Column<Snapshot>[] = [
  { header: 'ID', get: (s) => s.id },
  { header: 'VERSION', get: (s) => String(s.version) },
  { header: 'SOURCE', get: (s) => s.source },
  { header: 'LABEL', get: (s) => s.label ?? '' },
  { header: 'SAVED', get: (s) => new Date(s.created_at).toISOString() },
];

const show = (v: unknown) => (v === null || v === undefined ? '(unset)' : typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v));

function printChanges(ctx: RunContext, changes: Change[]): void {
  for (const c of changes) ctx.io.out(`  ${c.path}: ${show(c.before)} -> ${show(c.after)}`);
}

/**
 * Config time travel: `atlas config snapshot|snapshots|diff|restore`.
 *
 *   atlas config snapshot [--label <text>]            save the configuration as it is now
 *   atlas config snapshots [--limit n]                list the saved copies
 *   atlas config diff <from> [to]                     what changed (an id, or "current" for the live configuration)
 *   atlas config restore <id> [--dry-run] [--yes]     put one back; the replaced state is saved first
 */
export async function configHistory(ctx: RunContext, args: ParsedArgs): Promise<number> {
  const sub = args.positionals[1];
  const v = args.values;
  const json = wantsJson(v);
  const auth = resolveAuth(ctx, v);
  const http = httpFor(ctx, { secretKey: auth.secretKey, apiUrl: auth.apiUrl });

  if (sub === 'snapshot') {
    const label = str(v, 'label');
    const snap = await http.post<Snapshot>('/v1/instance/config_snapshots', label ? { label } : {});
    if (json) printJson(ctx.io, snap);
    else ctx.io.out(`Saved version ${snap.version} (${snap.id}).`);
    return 0;
  }

  if (sub === 'snapshots') {
    const n = limit(v);
    const page = await http.get<{ data: Snapshot[] }>(`/v1/instance/config_snapshots${n ? `?limit=${n}` : ''}`);
    if (json) printJson(ctx.io, page);
    else ctx.io.out(page.data.length ? renderTable(SNAPSHOT_COLUMNS, page.data) : 'No snapshots yet. Save one with: atlas config snapshot --label "before launch"');
    return 0;
  }

  if (sub === 'diff') {
    const from = args.positionals[2];
    if (!from) throw new CliError('config diff needs a snapshot id (or "current"): atlas config diff <from> [to].');
    const to = args.positionals[3] ?? 'current';
    const diff = await http.get<Diff>(`/v1/instance/config_snapshots/diff?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
    if (json) printJson(ctx.io, diff);
    else if (diff.unchanged) ctx.io.out(`${diff.from} and ${diff.to} are identical.`);
    else {
      ctx.io.out(`${diff.from} -> ${diff.to}`);
      printChanges(ctx, diff.changes);
      if (diff.allowed_origins) ctx.io.out(`  allowed_origins: ${show(diff.allowed_origins.before)} -> ${show(diff.allowed_origins.after)}`);
    }
    return 0;
  }

  if (sub === 'restore') {
    const id = args.positionals[2];
    if (!id) throw new CliError('config restore needs a snapshot id: atlas config restore <id> [--dry-run] [--yes].');
    const preview = await http.post<Restore>(`/v1/instance/config_snapshots/${encodeURIComponent(id)}/restore`, { dry_run: true });
    if (json && v['dry-run'] === true) {
      printJson(ctx.io, preview);
      return 0;
    }
    if (!json) {
      ctx.io.out(`Restoring version ${preview.version} would change ${preview.changes.length} setting(s):`);
      printChanges(ctx, preview.changes);
    }
    if (v['dry-run'] === true) return 0;
    if (preview.changes.length === 0) {
      ctx.io.out('Nothing to restore: the configuration already matches.');
      return 0;
    }
    if (v.yes !== true) {
      if (json) throw new CliError('Pass --yes to restore with --json (the confirmation prompt is interactive).');
      const answer = (await ctx.prompt.text('Restore this configuration? The current one is saved first. [y/N]', { default: 'n' })).trim().toLowerCase();
      if (answer !== 'y' && answer !== 'yes') {
        ctx.io.out('Cancelled: nothing was written.');
        return 1;
      }
    }
    // Apply exactly what was previewed: the server refuses (409) if the configuration moved in between.
    const done = await http.post<Restore>(`/v1/instance/config_snapshots/${encodeURIComponent(id)}/restore`, { expected_sha256: preview.current_sha256 });
    if (json) printJson(ctx.io, done);
    else ctx.io.out(`Restored version ${done.version}. The previous configuration was saved as a snapshot.`);
    return 0;
  }

  throw new CliError(sub ? `Unknown subcommand 'config ${sub}'.` : 'config needs a subcommand.');
}
