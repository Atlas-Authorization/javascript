import type { ParsedArgs } from '../args';
import { str } from '../args';
import type { RunContext } from '../context';
import { CliError } from '../errors';
import { printJson, renderTable, type Column } from '../output';
import { httpFor } from '../project';
import { resolveAuth, wantsJson } from './shared';

interface OriginChange {
  object: string;
  id: string;
  field: string;
  before: unknown;
  after: unknown;
}

interface OriginProblem {
  object: string;
  id: string;
  field: string;
  url: string;
  message: string;
}

interface OriginMove {
  object: 'origin_move';
  from: string;
  to: string;
  dry_run: boolean;
  applied: boolean;
  changes: OriginChange[];
  problems: OriginProblem[];
}

const COLUMNS: Column<OriginChange>[] = [
  { header: 'OBJECT', get: (c) => `${c.object} ${c.id}` },
  { header: 'FIELD', get: (c) => c.field },
  { header: 'BEFORE', get: (c) => c.before },
  { header: 'AFTER', get: (c) => c.after },
];

/**
 * `atlas move-origin --from <origin> --to <origin> [--dry-run] [--yes]`: move an
 * app to a new domain in one step. The server rewrites every origin-bearing
 * field (allowed origins, OAuth client redirect/logout URIs, webhook URLs,
 * redirect allowlist, branding links, Sign in with Atlas apps). The CLI always
 * shows the diff first, asks before writing (skip with --yes), and after a real
 * move sends a signed test delivery to each webhook endpoint that moved.
 */
export async function moveOrigin(ctx: RunContext, args: ParsedArgs): Promise<number> {
  const v = args.values;
  const from = str(v, 'from');
  const to = str(v, 'to');
  if (!from || !to) throw new CliError('move-origin needs --from <origin> and --to <origin>, e.g. --from https://old.example --to https://new.example.');
  const json = wantsJson(v);
  const auth = resolveAuth(ctx, v);
  const http = httpFor(ctx, { secretKey: auth.secretKey, apiUrl: auth.apiUrl });
  const path = '/v1/instance/move_origin';

  const plan = await http.post<OriginMove>(path, { from, to, dry_run: true });

  if (!json) {
    if (plan.changes.length === 0) ctx.io.out(`Nothing on ${plan.from} to move: no field of this instance uses that origin.`);
    else {
      ctx.io.out(`${plan.from} → ${plan.to}: ${plan.changes.length} field(s) would change.`);
      ctx.io.out(renderTable(COLUMNS, plan.changes));
    }
    for (const p of plan.problems) ctx.io.out(`problem: ${p.object} ${p.id} ${p.field}: ${p.message} (${p.url})`);
  }

  if (v['dry-run'] === true) {
    if (json) printJson(ctx.io, plan);
    else ctx.io.out('Dry run: nothing was written.');
    return plan.problems.length > 0 ? 1 : 0;
  }
  if (plan.problems.length > 0) {
    if (json) printJson(ctx.io, plan);
    throw new CliError(`${plan.problems.length} rewritten value(s) would be refused (see above); fix them and run again. Nothing was written.`);
  }
  if (plan.changes.length === 0) {
    if (json) printJson(ctx.io, plan);
    return 0;
  }

  if (v.yes !== true) {
    if (json) throw new CliError('Pass --yes to apply a move with --json (the confirmation prompt is interactive).');
    const answer = (await ctx.prompt.text('Apply these changes? [y/N]', { default: 'n' })).trim().toLowerCase();
    if (answer !== 'y' && answer !== 'yes') {
      ctx.io.out('Cancelled: nothing was written.');
      return 1;
    }
  }

  const done = await http.post<OriginMove>(path, { from, to });
  const hooks = [...new Set(done.changes.filter((c) => c.object === 'webhook_endpoint').map((c) => c.id))];
  const tests: Array<{ endpoint: string; ok: boolean; http_status: number | null; error: string | null }> = [];
  for (const id of hooks) {
    try {
      const res = await http.post<{ status?: string; http_status?: number | null; error?: string | null }>(
        `/v1/webhook_endpoints/${encodeURIComponent(id)}/test?wait=10s`,
        {},
      );
      const status = res.http_status ?? null;
      tests.push({ endpoint: id, ok: status !== null && status >= 200 && status < 300, http_status: status, error: res.error ?? null });
    } catch (err) {
      tests.push({ endpoint: id, ok: false, http_status: null, error: err instanceof Error ? err.message : String(err) });
    }
  }

  if (json) {
    printJson(ctx.io, { ...done, webhook_tests: tests });
  } else {
    ctx.io.out(`Moved ${done.changes.length} field(s) from ${done.from} to ${done.to}.`);
    for (const t of tests) {
      ctx.io.out(`webhook ${t.endpoint}: ${t.ok ? `test delivery answered ${t.http_status}` : `test delivery did not get a 2xx${t.http_status ? ` (${t.http_status})` : ''}${t.error ? `: ${t.error}` : ''}`}`);
    }
    ctx.io.out("Next: update your app's own config (env vars, DNS, deploy) to the new origin, then run 'atlas preflight'.");
  }
  return tests.some((t) => !t.ok) ? 1 : 0;
}
