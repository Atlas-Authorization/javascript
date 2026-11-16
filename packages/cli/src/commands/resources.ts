import { str, type ParsedArgs, type Values } from '../args';
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
  /** Flags forwarded as query parameters (kebab-case flag -> snake_case parameter). */
  query?: readonly string[];
  /** Body fields this op always sends (the verb is the decision, e.g. approve). */
  fixed?: Record<string, unknown>;
  /** Flags that fill body fields (kebab-case flag -> snake_case field), so the body needs no JSON. */
  bodyFlags?: readonly string[];
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
        const v = str(args.values, k as keyof Values);
        if (v) q.set(k.replace('-', '_'), v);
      }
      if ([...q].length) path += `?${q}`;
    }
    if (op.query) {
      const q = new URLSearchParams(path.includes('?') ? path.slice(path.indexOf('?') + 1) : '');
      for (const k of op.query) {
        const v = str(args.values, k as keyof Values);
        if (v) q.set(k.replace(/-/g, '_'), v);
      }
      if (op.query.includes('live') && args.values.live === true) q.set('live', 'true');
      path = path.split('?')[0]! + ([...q].length ? `?${q}` : '');
    }
    let payload = flags.includes('b') ? body(ctx, args) : undefined;
    if (payload && op.bodyFlags) {
      for (const k of op.bodyFlags) {
        const v = str(args.values, k as keyof Values);
        if (v !== undefined && v !== '') payload[k.replace(/-/g, '_')] = v;
      }
    }
    if (op.fixed) payload = { ...(payload ?? {}), ...op.fixed };
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

/** `atlas compliance ...`: posture and signed reports, the data rights board, downstream erasure, cookie consent counts, translation review and its CI check. */
const checkOut = (res: Record<string, unknown>): string => {
  if (res.ok === true) return `ok: ${String(res.checked)} translation${res.checked === 1 ? '' : 's'} checked.`;
  const lines = ((res.results as Array<{ index: number; ok: boolean; problems: Array<{ code: string; message: string }> }>) ?? [])
    .filter((r) => !r.ok)
    .flatMap((r) => r.problems.map((p) => `item ${r.index}: ${p.code}: ${p.message}`));
  throw new CliError(`${String(res.failed)} of ${String(res.checked)} translations failed:\n${lines.join('\n')}`);
};
export const COMPLIANCE: Ops = {
  posture: { m: 'GET', p: '/v1/compliance/posture' },
  ropa: { m: 'GET', p: '/v1/compliance/ropa' },
  reports: { m: 'GET', p: '/v1/compliance/reports', f: 'q', query: ['kind'] },
  report: { m: 'GET', p: '/v1/compliance/reports/{}' },
  sign: { m: 'POST', p: '/v1/compliance/reports', f: 'b', bodyFlags: ['kind'] },
  'inactive-preview': { m: 'GET', p: '/v1/compliance/inactive_users/preview', query: ['limit'] },
  board: { m: 'GET', p: '/v1/dsr_console/summary' },
  requests: { m: 'GET', p: '/v1/dsr_console/requests', f: 'q', query: ['type', 'assignee', 'priority', 'label', 'overdue', 'unassigned', 'due-within-days'] },
  triage: { m: 'PATCH', p: '/v1/data_subject_requests/{}/triage', f: 'b', bodyFlags: ['assignee', 'priority'] },
  note: { m: 'POST', p: '/v1/data_subject_requests/{}/notes', f: 'b', bodyFlags: ['body'] },
  downstream: { m: 'GET', p: '/v1/data_subject_requests/{}/downstream' },
  'downstream-done': { m: 'POST', p: '/v1/data_subject_requests/{}/downstream/{}', f: 'b', bodyFlags: ['status', 'note'] },
  'erasure-catalog': { m: 'GET', p: '/v1/erasure_connector_catalog' },
  'cookie-summary': { m: 'GET', p: '/v1/cookie_consents/summary' },
  'i18n-summary': { m: 'GET', p: '/v1/localizations/review_summary' },
  'i18n-review': { m: 'POST', p: '/v1/localizations/{}/review', f: 'b', bodyFlags: ['action', 'note'] },
  // CI: `--file translations.json` holds { items: [...], require_approved?: true }; a failing check exits 1 with the problems.
  'i18n-check': { m: 'POST', p: '/v1/localizations/check', f: 'b', out: checkOut },
  'downstream-run': { m: 'POST', p: '/v1/data_subject_requests/{}/downstream/{}/run', f: 'y' },
  'erasure-probe': { m: 'POST', p: '/v1/erasure_connectors/{}/probe' },
  'cookie-consents': { m: 'GET', p: '/v1/cookie_consents', f: 'q' },
  'cookie-subject': { m: 'GET', p: '/v1/cookie_consents/subjects/{}' },
  'cookie-subject-erase': { m: 'DELETE', p: '/v1/cookie_consents/subjects/{}', f: 'y' },
  'cookie-user-erase': { m: 'DELETE', p: '/v1/users/{}/cookie_consents', f: 'y' },
  'i18n-reviews': { m: 'GET', p: '/v1/localizations/{}/reviews' },
};
export const WORKFLOWS: Ops = {
  list: { m: 'GET', p: '/v1/workflows', f: 'q' },
  get: { m: 'GET', p: '/v1/workflows/{}' },
  runs: { m: 'GET', p: '/v1/workflows/{}/runs', f: 'q' },
  // A dry run executes nothing: every step reports what it would do.
  'dry-run': { m: 'POST', p: '/v1/workflows/{}/dry_run', f: 'b', bodyFlags: ['user-id', 'organization-id'] },
  cancel: { m: 'POST', p: '/v1/workflows/{}/runs/{}/cancel', f: 'y' },
  retry: { m: 'POST', p: '/v1/workflows/{}/runs/{}/retry', f: 'by', bodyFlags: ['from-step'] },
  approve: { m: 'POST', p: '/v1/workflow_approvals/{}/decide', f: 'by', fixed: { decision: 'approve' }, bodyFlags: ['comment'] },
  deny: { m: 'POST', p: '/v1/workflow_approvals/{}/decide', f: 'by', fixed: { decision: 'deny' }, bodyFlags: ['comment'] },
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
/** Application events: the catalog of types, publishing (organization_id "*" broadcasts) and the log. */
export const APP_EVENTS: Ops = {
  types: { m: 'GET', p: '/v1/app_event_types' },
  'type-get': { m: 'GET', p: '/v1/app_event_types/{}' },
  'type-create': { m: 'POST', p: '/v1/app_event_types', f: 'b' },
  'type-update': { m: 'PATCH', p: '/v1/app_event_types/{}', f: 'b' },
  'type-delete': { m: 'DELETE', p: '/v1/app_event_types/{}', f: 'y' },
  publish: { m: 'POST', p: '/v1/app_events', f: 'b', bodyFlags: ['organization-id', 'type'] },
  list: { m: 'GET', p: '/v1/app_events', f: 'q', query: ['organization-id', 'type'] },
  get: { m: 'GET', p: '/v1/app_events/{}' },
};

/** Why a request was refused, whether an origin can sign in, and what a browser request would hit. */
export const DIAGNOSTICS: Ops = {
  traces: { m: 'GET', p: '/v1/diagnostics/traces', query: ['user-id', 'since', 'until', 'code'] },
  trace: { m: 'GET', p: '/v1/diagnostics/traces/{}' },
  'login-readiness': { m: 'GET', p: '/v1/diagnostics/login_readiness', query: ['origin', 'live'] },
  inspect: { m: 'GET', p: '/v1/diagnostics/request_inspector', query: ['origin', 'method', 'path', 'token'] },
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
  types: { m: 'GET', p: '/v1/connection_actions/types' },
  rules: { m: 'GET', p: '/v1/connections/{}/access_rules' },
  'rules-set': { m: 'PUT', p: '/v1/connections/{}/access_rules', f: 'by' },
  'rules-clear': { m: 'DELETE', p: '/v1/connections/{}/access_rules', f: 'y' },
  'register-client': { m: 'POST', p: '/v1/connections/oauth_clients/register', f: 'b' },
};
export const CONNECTION_LIMITS: Ops = {
  get: { m: 'GET', p: '/v1/connections/token_limits' },
  set: { m: 'PUT', p: '/v1/connections/token_limits', f: 'b' },
  'relay-get': { m: 'GET', p: '/v1/connections/relay_limits' },
  'relay-set': { m: 'PUT', p: '/v1/connections/relay_limits', f: 'b' },
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
  delegations: { m: 'GET', p: '/v1/agent_delegations', f: 'q', query: ['machine-id', 'delegator-user-id', 'root-id'] },
  delegation: { m: 'GET', p: '/v1/agent_delegations/{}' },
  'delegation-graph': { m: 'GET', p: '/v1/agent_delegations/{}/graph' },
  delegate: { m: 'POST', p: '/v1/agent_delegations', f: 'b' },
  'delegation-revoke': { m: 'POST', p: '/v1/agent_delegations/{}/revoke', f: 'by' },
  'delegation-revoke-user': { m: 'POST', p: '/v1/agent_delegations/revoke_for_user', f: 'by' },
  'delegation-evaluate': { m: 'POST', p: '/v1/agent_delegations/{}/evaluate', f: 'b' },
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
  'connect-accounts': { m: 'GET', p: '/v1/billing/connect/accounts', f: 'q' },
  'connect-account': { m: 'GET', p: '/v1/billing/connect/accounts/{}' },
  'connect-account-create': { m: 'POST', p: '/v1/billing/connect/accounts', f: 'by' },
  'connect-onboarding-link': { m: 'POST', p: '/v1/billing/connect/accounts/{}/onboarding_link', f: 'b' },
  'connect-refresh': { m: 'POST', p: '/v1/billing/connect/accounts/{}/refresh' },
  'connect-transfers': { m: 'GET', p: '/v1/billing/connect/transfers', f: 'q' },
  'connect-transfer': { m: 'GET', p: '/v1/billing/connect/transfers/{}' },
  'connect-transfer-create': { m: 'POST', p: '/v1/billing/connect/transfers', f: 'by' },
  'store-link': { m: 'POST', p: '/v1/billing/store_links', f: 'by' },
};
export const AUDIT: Ops = {
  retention: { m: 'GET', p: '/v1/audit_retention' },
  'set-retention': { m: 'PUT', p: '/v1/audit_retention', f: 'by' },
  chain: { m: 'GET', p: '/v1/audit/chain' },
  'chain-enable': { m: 'PUT', p: '/v1/audit/chain', f: 'b', fixed: { enabled: true }, bodyFlags: ['checkpoint-interval-seconds'] },
  'chain-checkpoint': { m: 'POST', p: '/v1/audit/chain/checkpoints' },
  'chain-links': { m: 'GET', p: '/v1/audit/chain/links', query: ['after-seq', 'limit'] },
  'chain-verify': { m: 'POST', p: '/v1/audit/chain/verify', f: 'b' },
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

/** Provider changes: a connected provider's scopes or terms changed, and each connection awaits an acknowledgement. */
export const PROVIDER_CHANGES: Ops = {
  list: { m: 'GET', p: '/v1/connection_provider_changes', f: 'q' },
  get: { m: 'GET', p: '/v1/connection_provider_changes/{}' },
  acknowledge: { m: 'POST', p: '/v1/connection_provider_changes/{}/acknowledge', f: 'by' },
  resolve: { m: 'POST', p: '/v1/connection_provider_changes/{}/resolve', f: 'by' },
};
/** Journeys: queued messages (and cancelling one) and an experiment's readout. */
export const FLOWS: Ops = {
  messages: { m: 'GET', p: '/v1/flows/{}/messages', f: 'q' },
  'message-cancel': { m: 'POST', p: '/v1/flows/{}/messages/{}/cancel', f: 'y' },
  readout: { m: 'GET', p: '/v1/flows/{}/experiments/{}/readout' },
};
/** Referral rewards: the ledger, voiding one, and running the reward rules now. */
export const REFERRAL_REWARDS: Ops = {
  list: { m: 'GET', p: '/v1/referral_rewards', f: 'q' },
  get: { m: 'GET', p: '/v1/referral_rewards/{}' },
  void: { m: 'POST', p: '/v1/referral_rewards/{}/void', f: 'by' },
  run: { m: 'POST', p: '/v1/referral_rewards/run', f: 'by' },
};
/** Policies: who a policy is asked of and its per-language text. */
export const POLICIES: Ops = {
  audience: { m: 'GET', p: '/v1/policies/{}/audience' },
  'set-audience': { m: 'PUT', p: '/v1/policies/{}/audience', f: 'by' },
  translations: { m: 'GET', p: '/v1/policies/{}/versions/{}/translations' },
  'translation-set': { m: 'PUT', p: '/v1/policies/{}/versions/{}/translations/{}', f: 'by' },
  'translation-delete': { m: 'DELETE', p: '/v1/policies/{}/versions/{}/translations/{}', f: 'y' },
};
/** Where the instance lives: region pin, failover region, Frontend API origin isolation. */
export const REGION: Ops = {
  show: { m: 'GET', p: '/v1/region' },
  set: { m: 'PUT', p: '/v1/region', f: 'by', bodyFlags: ['failover-region', 'fapi-isolation'] },
  // Pinning is one-way (the data lives in the region): it needs --yes.
  pin: { m: 'PUT', p: '/v1/region', f: 'y', fixed: { pin: true } },
  failover: { m: 'GET', p: '/v1/region/failover' },
};
/** OAuth app publishers: verify the domain, attach or detach an app by its public client_id. */
export const OAUTH_PUBLISHERS: Ops = {
  list: { m: 'GET', p: '/v1/oauth_publishers' },
  verify: { m: 'POST', p: '/v1/oauth_publishers/{}/verify' },
  attach: { m: 'PUT', p: '/v1/oauth_publishers/{}/clients/{}', f: 'b' },
  detach: { m: 'DELETE', p: '/v1/oauth_publishers/{}/clients/{}', f: 'y' },
};
/** Custom domains: read one, re-check it, and get a fresh verification URL for a path mount. */
export const DOMAINS: Ops = {
  list: { m: 'GET', p: '/v1/domains' },
  get: { m: 'GET', p: '/v1/domains/{}' },
  verify: { m: 'POST', p: '/v1/domains/{}/verify' },
  'rotate-verification': {
    m: 'POST',
    p: '/v1/domains/{}/verification/rotate',
    out: (d) => {
      const v = (d.verification ?? {}) as { url?: string; previous_url?: string; previous_valid_until?: number | null };
      return [`Verify URL: ${v.url ?? ''}`, ...(v.previous_url ? [`Previous URL (still valid until ${v.previous_valid_until ? new Date(v.previous_valid_until).toISOString() : 'unknown'}): ${v.previous_url}`] : []), 'Publish the new file, then run: atlas domains verify <id>'].join('\n');
    },
  },
};
/** Age assurance of a user: the checks on record, recording one, and revoking one. */
export const AGE_ASSURANCE: Ops = {
  list: { m: 'GET', p: '/v1/users/{}/age_assurance' },
  record: { m: 'POST', p: '/v1/users/{}/age_assurance', f: 'by' },
  revoke: { m: 'POST', p: '/v1/users/{}/age_assurance/{}/revoke', f: 'by' },
};
/** A user's trusted approval devices. */
export const APPROVAL_DEVICES: Ops = {
  list: { m: 'GET', p: '/v1/users/{}/approval_devices' },
  trust: { m: 'POST', p: '/v1/users/{}/approval_devices/trust', f: 'by' },
  remove: { m: 'DELETE', p: '/v1/users/{}/approval_devices/{}', f: 'y' },
};

/** The same handler seen from one positional deeper: `atlas keys data status` → sub `status`. */
export const shift = (args: ParsedArgs): ParsedArgs => ({ ...args, positionals: [args.positionals[0]!, ...args.positionals.slice(2)] });
