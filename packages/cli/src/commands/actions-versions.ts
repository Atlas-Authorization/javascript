import { str, type ParsedArgs } from '../args';
import type { RunContext } from '../context';
import { CliError } from '../errors';
import { fmtTime, printJson, renderTable } from '../output';
import { httpFor } from '../project';
import { envApiUrl, requireArg, resolveAuth, wantsJson } from './shared';

interface Version {
  version: number;
  note: string | null;
  current: boolean;
  staged: boolean;
  created_by: string | null;
  created_at: number;
}

/**
 * Versions of an Action: `atlas actions versions <id>`, `release <id> <file> [--percent <1-99>] [--note ...]`
 * (live at once, or staged for that share of executions), `rollout <id> --percent <0-100>` (change the
 * share; 100 promotes, 0 aborts), `rollback <id> --to-version <n> --yes`.
 */
export async function actionVersions(ctx: RunContext, args: ParsedArgs): Promise<number> {
  const sub = args.positionals[1];
  const v = args.values;
  const json = wantsJson(v);
  const auth = resolveAuth(ctx, v);
  const http = httpFor(ctx, { secretKey: auth.secretKey, apiUrl: envApiUrl(ctx.env) ?? auth.apiUrl });
  const id = requireArg(args.positionals, 2, 'action-id');
  const base = `/v1/actions/${encodeURIComponent(id)}`;
  const percent = (): number => {
    const raw = str(v, 'percent');
    const n = raw === undefined ? NaN : Number(raw);
    if (!Number.isInteger(n) || n < 0 || n > 100) throw new CliError('--percent must be a whole number from 0 to 100.');
    return n;
  };

  if (sub === 'versions') {
    const res = await http.get<{ data: Version[]; current_version: number; rollout: { version: number; percent: number } | null }>(`${base}/versions`);
    if (json) printJson(ctx.io, res);
    else {
      ctx.io.out(
        renderTable(
          [
            { header: 'VERSION', get: (r: Version) => r.version },
            { header: 'STATE', get: (r: Version) => (r.staged ? `staged ${res.rollout?.percent ?? ''}%` : r.current ? 'live' : '') },
            { header: 'NOTE', get: (r: Version) => r.note ?? '' },
            { header: 'BY', get: (r: Version) => r.created_by ?? '' },
            { header: 'CREATED', get: (r: Version) => fmtTime(r.created_at) },
          ],
          res.data,
        ),
      );
    }
    return 0;
  }
  if (sub === 'release') {
    const file = requireArg(args.positionals, 3, 'file');
    const code = ctx.readFile(file);
    if (!code.trim()) throw new CliError(`'${file}' is empty: nothing to release.`);
    const body: Record<string, unknown> = { code, ...(str(v, 'note') ? { note: str(v, 'note') } : {}) };
    if (str(v, 'percent') !== undefined) body.rollout_percent = percent();
    const out = await http.post<{ version: number; staged: boolean }>(`${base}/versions`, body);
    if (json) printJson(ctx.io, out);
    else ctx.io.out(out.staged ? `Staged version ${out.version} for ${body.rollout_percent}% of executions. Move it with: atlas actions rollout ${id} --percent <n>.` : `Version ${out.version} is live.`);
    return 0;
  }
  if (sub === 'rollout') {
    const p = percent();
    const out = await http.patch<unknown>(`${base}/rollout`, { percent: p });
    if (json) printJson(ctx.io, out);
    else ctx.io.out(p === 100 ? 'Promoted: the staged version is now live.' : p === 0 ? 'Aborted: the staged version is discarded.' : `The staged version now runs for ${p}% of executions.`);
    return 0;
  }
  if (sub === 'rollback') {
    if (v.yes !== true) throw new CliError('actions rollback changes what runs in your sign-in flow; pass --yes to confirm.');
    const to = Number(str(v, 'to-version'));
    if (!Number.isInteger(to) || to < 1) throw new CliError('--to-version <n> is required (see: atlas actions versions <id>).');
    const out = await http.post<{ version: number }>(`${base}/rollback`, { version: to });
    if (json) printJson(ctx.io, out);
    else ctx.io.out(`Rolled back to version ${to}; it is live as version ${out.version}.`);
    return 0;
  }
  throw new CliError('Usage: atlas actions versions|release|rollout|rollback <action-id> ...');
}
