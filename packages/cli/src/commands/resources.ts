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
        const [flag, param] = k.split('=') as [string, string | undefined]; // 'flag=param' when the API name differs
        const v = str(args.values, flag as keyof Values);
        if (v) q.set((param ?? flag).replace(/-/g, '_'), v);
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
  receipt: { m: 'GET', p: '/v1/data_subject_requests/{}/receipt' },
  extend: { m: 'POST', p: '/v1/data_subject_requests/{}/extend', f: 'by' },
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
  'verify-request': { m: 'POST', p: '/v1/agents/verify_request', f: 'by' },
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
  'subscription-sync': { m: 'POST', p: '/v1/billing/subscriptions/{}/sync' },
  'checkout-sync': { m: 'POST', p: '/v1/billing/checkout/sync', f: 'b' },
  'stripe-event': { m: 'POST', p: '/v1/billing/stripe/events', f: 'b' },
  invoices: { m: 'GET', p: '/v1/billing/invoices', f: 'q' },
  invoice: { m: 'GET', p: '/v1/billing/invoices/{}' },
  'invoice-refund': { m: 'POST', p: '/v1/billing/invoices/{}/refund', f: 'by' },
  'trial-extend': { m: 'POST', p: '/v1/billing/subscriptions/{}/extend_trial', f: 'by' },
  usage: { m: 'GET', p: '/v1/billing/usage', f: 'q', query: ['user-id', 'organization-id', 'from', 'to'] },
  'usage-batch': { m: 'POST', p: '/v1/billing/usage/batch', f: 'by' },
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
  runs: { m: 'GET', p: '/v1/flows/{}/runs', f: 'q' },
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

/** The action registry: published actions and their review, drafts, namespace versions and pins, publisher keys, reviewers, sources and templates. */
export const PCA_REGISTRY: Ops = {
  show: { m: 'GET', p: '/v1/pca/action-registry' },
  actions: { m: 'GET', p: '/v1/pca/action-registry/actions', f: 'q' },
  action: { m: 'GET', p: '/v1/pca/action-registry/actions/{}' },
  review: { m: 'POST', p: '/v1/pca/action-registry/actions/{}/review', f: 'b' },
  drafts: { m: 'GET', p: '/v1/pca/action-registry/drafts', f: 'q' },
  draft: { m: 'GET', p: '/v1/pca/action-registry/drafts/{}' },
  'draft-update': { m: 'PATCH', p: '/v1/pca/action-registry/drafts/{}', f: 'b' },
  'draft-confirm': { m: 'POST', p: '/v1/pca/action-registry/drafts/{}/confirm', f: 'by' },
  'draft-delete': { m: 'DELETE', p: '/v1/pca/action-registry/drafts/{}', f: 'y' },
  versions: { m: 'GET', p: '/v1/pca/action-registry/namespaces/{}/versions', f: 'q' },
  version: { m: 'GET', p: '/v1/pca/action-registry/namespaces/{}/versions/{}' },
  diff: { m: 'GET', p: '/v1/pca/action-registry/namespaces/{}/diff', query: ['from', 'to'] },
  pin: { m: 'PUT', p: '/v1/pca/action-registry/namespaces/{}/pin', f: 'by' },
  unpin: { m: 'DELETE', p: '/v1/pca/action-registry/namespaces/{}/pin', f: 'y' },
  'publisher-key-add': { m: 'POST', p: '/v1/pca/action-registry/publisher-keys', f: 'by' },
  'publisher-key-remove': { m: 'DELETE', p: '/v1/pca/action-registry/publisher-keys/{}', f: 'y' },
  reviewers: { m: 'GET', p: '/v1/pca/action-registry/reviewers' },
  'reviewer-enrol': { m: 'POST', p: '/v1/pca/action-registry/reviewers/enrolments', f: 'by' },
  'reviewer-remove': { m: 'DELETE', p: '/v1/pca/action-registry/reviewers/{}', f: 'y' },
  sources: { m: 'GET', p: '/v1/pca/action-registry/sources' },
  'source-add': { m: 'POST', p: '/v1/pca/action-registry/sources', f: 'by' },
  'source-update': { m: 'PATCH', p: '/v1/pca/action-registry/sources/{}', f: 'by' },
  'source-sync': { m: 'POST', p: '/v1/pca/action-registry/sources/{}/sync', f: 'y' },
  'source-remove': { m: 'DELETE', p: '/v1/pca/action-registry/sources/{}', f: 'y' },
  templates: { m: 'GET', p: '/v1/pca/action-registry/templates' },
  'template-apply': { m: 'POST', p: '/v1/pca/action-registry/templates/{}/apply', f: 'by' },
  import: { m: 'POST', p: '/v1/pca/action-registry/imports', f: 'by' },
  pack: { m: 'POST', p: '/v1/pca/action-registry/packs', f: 'by' },
  publish: { m: 'POST', p: '/v1/pca/action-registry/publish', f: 'by' },
};
/** Grants of authority: read them, amend one, set its authority, raise a need, step up, withdraw. */
export const PCA_GRANTS: Ops = {
  list: { m: 'GET', p: '/v1/pca/grants', query: ['limit', 'status', 'principal', 'agent', 'starting-after=cursor'] },
  get: { m: 'GET', p: '/v1/pca/grants/{}' },
  needs: { m: 'GET', p: '/v1/pca/grants/{}/needs' },
  'need-add': { m: 'POST', p: '/v1/pca/grants/{}/needs', f: 'by' },
  amend: { m: 'POST', p: '/v1/pca/grants/{}/amend', f: 'by' },
  authority: { m: 'PUT', p: '/v1/pca/grants/{}/authority', f: 'by' },
  'step-up': { m: 'POST', p: '/v1/pca/grants/{}/step-up', f: 'by' },
  'step-up-approve': { m: 'POST', p: '/v1/pca/grants/{}/step-up/{}/approve', f: 'by' },
  revoke: { m: 'DELETE', p: '/v1/pca/grants/{}', f: 'y' },
};
/** Approvers, their groups and members, approval settings, and the needs they decide. */
export const PCA_APPROVERS: Ops = {
  list: { m: 'GET', p: '/v1/pca/approvers' },
  get: { m: 'GET', p: '/v1/pca/approvers/{}' },
  enrol: { m: 'POST', p: '/v1/pca/approvers/enrolments', f: 'by' },
  update: { m: 'PATCH', p: '/v1/pca/approvers/{}', f: 'by' },
  'member-update': { m: 'PATCH', p: '/v1/pca/approvers/{}/members/{}', f: 'by' },
  'credential-remove': { m: 'DELETE', p: '/v1/pca/approvers/{}/credentials/{}', f: 'y' },
  settings: { m: 'GET', p: '/v1/pca/approvals/settings' },
  'settings-set': { m: 'PUT', p: '/v1/pca/approvals/settings', f: 'by' },
  approve: { m: 'POST', p: '/v1/pca/needs/{}/approve', f: 'by' },
  deny: { m: 'POST', p: '/v1/pca/needs/{}/deny', f: 'by' },
};
/** Undo records and the vetoes against them. */
export const PCA_UNDO: Ops = {
  record: { m: 'GET', p: '/v1/pca/undo/records/{}' },
  'record-add': { m: 'POST', p: '/v1/pca/undo/records', f: 'by' },
  'record-update': { m: 'PUT', p: '/v1/pca/undo/records/{}', f: 'by' },
  vetoes: { m: 'GET', p: '/v1/pca/undo/vetoes', f: 'q' },
};
/** Proof-carrying authority admin: principals, bond accounts, constitutions, beacons, guardian rotation, intent, post-quantum pins and workflow receipts. */
export const PCA: Ops = {
  principals: { m: 'GET', p: '/v1/pca/principals' },
  'principal-add': { m: 'POST', p: '/v1/pca/principals', f: 'by' },
  'principal-remove': { m: 'DELETE', p: '/v1/pca/principals/{}', f: 'y' },
  'bond-accounts': { m: 'GET', p: '/v1/pca/bond-accounts' },
  'bond-account-add': { m: 'POST', p: '/v1/pca/bond-accounts', f: 'by' },
  constitution: { m: 'POST', p: '/v1/pca/constitutions', f: 'by' },
  beacon: { m: 'POST', p: '/v1/pca/beacons', f: 'by' },
  'guardian-rotate': { m: 'POST', p: '/v1/pca/guardian/rotate', f: 'y' },
  'intent-schema': { m: 'POST', p: '/v1/pca/intent/schemas', f: 'by' },
  'intent-observations': { m: 'GET', p: '/v1/pca/intent/maps/{}/observations', f: 'q' },
  'pq-pin-remove': { m: 'DELETE', p: '/v1/pca/pq-pins/{}', f: 'y' },
  'workflow-receipt': { m: 'POST', p: '/v1/pca/workflow-receipts', f: 'by' },
};
/** Shared signals framework: the stream configuration, subjects, verification and polling. */
export const SSF: Ops = {
  show: { m: 'GET', p: '/v1/ssf/configuration' },
  metadata: { m: 'GET', p: '/v1/ssf/metadata' },
  create: { m: 'POST', p: '/v1/ssf/configuration', f: 'by' },
  replace: { m: 'PUT', p: '/v1/ssf/configuration', f: 'by' },
  update: { m: 'PATCH', p: '/v1/ssf/configuration', f: 'by' },
  remove: { m: 'DELETE', p: '/v1/ssf/configuration', f: 'y' },
  'add-subject': { m: 'POST', p: '/v1/ssf/add_subject', f: 'by' },
  'remove-subject': { m: 'POST', p: '/v1/ssf/remove_subject', f: 'by' },
  verify: { m: 'POST', p: '/v1/ssf/verification', f: 'b' },
  poll: { m: 'POST', p: '/v1/ssf/streams/{}/poll', f: 'b' },
};
/** Staging copies of the instance: copy it, read a copy, refresh it from the source, delete it. */
export const STAGING_COPIES: Ops = {
  list: { m: 'GET', p: '/v1/instance/staging_copies', f: 'q', query: ['kind'] },
  get: { m: 'GET', p: '/v1/instance/staging_copies/{}' },
  create: { m: 'POST', p: '/v1/instance/staging_copies', f: 'by' },
  refresh: { m: 'POST', p: '/v1/instance/staging_copies/{}/refresh', f: 'y' },
  delete: { m: 'DELETE', p: '/v1/instance/staging_copies/{}', f: 'y' },
};
/** Platform apps: refresh a clone from its source, renew a web app's 24-hour provisioning key. */
export const PLATFORM_APPS: Ops = {
  'clone-refresh': { m: 'POST', p: '/v1/platform/apps/{}/instances/{}/clones/{}/refresh', f: 'by' },
  'renew-provisioning-key': { m: 'POST', p: '/v1/platform/apps/{}/provisioning_key/renew', f: 'by' },
  'narrow-secret-keys': { m: 'POST', p: '/v1/platform/apps/{}/narrow_secret_keys', f: 'by' },
};
/** Revocations as a long poll (see also `atlas revocations stream`). */
export const REVOCATIONS: Ops = {
  list: { m: 'GET', p: '/v1/revocations', query: ['after', 'since', 'kinds', 'limit', 'wait-seconds=wait'] },
};
/** Per-user security reads and writes that sit beside `users`. */
export const USER_SECURITY: Ops = {
  deleted: { m: 'GET', p: '/v1/users/deleted', f: 'q' },
  'deletion-update': { m: 'PATCH', p: '/v1/users/{}/deletion', f: 'by' },
  'risk-signals': { m: 'GET', p: '/v1/users/{}/risk_signals', f: 'q' },
  'risk-signal-add': { m: 'POST', p: '/v1/users/{}/risk_signals', f: 'by' },
  'risk-signals-clear': { m: 'DELETE', p: '/v1/users/{}/risk_signals', f: 'y' },
  'security-summary': { m: 'GET', p: '/v1/users/{}/security_summary' },
  'approval-requests': { m: 'GET', p: '/v1/users/{}/approval_requests', f: 'q' },
  'delegation-token': { m: 'POST', p: '/v1/users/{}/delegation_tokens', f: 'by' },
  upsert: { m: 'PUT', p: '/v1/users/by_external_id/{}', f: 'by' },
  journeys: { m: 'GET', p: '/v1/users/{}/journeys', f: 'q' },
  'journeys-clear': { m: 'DELETE', p: '/v1/users/{}/journeys', f: 'y' },
  'legal-hold': { m: 'GET', p: '/v1/users/{}/legal_hold' },
  'legal-hold-set': { m: 'POST', p: '/v1/users/{}/legal_hold', f: 'by' },
  'legal-hold-release': { m: 'POST', p: '/v1/users/{}/legal_hold/release', f: 'by' },
  'owned-organizations': { m: 'GET', p: '/v1/users/{}/owned_organizations', f: 'q' },
  'identity-verification': { m: 'GET', p: '/v1/users/{}/identity_verifications/{}' },
  'identity-verification-import': { m: 'POST', p: '/v1/users/{}/identity_verifications/import', f: 'by' },
  'approval-request-cancel': { m: 'POST', p: '/v1/users/{}/approval_requests/{}/cancel', f: 'by' },
  'deletion-reconfirm': { m: 'POST', p: '/v1/users/{}/deletion/reconfirm', f: 'by' },
  'bulk-actions': { m: 'GET', p: '/v1/users/bulk_actions', f: 'q' },
  'bulk-action': { m: 'GET', p: '/v1/users/bulk_actions/{}' },
  'bulk-action-create': { m: 'POST', p: '/v1/users/bulk_actions', f: 'by' },
  'bulk-action-cancel': { m: 'POST', p: '/v1/users/bulk_actions/{}/cancel', f: 'by' },
  'deleted-address-add': { m: 'POST', p: '/v1/users/deleted_addresses', f: 'by' },
  'deleted-address-check': { m: 'POST', p: '/v1/users/deleted_addresses/check', f: 'b' },
  'search-fields': { m: 'GET', p: '/v1/users/search/fields' },
  'search-view-count': { m: 'POST', p: '/v1/users/search/views/{}/count', f: 'b' },
};
/** Pending device authorizations and the account switch of a consent request. */
export const OAUTH_DEVICE: Ops = {
  list: { m: 'GET', p: '/v1/oauth_device_requests', f: 'q' },
  accept: { m: 'PUT', p: '/v1/oauth_device_requests/accept', f: 'by' },
  reject: { m: 'PUT', p: '/v1/oauth_device_requests/reject', f: 'by' },
  'switch-account': { m: 'PUT', p: '/v1/oauth_consent_requests/switch_account', f: 'by' },
};
export const ANALYTICS: Ops = {
  captcha: { m: 'GET', p: '/v1/analytics/captcha', query: ['from', 'to', 'days'] },
  sms: { m: 'GET', p: '/v1/analytics/sms', query: ['from', 'to', 'days', 'organization-id'] },
};
export const MACHINES: Ops = { revoked: { m: 'GET', p: '/v1/machines/revoked', f: 'q' } };
export const WEBHOOK_DLQ: Ops = { list: { m: 'GET', p: '/v1/webhook_dlq', f: 'q' } };
export const ORG_INVITATIONS: Ops = { list: { m: 'GET', p: '/v1/organization_invitations', f: 'q', query: ['organization-id'] } };
export const MESSAGE_LINKS: Ops = { create: { m: 'POST', p: '/v1/message_links', f: 'by' } };
export const PERMISSIONS: Ops = { rename: { m: 'POST', p: '/v1/permissions/{}/rename', f: 'by' } };
export const MIGRATION_SESSIONS: Ops = { create: { m: 'POST', p: '/v1/migrations/{}/sessions', f: 'by' } };
export const SESSIONS_MORE: Ops = {
  'set-active-organization': { m: 'PUT', p: '/v1/sessions/{}/active_organization', f: 'by' },
  'grant-update': { m: 'PATCH', p: '/v1/machines/{}/grants/{}', f: 'by' },
  events: { m: 'GET', p: '/v1/sessions/{}/events', f: 'q' },
  export: { m: 'GET', p: '/v1/sessions/export', f: 'q', query: ['user-id', 'from', 'to'] },
  'revocations-status-list': { m: 'GET', p: '/v1/sessions/revocations/status-list' },
  'revoke-jobs': { m: 'GET', p: '/v1/sessions/revoke_jobs', f: 'q' },
  'revoke-job': { m: 'GET', p: '/v1/sessions/revoke_jobs/{}' },
  'revoke-by-filter': { m: 'POST', p: '/v1/sessions/revoke_by_filter', f: 'by' },
};

/** Extra subcommands of existing handlers (a name here must not clash with the handler's own). */
export const API_KEYS_MORE: Ops = {
  callers: { m: 'GET', p: '/v1/api_keys/{}/callers', f: 'q' },
  posture: { m: 'GET', p: '/v1/api_keys/posture' },
  rotate: { m: 'POST', p: '/v1/api_keys/{}/rotate', f: 'by' },
};
export const CHANGES_MORE: Ops = {
  snapshot: { m: 'GET', p: '/v1/changes/snapshot/{}', f: 'q' },
  'consumer-ack': { m: 'PUT', p: '/v1/changes/consumers/{}/ack', f: 'by' },
};
export const CONNECTIONS_MORE: Ops = {
  activity: { m: 'GET', p: '/v1/connections/{}/activity', f: 'q' },
  'provider-events': { m: 'GET', p: '/v1/connections/{}/provider_events', f: 'q' },
  'provider-event': { m: 'GET', p: '/v1/connections/{}/provider_events/{}' },
  'provider-event-replay': { m: 'POST', p: '/v1/connections/{}/provider_events/{}/replay', f: 'by' },
  'provider-event-log': { m: 'GET', p: '/v1/connection_provider_event_log', f: 'q' },
  'reconnect-link': { m: 'POST', p: '/v1/connections/{}/reconnect_link', f: 'by' },
  'token-exchange': { m: 'POST', p: '/v1/connections/{}/token/exchange', f: 'by' },
  'oauth-complete': { m: 'POST', p: '/v1/connections/oauth/complete', f: 'by' },
};
export const GRANTS_MORE: Ops = {
  consume: { m: 'POST', p: '/v1/grants/{}/{}/consume', f: 'by' },
  refund: { m: 'POST', p: '/v1/grants/{}/{}/refund', f: 'by' },
  'lease-release': { m: 'POST', p: '/v1/grants/{}/{}/leases/{}/release', f: 'by' },
};
export const MESSAGES_MORE: Ops = { summary: { m: 'GET', p: '/v1/messages/summary', query: ['from', 'to', 'days'] } };
export const ORGS_MORE: Ops = {
  'directory-sync-runs': { m: 'GET', p: '/v1/organizations/{}/directory_sync_runs', f: 'q' },
  'directory-sync-retry': { m: 'POST', p: '/v1/organizations/{}/directory_sync_runs/{}/retry', f: 'by' },
  'it-health': { m: 'GET', p: '/v1/organizations/{}/it_health' },
  'role-policy': { m: 'GET', p: '/v1/organizations/{}/role_policy' },
  'role-policy-set': { m: 'PUT', p: '/v1/organizations/{}/role_policy', f: 'by' },
  'scim-requests': { m: 'GET', p: '/v1/organizations/{}/scim/requests', f: 'q' },
  seats: { m: 'GET', p: '/v1/organizations/{}/seats' },
  'seats-set': { m: 'PUT', p: '/v1/organizations/{}/seats', f: 'by' },
  'invitations-import': { m: 'POST', p: '/v1/organizations/{}/invitations/import', f: 'by' },
  'membership-import': { m: 'POST', p: '/v1/organizations/{}/membership_imports', f: 'by' },
  'webhook-redeliver': { m: 'POST', p: '/v1/organizations/{}/webhook_endpoints/{}/deliveries/{}/redeliver', f: 'by' },
  'webhook-replay': { m: 'POST', p: '/v1/organizations/{}/webhook_endpoints/{}/replay', f: 'by' },
  'webhook-reveal-secret': { m: 'POST', p: '/v1/organizations/{}/webhook_endpoints/{}/reveal_secret', f: 'y' },
  'webhook-test': { m: 'POST', p: '/v1/organizations/{}/webhook_endpoints/{}/test', f: 'by' },
};
export const AUTHZ: Ops = {
  'what-ifs': { m: 'GET', p: '/v1/authz/what_if', f: 'q' },
  'what-if': { m: 'GET', p: '/v1/authz/what_if/{}' },
  'what-if-run': { m: 'POST', p: '/v1/authz/what_if', f: 'by' },
  'what-if-delete': { m: 'DELETE', p: '/v1/authz/what_if/{}', f: 'y' },
  events: { m: 'GET', p: '/v1/authz/events', f: 'q' },
  explain: { m: 'POST', p: '/v1/authz/explain', f: 'b' },
  'rbac-check': { m: 'POST', p: '/v1/authz/rbac/check', f: 'b' },
};
export const ATLAS_ID_APPS: Ops = {
  codes: { m: 'GET', p: '/v1/platform/atlas_id_apps/{}/adoption_codes', f: 'q' },
  'code-create': { m: 'POST', p: '/v1/platform/atlas_id_apps/{}/adoption_codes', f: 'by' },
  'code-delete': { m: 'DELETE', p: '/v1/platform/atlas_id_apps/{}/adoption_codes/{}', f: 'y' },
  adopt: { m: 'POST', p: '/v1/atlas_id_apps/adopt', f: 'by' },
  release: { m: 'POST', p: '/v1/atlas_id_apps/{}/release', f: 'by' },
};
export const RATE_LIMITS: Ops = {
  overrides: { m: 'GET', p: '/v1/rate_limit_overrides', f: 'q' },
  override: { m: 'GET', p: '/v1/rate_limit_overrides/{}/{}' },
  'override-set': { m: 'PUT', p: '/v1/rate_limit_overrides/{}/{}', f: 'by' },
  'override-clear': { m: 'DELETE', p: '/v1/rate_limit_overrides/{}/{}', f: 'y' },
  resolve: { m: 'GET', p: '/v1/rate_limit_policies/resolve', query: ['subject-type', 'subject-id'] },
};
export const RISK_SIGNALS: Ops = {
  list: { m: 'GET', p: '/v1/risk_signals', f: 'q', query: ['user-id'] },
  get: { m: 'GET', p: '/v1/risk_signals/{}' },
  add: { m: 'POST', p: '/v1/risk_signals', f: 'by' },
  delete: { m: 'DELETE', p: '/v1/risk_signals/{}', f: 'y' },
};
export const SUPPRESSIONS: Ops = {
  list: { m: 'GET', p: '/v1/suppressions', f: 'q' },
  get: { m: 'GET', p: '/v1/suppressions/{}' },
  add: { m: 'POST', p: '/v1/suppressions', f: 'by' },
  remove: { m: 'DELETE', p: '/v1/suppressions/{}', f: 'y' },
};
export const WEB_BOT_AUTH: Ops = {
  list: { m: 'GET', p: '/v1/web_bot_auth/directories', f: 'q' },
  add: { m: 'POST', p: '/v1/web_bot_auth/directories', f: 'by' },
  remove: { m: 'DELETE', p: '/v1/web_bot_auth/directories/{}', f: 'y' },
};
export const ABUSE_SIGNALS: Ops = {
  list: { m: 'GET', p: '/v1/abuse_signals', f: 'q', query: ['user-id', 'from', 'to'] },
  summary: { m: 'GET', p: '/v1/abuse_signals/summary', query: ['from', 'to', 'days'] },
};
export const APPROVAL_REQUESTS: Ops = {
  list: { m: 'GET', p: '/v1/approval_requests', f: 'q' },
  get: { m: 'GET', p: '/v1/approval_requests/{}' },
  create: { m: 'POST', p: '/v1/approval_requests', f: 'by' },
  cancel: { m: 'POST', p: '/v1/approval_requests/{}/cancel', f: 'by' },
  consume: { m: 'POST', p: '/v1/approval_requests/{}/consume', f: 'by' },
};
export const ENTITLEMENTS: Ops = {
  consume: { m: 'POST', p: '/v1/entitlements/consume', f: 'by' },
  refund: { m: 'POST', p: '/v1/entitlements/consume/refund', f: 'by' },
};
export const FGA_SYNC: Ops = {
  runs: { m: 'GET', p: '/v1/fga/sync/runs', f: 'q' },
  run: { m: 'GET', p: '/v1/fga/sync/runs/{}' },
  backfill: { m: 'POST', p: '/v1/fga/sync/backfill', f: 'by' },
  purge: { m: 'POST', p: '/v1/fga/sync/purge', f: 'by' },
};
export const IMPERSONATIONS: Ops = { request: { m: 'GET', p: '/v1/impersonations/requests/{}' } };
/** Instance-level moves and checks: data-key rotation drills, deprecations, exports and imports. */
export const INSTANCE: Ops = {
  'rotation-drills': { m: 'GET', p: '/v1/instance/data_key_provider/rotation_drills', f: 'q' },
  'rotation-drill': { m: 'GET', p: '/v1/instance/data_key_provider/rotation_drills/{}' },
  'rotation-drill-run': { m: 'POST', p: '/v1/instance/data_key_provider/rotation_drill', f: 'by' },
  deprecations: { m: 'GET', p: '/v1/instance/deprecations' },
  exports: { m: 'GET', p: '/v1/instance/exports', f: 'q' },
  export: { m: 'GET', p: '/v1/instance/exports/{}' },
  'export-bundle': { m: 'GET', p: '/v1/instance/exports/{}/bundle' },
  'export-create': { m: 'POST', p: '/v1/instance/exports', f: 'by' },
  'export-download-url': { m: 'POST', p: '/v1/instance/exports/{}/download_url', f: 'by' },
  'export-revoke-links': { m: 'POST', p: '/v1/instance/exports/{}/revoke_links', f: 'y' },
  imports: { m: 'GET', p: '/v1/instance/imports', f: 'q' },
  import: { m: 'GET', p: '/v1/instance/imports/{}' },
  'import-create': { m: 'POST', p: '/v1/instance/imports', f: 'by' },
};
export const LEGAL_HOLDS: Ops = { list: { m: 'GET', p: '/v1/legal_holds', f: 'q' } };
export const MFA_CAMPAIGNS: Ops = {
  users: { m: 'GET', p: '/v1/mfa_campaigns/{}/users', f: 'q' },
  user: { m: 'GET', p: '/v1/mfa_campaigns/{}/users/{}' },
  'user-set': { m: 'PUT', p: '/v1/mfa_campaigns/{}/users/{}', f: 'by' },
};
export const MACHINE_TRUST_POLICIES: Ops = { test: { m: 'POST', p: '/v1/machine_trust_policies/{}/test', f: 'b' } };
export const ORG_TEMPLATES: Ops = { 'create-organization': { m: 'POST', p: '/v1/org_templates/{}/organizations', f: 'by' } };
export const RISK_BASED_MFA: Ops = { replay: { m: 'POST', p: '/v1/risk_based_mfa/replay', f: 'b' } };
export const SCIM_TOKENS: Ops = { rotate: { m: 'POST', p: '/v1/scim_tokens/{}/rotate', f: 'by' } };
export const SSO_CONNECTIONS: Ops = {
  'login-history': { m: 'GET', p: '/v1/sso_connections/{}/login_history', f: 'q' },
  test: { m: 'POST', p: '/v1/sso_connections/{}/test', f: 'b' },
  'test-login': { m: 'POST', p: '/v1/sso_connections/{}/test_login', f: 'b' },
};
export const STEP_UP: Ops = { assert: { m: 'POST', p: '/v1/step_up/assert', f: 'b' } };
export const MESSAGING_PROVIDERS: Ops = {
  'fallbacks-order': { m: 'PUT', p: '/v1/messaging_providers/{}/fallbacks/order', f: 'by' },
  push: { m: 'PUT', p: '/v1/messaging_providers/push', f: 'by' },
};
export const RESOURCE_ROLE_ASSIGNMENTS: Ops = { changes: { m: 'GET', p: '/v1/resource_role_assignments/changes', f: 'q' } };
export const RESOURCE_SERVERS: Ops = { 'revoked-tokens': { m: 'GET', p: '/v1/resource_servers/{}/revoked_tokens', f: 'q' } };

/** A handler with extra table-driven subcommands: the table answers its own names, the handler everything else. */
export const withOps = (name: string, ops: Ops, base: Handler): Handler => {
  const more = resourceCommand(name, ops);
  return (ctx, args) => (args.positionals[1] && Object.hasOwn(ops, args.positionals[1]) ? more(ctx, args) : base(ctx, args));
};

/** The same handler seen from one positional deeper: `atlas keys data status` → sub `status`. */
export const shift = (args: ParsedArgs): ParsedArgs => ({ ...args, positionals: [args.positionals[0]!, ...args.positionals.slice(2)] });
