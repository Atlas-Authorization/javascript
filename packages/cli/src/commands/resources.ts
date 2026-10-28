import { str, type ParsedArgs } from '../args';
import type { RunContext } from '../context';
import { CliError } from '../errors';
import { printJson, renderTable } from '../output';
import { httpFor } from '../project';
import { envApiUrl, resolveAuth, wantsJson } from './shared';

/**
 * Table-driven commands for admin resources whose whole surface is "call this Backend API route".
 * Each op is [method, path, flags]; `{}` in a path takes the next positional (URL-encoded).
 * A body comes from `--data '<json>'` or `--file <path>`; `y` ops change or remove something
 * and need `--yes`; `b` ops send a body.
 */
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export interface Op {
  m: Method;
  p: string;
  /** y: needs --yes. b: takes a body. q: forward --limit/--starting-after/--status as query. */
  f?: string;
  /** Turn the answer into the single line to print (and may refuse it). */
  out?: (res: Record<string, unknown>) => string;
}
export type Ops = Record<string, Op>;
export type Handler = (ctx: RunContext, args: ParsedArgs) => Promise<number>;

/** The columns a list shows, when the row has them. */
const COLS = ['id', 'name', 'key', 'provider', 'kind', 'status', 'enabled', 'created_at'];

function body(ctx: RunContext, args: ParsedArgs): Record<string, unknown> {
  const data = str(args.values, 'data');
  const file = str(args.values, 'file');
  if (data && file) throw new CliError('Pass --data or --file, not both.');
  const text = data ?? (file ? ctx.readFile(file) : undefined);
  if (text === undefined) return {};
  try {
    const v = JSON.parse(text) as unknown;
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object');
    return v as Record<string, unknown>;
  } catch (e) {
    throw new CliError(`The request body must be a JSON object (${(e as Error).message}).`);
  }
}

export function resourceCommand(name: string, ops: Ops): Handler {
  return async (ctx, args) => {
    const sub = args.positionals[1];
    const op = sub ? ops[sub] : undefined;
    if (!sub || !op) throw new CliError(`Usage: atlas ${name} ${Object.keys(ops).join('|')} (see 'atlas ${name} --help').`);
    const need = (op.p.match(/\{\}/g) ?? []).length;
    const ids = args.positionals.slice(2, 2 + need);
    if (ids.length < need) throw new CliError(`atlas ${name} ${sub} needs ${need} id argument${need === 1 ? '' : 's'}.`);
    const flags = op.f ?? '';
    if (flags.includes('y') && args.values.yes !== true) throw new CliError(`atlas ${name} ${sub} changes or removes data; pass --yes to confirm.`);
    let n = 0;
    let path = op.p.replace(/\{\}/g, () => encodeURIComponent(ids[n++]!));
    if (flags.includes('q')) {
      const q = new URLSearchParams();
      for (const k of ['limit', 'starting-after', 'status'] as const) {
        const v = str(args.values, k);
        if (v) q.set(k.replace('-', '_'), v);
      }
      if ([...q].length) path += `?${q}`;
    }
    const payload = flags.includes('b') ? body(ctx, args) : undefined;
    const auth = resolveAuth(ctx, args.values);
    const http = httpFor(ctx, { secretKey: auth.secretKey, apiUrl: envApiUrl(ctx.env) ?? auth.apiUrl });
    let res: unknown;
    if (op.m === 'DELETE') await http.delete(path);
    else res = await (op.m === 'GET' ? http.get(path) : op.m === 'POST' ? http.post(path, payload ?? {}) : op.m === 'PUT' ? http.put(path, payload ?? {}) : http.patch(path, payload ?? {}));
    if (op.out) {
      ctx.io.out(op.out((res ?? {}) as Record<string, unknown>));
      return 0;
    }
    if (res === undefined || res === null) {
      ctx.io.out('Done.');
      return 0;
    }
    const rows = (res as { data?: unknown }).data;
    if (wantsJson(args.values) || !Array.isArray(rows)) {
      printJson(ctx.io, res);
      return 0;
    }
    const cols = COLS.filter((c) => rows.some((r) => r && typeof r === 'object' && c in (r as object)));
    ctx.io.out(renderTable((cols.length ? cols : ['id']).map((c) => ({ header: c, get: (r: Record<string, unknown>) => r[c] })), rows as Record<string, unknown>[]));
    return 0;
  };
}

/** Print a launch URL only if it is https: a portal tile must never hand the user a javascript: or http: link. */
const launch = (r: Record<string, unknown>): string => {
  const u = r.launch_url;
  if (typeof u !== 'string' || !/^https:\/\//.test(u)) throw new CliError('This target has no https launch URL (assign it to yourself first).');
  return u;
};

export const WORKFLOWS: Ops = {
  list: { m: 'GET', p: '/v1/workflows', f: 'q' },
  get: { m: 'GET', p: '/v1/workflows/{}' },
  triggers: { m: 'GET', p: '/v1/workflow_triggers' },
  templates: { m: 'GET', p: '/v1/workflow_templates' },
  'from-template': { m: 'POST', p: '/v1/workflows/from_template', f: 'b' },
  run: { m: 'POST', p: '/v1/workflows/{}/invoke', f: 'b' },
  invoke: { m: 'POST', p: '/v1/workflows/{}/invoke', f: 'b' },
  status: { m: 'GET', p: '/v1/workflows/{}/runs/{}' },
  resume: { m: 'POST', p: '/v1/workflows/{}/runs/{}/resume', f: 'b' },
  approvals: { m: 'GET', p: '/v1/workflow_approvals', f: 'q' },
  decide: { m: 'POST', p: '/v1/workflow_approvals/{}/decide', f: 'by' },
};
export const CHAT: Ops = {
  list: { m: 'GET', p: '/v1/chat_integrations' },
  get: { m: 'GET', p: '/v1/chat_integrations/{}' },
  test: { m: 'POST', p: '/v1/chat_integrations/{}/test' },
  links: { m: 'GET', p: '/v1/chat_integrations/{}/user_links' },
  interactions: { m: 'GET', p: '/v1/chat_integrations/{}/interactions', f: 'q' },
};
export const CLOUD: Ops = {
  targets: { m: 'GET', p: '/v1/cloud_access/targets' },
  setup: { m: 'GET', p: '/v1/cloud_access/targets/{}/setup' },
  login: { m: 'GET', p: '/v1/cloud_access/targets/{}', out: launch },
};
export const SAML_IDP: Ops = {
  'import-metadata': { m: 'POST', p: '/v1/saml_idp/service_providers/import_metadata', f: 'by' },
};
export const PROVISIONING: Ops = {
  connectors: { m: 'GET', p: '/v1/provisioning_connectors' },
  preview: { m: 'POST', p: '/v1/provisioning/preview', f: 'b' },
  logs: { m: 'GET', p: '/v1/scim_provisioning_targets/{}/logs', f: 'q' },
  failures: { m: 'GET', p: '/v1/scim_provisioning_targets/{}/failures', f: 'q' },
  retry: { m: 'POST', p: '/v1/scim_provisioning_targets/{}/retry_failed', f: 'y' },
};
export const CATALOG: Ops = {
  requests: { m: 'GET', p: '/v1/app_catalog/requests', f: 'q' },
  request: { m: 'POST', p: '/v1/app_catalog/requests', f: 'b' },
  vote: { m: 'POST', p: '/v1/app_catalog/requests/{}/vote' },
  'set-request': { m: 'PATCH', p: '/v1/app_catalog/requests/{}', f: 'by' },
  'remove-request': { m: 'DELETE', p: '/v1/app_catalog/requests/{}', f: 'y' },
};
export const DEVICE_SSO: Ops = {
  list: { m: 'GET', p: '/v1/device_sso/registrations', f: 'q' },
  show: { m: 'GET', p: '/v1/device_sso/registrations/{}' },
  revoke: { m: 'POST', p: '/v1/device_sso/registrations/{}/revoke', f: 'y' },
  delete: { m: 'DELETE', p: '/v1/device_sso/registrations/{}', f: 'y' },
};
export const GATEWAYS: Ops = {
  gateways: { m: 'GET', p: '/v1/mcp_gateways' },
  upstreams: { m: 'GET', p: '/v1/mcp_gateways/{}/upstreams' },
  'upstream-add': { m: 'POST', p: '/v1/mcp_gateways/{}/upstreams', f: 'b' },
  'upstream-test': { m: 'POST', p: '/v1/mcp_gateways/{}/upstreams/{}/test' },
  'upstream-remove': { m: 'DELETE', p: '/v1/mcp_gateways/{}/upstreams/{}', f: 'y' },
  packs: { m: 'GET', p: '/v1/mcp_gateways/{}/packs' },
  'pack-add': { m: 'POST', p: '/v1/mcp_gateways/{}/packs', f: 'b' },
  'pack-remove': { m: 'DELETE', p: '/v1/mcp_gateways/{}/packs/{}', f: 'y' },
  pins: { m: 'GET', p: '/v1/mcp_gateways/{}/pins' },
  'pin-approve': { m: 'POST', p: '/v1/mcp_gateways/{}/pins/{}/approve', f: 'y' },
  'pin-remove': { m: 'DELETE', p: '/v1/mcp_gateways/{}/pins/{}', f: 'y' },
  registry: { m: 'GET', p: '/v1/mcp_registry' },
  'registry-add': { m: 'POST', p: '/v1/mcp_registry', f: 'b' },
  'registry-decide': { m: 'POST', p: '/v1/mcp_registry/{}/decide', f: 'by' },
  'registry-remove': { m: 'DELETE', p: '/v1/mcp_registry/{}', f: 'y' },
};
export const CONNECTION_ACTIONS: Ops = {
  catalog: { m: 'GET', p: '/v1/connection_actions' },
  list: { m: 'GET', p: '/v1/connections/{}/actions' },
  run: { m: 'POST', p: '/v1/connections/{}/actions/{}', f: 'b' },
  define: { m: 'PUT', p: '/v1/connection_actions/{}/{}', f: 'b' },
  remove: { m: 'DELETE', p: '/v1/connection_actions/{}/{}', f: 'y' },
};
export const TRIGGERS: Ops = {
  list: { m: 'GET', p: '/v1/connections/{}/triggers' },
  get: { m: 'GET', p: '/v1/connections/{}/triggers/{}' },
  create: { m: 'POST', p: '/v1/connections/{}/triggers', f: 'b' },
  set: { m: 'PATCH', p: '/v1/connections/{}/triggers/{}', f: 'b' },
  delete: { m: 'DELETE', p: '/v1/connections/{}/triggers/{}', f: 'y' },
};
export const AGENTS: Ops = {
  list: { m: 'GET', p: '/v1/agents', f: 'q' },
  get: { m: 'GET', p: '/v1/agents/{}' },
  lifecycle: { m: 'GET', p: '/v1/agents/{}/lifecycle' },
  'set-lifecycle': { m: 'PUT', p: '/v1/agents/{}/lifecycle', f: 'by' },
  renew: { m: 'POST', p: '/v1/agents/{}/renew', f: 'b' },
  activity: { m: 'GET', p: '/v1/agents/{}/activity', f: 'q' },
  requests: { m: 'GET', p: '/v1/agent_access_requests', f: 'q' },
  reviews: { m: 'GET', p: '/v1/agent_access_reviews', f: 'q' },
  review: { m: 'GET', p: '/v1/agent_access_reviews/{}' },
  'review-start': { m: 'POST', p: '/v1/agent_access_reviews', f: 'b' },
  'review-decide': { m: 'POST', p: '/v1/agent_access_reviews/{}/items/{}/decide', f: 'by' },
  'review-close': { m: 'POST', p: '/v1/agent_access_reviews/{}/close', f: 'y' },
};
export const TELEMETRY: Ops = {
  show: { m: 'GET', p: '/v1/telemetry_export' },
  set: { m: 'PUT', p: '/v1/telemetry_export', f: 'by' },
  test: { m: 'POST', p: '/v1/telemetry_export/test' },
};
export const PDP: Ops = {
  list: { m: 'GET', p: '/v1/authz_pdps' },
  remove: { m: 'DELETE', p: '/v1/authz_pdps/{}', f: 'y' },
};
export const BILLING: Ops = {
  coupons: { m: 'GET', p: '/v1/billing/coupons', f: 'q' },
  'coupon-add': { m: 'POST', p: '/v1/billing/coupons', f: 'by' },
  'coupon-set': { m: 'PATCH', p: '/v1/billing/coupons/{}', f: 'by' },
  'coupon-validate': { m: 'POST', p: '/v1/billing/coupons/validate', f: 'b' },
  credits: { m: 'GET', p: '/v1/billing/credits', f: 'q' },
  'credit-grant': { m: 'POST', p: '/v1/billing/credits', f: 'by' },
};
export const AUDIT: Ops = {
  retention: { m: 'GET', p: '/v1/audit_retention' },
  'set-retention': { m: 'PUT', p: '/v1/audit_retention', f: 'by' },
};
export const FEDERATION: Ops = {
  show: { m: 'GET', p: '/v1/federation' },
  resolve: { m: 'POST', p: '/v1/federation/resolve', f: 'b' },
};
export const VC: Ops = {
  deferred: { m: 'GET', p: '/v1/vc/deferred', f: 'q' },
  approve: { m: 'POST', p: '/v1/vc/deferred/{}/approve', f: 'by' },
  deny: { m: 'POST', p: '/v1/vc/deferred/{}/deny', f: 'by' },
};
/** `atlas keys data ...` and `atlas keys op ...` (customer-managed data key, OP signing keys). */
export const KEYS_DATA: Ops = {
  status: { m: 'GET', p: '/v1/instance/data_key_provider' },
  enable: { m: 'POST', p: '/v1/instance/data_key_provider', f: 'by' },
  rotate: { m: 'POST', p: '/v1/instance/data_key_provider/rotate', f: 'y' },
  rewrap: { m: 'POST', p: '/v1/instance/data_key_provider/rewrap', f: 'y' },
  check: { m: 'POST', p: '/v1/instance/data_key_provider/check' },
};
export const KEYS_OP: Ops = {
  list: { m: 'GET', p: '/v1/instance/op_keys' },
  rotate: { m: 'POST', p: '/v1/instance/op_keys/rotate', f: 'by' },
};
export const FGA_STORE: Ops = {
  export: { m: 'GET', p: '/v1/fga/stores/{}/export', f: 'q' },
  import: { m: 'POST', p: '/v1/fga/stores/{}/import', f: 'b' },
  materializations: { m: 'GET', p: '/v1/fga/stores/{}/materializations' },
  materialize: { m: 'POST', p: '/v1/fga/stores/{}/materializations', f: 'by' },
  rebuild: { m: 'POST', p: '/v1/fga/stores/{}/materializations/{}/rebuild', f: 'y' },
  unmaterialize: { m: 'DELETE', p: '/v1/fga/stores/{}/materializations/{}', f: 'y' },
};

/** The same handler seen from one positional deeper: `atlas keys data status` → sub `status`. */
export const shift = (args: ParsedArgs): ParsedArgs => ({ ...args, positionals: [args.positionals[0]!, ...args.positionals.slice(2)] });
