import { DEFAULT_API_URL } from '@atlasauth/backend';
import { limit, list, str, type ParsedArgs } from '../args';
import type { RunContext } from '../context';
import { CliError } from '../errors';
import { printJson, renderTable, type Column } from '../output';
import { httpFor } from '../project';
import { envApiUrl, wantsJson } from './shared';

interface Clone {
  id: string;
  kind: 'clone' | 'preview';
  name: string;
  ref: string | null;
  status: string;
  instance_id: string | null;
  publishable_key: string | null;
  frontend_api_host: string | null;
  expires_at: number | null;
  counts: Record<string, unknown>;
  secret?: string | null;
  note?: string;
}

const COLUMNS: Column<Clone>[] = [
  { header: 'ID', get: (c) => c.id },
  { header: 'KIND', get: (c) => c.kind },
  { header: 'NAME', get: (c) => c.name },
  { header: 'REF', get: (c) => c.ref ?? '' },
  { header: 'STATUS', get: (c) => c.status },
  { header: 'INSTANCE', get: (c) => c.instance_id ?? '' },
  { header: 'EXPIRES', get: (c) => (c.expires_at ? new Date(c.expires_at).toISOString() : '') },
];

const isPlatformKey = (key: string | undefined): key is string => Boolean(key && (key.startsWith('psk_') || /^atlas_(live|test)_psk_/.test(key)));

/** The platform key (creating an instance is provisioning, not an instance-key act) and API URL. */
function platformAuth(ctx: RunContext, args: ParsedArgs): { secretKey: string; apiUrl: string } {
  const file = ctx.config.load();
  const profile = str(args.values, 'profile') || file.active_profile || 'default';
  const stored = file.profiles[profile];
  const key = [ctx.env.ATLAS_PLATFORM_KEY?.trim(), ctx.env.ATLAS_SECRET_KEY?.trim(), stored?.secret_key].find(isPlatformKey);
  if (!key) throw new CliError("preview needs a platform key with platform:apps:write. Set ATLAS_PLATFORM_KEY, or store one with 'atlas login --secret-key psk_...'.");
  return { secretKey: key, apiUrl: envApiUrl(ctx.env) || stored?.api_url || DEFAULT_API_URL };
}

/**
 * Environment clones and per-PR preview instances (needs a platform key).
 *
 *   atlas preview create --app <app id> --instance <source instance id> --ref pr-42 [--origin <url>] [--ttl-hours 72]
 *                        [--include config,roles,users,organizations,memberships] [--unmask-emails] [--refresh]
 *   atlas preview clone  --app <id> --instance <source> --name staging [--include ...] [--origin <url>]
 *   atlas preview list   --app <id> --instance <source> [--kind preview|clone]
 *   atlas preview delete <clone id> --app <id> --instance <source>
 *
 * A new environment's secret key is printed once (or with --json); it is never stored.
 */
export async function preview(ctx: RunContext, args: ParsedArgs): Promise<number> {
  const sub = args.positionals[1];
  const v = args.values;
  const json = wantsJson(v);
  if (sub !== 'create' && sub !== 'clone' && sub !== 'list' && sub !== 'delete') {
    throw new CliError(sub ? `Unknown subcommand 'preview ${sub}'. Try: create, clone, list, delete.` : 'preview needs a subcommand: create, clone, list, delete.');
  }
  const app = str(v, 'app');
  const instance = str(v, 'instance');
  if (!app || !instance) throw new CliError('preview needs --app <app id> and --instance <source instance id>.');
  const http = httpFor(ctx, platformAuth(ctx, args));
  const base = `/v1/platform/apps/${encodeURIComponent(app)}/instances/${encodeURIComponent(instance)}/clones`;

  if (sub === 'list') {
    const n = limit(v);
    const qs = [n ? `limit=${n}` : '', str(v, 'kind') ? `kind=${encodeURIComponent(str(v, 'kind')!)}` : ''].filter(Boolean).join('&');
    const page = await http.get<{ data: Clone[] }>(`${base}${qs ? `?${qs}` : ''}`);
    if (json) printJson(ctx.io, page);
    else ctx.io.out(page.data.length ? renderTable(COLUMNS, page.data) : 'No clones or previews.');
    return 0;
  }

  if (sub === 'delete') {
    const id = args.positionals[2];
    if (!id) throw new CliError('preview delete needs a clone id: atlas preview delete <id> --app <id> --instance <id>.');
    await http.delete(`${base}/${encodeURIComponent(id)}`);
    ctx.io.out(`Deleted ${id} and its instance.`);
    return 0;
  }

  const body: Record<string, unknown> = { mode: sub === 'create' ? 'preview' : 'clone' };
  if (sub === 'create') {
    const ref = str(v, 'ref');
    if (!ref) throw new CliError('preview create needs --ref <pull request number or branch>.');
    body.ref = ref;
    const ttl = str(v, 'ttl-hours');
    if (ttl !== undefined) {
      const n = Number(ttl);
      if (!Number.isInteger(n) || n < 1) throw new CliError(`--ttl-hours must be a positive integer, got '${ttl}'.`);
      body.ttl_hours = n;
    }
  } else {
    const name = str(v, 'name');
    if (!name) throw new CliError('preview clone needs --name <environment name>.');
    body.name = name;
    if (str(v, 'ref')) body.ref = str(v, 'ref');
  }
  const include = list(v, 'include');
  if (include.length) body.include = include;
  const origin = str(v, 'origin');
  if (origin) body.allowed_origins = [origin];
  if (v['unmask-emails'] === true) body.mask_emails = false;
  if (v.refresh === true) body.refresh = true;

  const out = await http.post<Clone>(base, body);
  if (json) {
    printJson(ctx.io, out);
    return 0;
  }
  ctx.io.out(`${out.kind === 'preview' ? 'Preview' : 'Clone'} ${out.id}: ${out.name} (${out.status})`);
  if (out.instance_id) ctx.io.out(`  instance:        ${out.instance_id}`);
  if (out.publishable_key) ctx.io.out(`  publishable key: ${out.publishable_key}`);
  if (out.frontend_api_host) ctx.io.out(`  frontend host:   ${out.frontend_api_host}`);
  if (out.expires_at) ctx.io.out(`  expires:         ${new Date(out.expires_at).toISOString()}`);
  if (out.secret) ctx.io.out(`  secret key:      ${out.secret}   (shown once; copy it now)`);
  else ctx.io.out('  (already existed: unchanged, no secret shown)');
  return 0;
}
