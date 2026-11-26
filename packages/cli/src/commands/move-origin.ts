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

  const clone = str(v, 'clone-resource-server');
  const cloneParts = clone === undefined ? undefined : clone.split('=');
  if (cloneParts && (cloneParts.length !== 2 || !cloneParts[0] || !cloneParts[1] || cloneParts[0] === cloneParts[1])) {
    throw new CliError('--clone-resource-server needs <old identifier>=<new identifier>, for example https://old.example.com/mcp=https://new.example.com/mcp.');
  }
  const issuerBefore = (await http.get<{ issuer?: string | null }>('/v1/instance').catch(() => ({}) as { issuer?: string | null })).issuer ?? null;
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


  // The server re-syncs the managed integrations' receivers as part of the move (and sends issuer.changed to partners when the issuer moves).
  let cloned: { from: string; to: string; ok: boolean; error: string | null } | undefined;
  if (cloneParts) {
    const [oldId, newId] = cloneParts as [string, string];
    try {
      const rows = (await http.get<{ data?: Array<Record<string, unknown>> }>('/v1/resource_servers')).data ?? [];
      const src = rows.find((r) => r.identifier === oldId);
      if (!src) throw new Error(`no resource server with identifier ${oldId}`);
      const body: Record<string, unknown> = { identifier: newId };
      for (const k of ['name', 'scopes', 'token_ttl_seconds', 'scope_presets', 'publish_resource_metadata', 'access_token_format', 'refresh_token_absolute_ttl_seconds', 'refresh_token_idle_ttl_seconds', 'introspection_client_ids']) {
        if (src[k] !== undefined && src[k] !== null) body[k] = src[k];
      }
      await http.post('/v1/resource_servers', body);
      cloned = { from: oldId, to: newId, ok: true, error: null };
    } catch (err) {
      cloned = { from: oldId, to: newId, ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
  const issuerAfter = (await http.get<{ issuer?: string | null }>('/v1/instance').catch(() => ({}) as { issuer?: string | null })).issuer ?? null;
  const health = await http.get<{ summary?: { failing?: number } }>('/v1/instance/integrations/health').catch(() => undefined);
  const failing = health?.summary?.failing ?? 0;

  if (json) {
    printJson(ctx.io, { ...done, webhook_tests: tests, ...(cloned ? { resource_server_clone: cloned } : {}), issuer: { before: issuerBefore, after: issuerAfter }, integration_health_failing: failing });
  } else {
    ctx.io.out(`Moved ${done.changes.length} field(s) from ${done.from} to ${done.to}.`);
    for (const t of tests) {
      ctx.io.out(`webhook ${t.endpoint}: ${t.ok ? `test delivery answered ${t.http_status}` : `test delivery did not get a 2xx${t.http_status ? ` (${t.http_status})` : ''}${t.error ? `: ${t.error}` : ''}`}`);
    }
    if (cloned) ctx.io.out(cloned.ok ? `resource server ${cloned.from} cloned to ${cloned.to}; delete the old one once nothing uses it.` : `resource server clone failed: ${cloned.error}`);
    if (issuerBefore && issuerAfter && issuerBefore !== issuerAfter) ctx.io.out(`issuer: ${issuerBefore} -> ${issuerAfter}`);
    ctx.io.out(failing ? `integration health: ${failing} check(s) failing (atlas integrations health).` : 'integration health: green.');
    ctx.io.out("Next: update your app's own config (env vars, DNS, deploy) to the new origin, then run 'atlas preflight'.");
  }
  return tests.some((t) => !t.ok) || cloned?.ok === false || failing > 0 ? 1 : 0;
}
