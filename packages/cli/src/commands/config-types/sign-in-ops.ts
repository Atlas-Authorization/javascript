import type { ConfigHttp } from '../../config-http';
import { CliError } from '../../errors';
import type { Json } from '../../serialize';
import type { CollectionSpec, LiveEntry, ResourceSpec, SingletonSpec } from '../config';
import { simpleResourceSpec, simpleSingletonSpec } from './simple';

/**
 * Group 1 of the long tail: sign-in, messaging, events and operations. Everything here
 * is `prune: false` (deleted only with `--prune-type <type>`) and a credential is never
 * exported. Applied in the order below, after every type in config.ts.
 *
 * Not here, on purpose: `organization_settings` (the invitation keys) and `step_up_rules`
 * are already part of `instance.auth_config` (`organizations.*`, `stepUp`).
 */

const isObj = (v: unknown): v is Record<string, Json> => !!v && typeof v === 'object' && !Array.isArray(v);
const enc = encodeURIComponent;

const notificationCategories = simpleResourceSpec({
  type: 'notification_categories',
  path: '/v1/notification_categories',
  nameKey: 'key',
  fileKeys: ['key', 'label'],
  updateMethod: 'put',
});

// The list also shows every built-in template; only the customised ones are config.
const smsTemplates = simpleResourceSpec({
  type: 'sms_templates',
  path: '/v1/sms_templates',
  fileKeys: ['name', 'body', 'enabled'],
  liveFilter: (row) => row.customised === true,
});

const localizations = simpleResourceSpec({
  type: 'localizations',
  path: '/v1/localizations',
  keyKeys: ['resource_type', 'resource_name', 'locale'],
  idKey: 'id',
  fileKeys: ['resource_type', 'resource_name', 'locale', 'content', 'enabled'],
});

/**
 * Hosted-page templates: the file is the LIVE template; apply saves a draft and promotes it. An entry is one page
 * for one audience: no `client_id` / `organization_id` / `locale` is the instance-wide template, otherwise the
 * template for that OAuth client or organization and/or language. Pages: sign-in, sign-up, user-profile, mfa,
 * reset, verify, consent, device.
 */
const audienceKey = (c: Record<string, Json>): string => {
  const who = c.client_id ? `client:${String(c.client_id)}` : c.organization_id ? `org:${String(c.organization_id)}` : '';
  const locale = c.locale ? String(c.locale) : '';
  return [String(c.page ?? ''), who, locale].filter((x, i) => i === 0 || x !== '').join('|');
};

const audienceQuery = (c: Record<string, Json>, status?: string): string => {
  const q = new URLSearchParams();
  if (c.client_id) q.set('client_id', String(c.client_id));
  if (c.organization_id) q.set('organization_id', String(c.organization_id));
  if (c.locale) q.set('locale', String(c.locale));
  if (status) q.set('status', status);
  const s = q.toString();
  return s ? `?${s}` : '';
};

const pageTemplates: CollectionSpec = {
  kind: 'collection',
  type: 'page_templates',
  prune: false,
  fileKeys: ['page', 'client_id', 'organization_id', 'locale', 'definition'],
  keyOf: (c) => (isObj(c) ? audienceKey(c) : ''),
  async fetchLive(http: ConfigHttp): Promise<LiveEntry[]> {
    const res = await http.get<{ data?: Array<{ page?: string; scope?: { type?: string; id?: string | null }; locale?: string | null; live?: { definition?: Json } | null }> }>('/v1/instance/page_templates');
    const out: LiveEntry[] = [];
    for (const row of Array.isArray(res?.data) ? res.data : []) {
      if (!row.page || !row.live?.definition) continue;
      const config: Record<string, Json> = { page: row.page, definition: row.live.definition };
      if (row.scope?.type === 'client' && row.scope.id) config.client_id = row.scope.id;
      if (row.scope?.type === 'org' && row.scope.id) config.organization_id = row.scope.id;
      if (row.locale) config.locale = row.locale;
      out.push({ key: audienceKey(config), id: JSON.stringify(config), config });
    }
    return out;
  },
  async create(http, config) {
    await savePage(http, config);
  },
  async update(http, _live, config) {
    await savePage(http, config);
  },
  async remove(http, live) {
    const c = JSON.parse(live.id) as Record<string, Json>;
    await http.delete(`/v1/instance/page_templates/${enc(String(c.page))}${audienceQuery(c, 'live')}`);
  },
};

async function savePage(http: ConfigHttp, config: Json): Promise<void> {
  const c = isObj(config) ? config : {};
  const page = enc(String(c.page ?? ''));
  const q = audienceQuery(c);
  await http.put(`/v1/instance/page_templates/${page}${q}`, { definition: c.definition ?? null });
  await http.post(`/v1/instance/page_templates/${page}/promote${q}`, {});
}

// A passkey campaign is immutable: change it by deleting (--prune-type) and applying again.
const passkeyCampaigns = simpleResourceSpec({
  type: 'passkey_campaigns',
  path: '/v1/passkey_campaigns',
  idKey: 'id',
  fileKeys: ['name', 'segment', 'frequency_cap_days', 'starts_at', 'ends_at'],
  createOnly: ['segment', 'frequency_cap_days', 'starts_at', 'ends_at'],
});

// Named step-up policies: how recent and how strong a re-authentication a sensitive action needs. Matched by name.
const stepUpPolicies = simpleResourceSpec({
  type: 'step_up_policies',
  path: '/v1/step_up/policies',
  idKey: 'id',
  fileKeys: ['name', 'description', 'enabled', 'max_age_seconds', 'required_acr', 'required_amr', 'required_amr_any', 'phishing_resistant', 'allowed_methods', 'receipt_ttl_seconds'],
});

// MFA rollout campaigns. Who a campaign targets is fixed once it runs: change it by deleting (--prune-type) and applying again.
const mfaCampaigns = simpleResourceSpec({
  type: 'mfa_campaigns',
  path: '/v1/mfa_campaigns',
  idKey: 'id',
  fileKeys: ['name', 'target_type', 'target_value', 'required_factors', 'starts_at', 'grace_until', 'nag_interval_days', 'enforce'],
  createOnly: ['target_type', 'target_value', 'starts_at'],
  // An ended campaign is history, not configuration.
  liveFilter: (row) => row.status !== 'ended',
});

const policySettings = simpleSingletonSpec({ type: 'policy_settings', path: '/v1/instance/policy_settings', method: 'patch', fileKeys: ['session_claim'] });

const policySource = simpleSingletonSpec({
  type: 'policy_source',
  path: '/v1/instance/policy_source',
  fileKeys: ['enabled', 'endpoint_url', 'signing_secret', 'sync', 'poll_interval_minutes'],
  sealed: ['signing_secret'],
});

const actions = simpleResourceSpec({
  type: 'actions',
  path: '/v1/actions',
  idKey: 'id',
  // `code_file` (a path relative to the config) is read into `code` before the plan compares anything.
  fileKeys: ['name', 'trigger', 'code', 'code_file', 'runtime', 'http_target', 'enabled', 'egress_allowlist', 'secrets', 'signing_secret'],
  sealed: ['secrets', 'signing_secret'],
  createOnly: ['trigger', 'runtime'],
});

/** The ordered actions of each trigger, by action name: `{ trigger, actions: [name, ...] }`. */
const actionBindings: CollectionSpec = {
  kind: 'collection',
  type: 'action_bindings',
  prune: false,
  fileKeys: ['trigger', 'actions'],
  keyOf: (c) => String(isObj(c) ? (c.trigger ?? '') : ''),
  async fetchLive(http: ConfigHttp): Promise<LiveEntry[]> {
    const rows = await listActions(http);
    const out: LiveEntry[] = [];
    for (const trigger of [...new Set(rows.map((r) => r.trigger))].sort()) {
      const res = await http.get<{ action_ids?: string[] }>(`/v1/actions/bindings/${enc(trigger)}`);
      const names = (res?.action_ids ?? []).map((id) => rows.find((r) => r.id === id)?.name ?? id);
      if (names.length) out.push({ key: trigger, id: trigger, config: { trigger, actions: names } });
    }
    return out;
  },
  async create(http, config) {
    await setBinding(http, config);
  },
  async update(http, _live, config) {
    await setBinding(http, config);
  },
  async remove(http, live) {
    await http.put(`/v1/actions/bindings/${enc(live.id)}`, { action_ids: [] });
  },
};

async function listActions(http: ConfigHttp): Promise<Array<{ id: string; name: string; trigger: string }>> {
  const res = await http.get<{ data?: Array<{ id: string; name: string; trigger: string }> }>('/v1/actions');
  return Array.isArray(res?.data) ? res.data : [];
}

async function setBinding(http: ConfigHttp, config: Json): Promise<void> {
  const c = isObj(config) ? config : {};
  const trigger = String(c.trigger ?? '');
  const wanted = Array.isArray(c.actions) ? c.actions.map(String) : [];
  const rows = await listActions(http);
  const ids = wanted.map((name) => {
    const row = rows.find((r) => r.name === name && r.trigger === trigger);
    if (!row) throw new CliError(`action_bindings ${trigger}: no ${trigger} action named "${name}" (add it to actions first)`);
    return row.id;
  });
  await http.put(`/v1/actions/bindings/${enc(trigger)}`, { action_ids: ids });
}

const journeys = simpleResourceSpec({
  type: 'journeys',
  path: '/v1/flows',
  idKey: 'id',
  detail: true,
  // `abandon_after_hours`: how long a started run may sit untouched before journey.abandoned is sent (null = 72).
  fileKeys: ['name', 'description', 'is_default', 'applications', 'enabled', 'abandon_after_hours', 'definition'],
});

/**
 * A/B experiments on journeys, keyed `journey` (the journey's name) + `name`. `variants` is a list of
 * `{ key, version, weight }` (the first is the control). `status` is draft, running or stopped: apply creates
 * a draft and starts it when the file says running, and stops a running one when the file says stopped. A
 * started experiment keeps its variants, so changing them in the file is refused (add a new experiment).
 * Stopping never promotes a variant; do that with `POST /v1/flows/{id}/experiments/{experimentId}/stop`.
 */
const journeyExperiments: CollectionSpec = {
  kind: 'collection',
  type: 'journey_experiments',
  prune: false,
  fileKeys: ['journey', 'name', 'hypothesis', 'variants', 'status'],
  defaulted: ['hypothesis', 'status'],
  keyOf: (c) => (isObj(c) ? `${String(c.journey ?? '')}/${String(c.name ?? '')}` : ''),
  async fetchLive(http: ConfigHttp): Promise<LiveEntry[]> {
    const flows = await http.get<{ data?: Array<{ id: string; name: string }> }>('/v1/flows');
    const out: LiveEntry[] = [];
    for (const f of Array.isArray(flows?.data) ? flows.data : []) {
      const res = await http.get<{ data?: Array<Record<string, Json>> }>(`/v1/flows/${enc(f.id)}/experiments`);
      for (const x of Array.isArray(res?.data) ? res.data : []) {
        const name = String(x.name ?? '');
        out.push({ key: `${f.name}/${name}`, id: `${f.id}/${String(x.id)}`, config: { journey: f.name, name, hypothesis: (x.hypothesis as Json) ?? null, variants: (x.variants as Json) ?? [], status: (x.status as Json) ?? 'draft' } });
      }
    }
    return out;
  },
  async create(http, config) {
    const c = isObj(config) ? config : {};
    const flowId = await journeyIdByName(http, String(c.journey ?? ''));
    const status = String(c.status ?? 'draft');
    if (status === 'stopped') throw new CliError(`journey_experiments ${String(c.journey)}/${String(c.name)}: create it as draft or running; an experiment is stopped after it has run`);
    const made = await http.post<{ id: string }>(`/v1/flows/${enc(flowId)}/experiments`, { name: c.name, ...(c.hypothesis !== undefined ? { hypothesis: c.hypothesis } : {}), variants: c.variants });
    if (status === 'running') await http.post(`/v1/flows/${enc(flowId)}/experiments/${enc(made.id)}/start`, {});
  },
  async update(http, live, config) {
    const c = isObj(config) ? config : {};
    const l = isObj(live.config) ? live.config : {};
    const [flowId, id] = live.id.split('/') as [string, string];
    const wanted = String(c.status ?? l.status ?? 'draft');
    const have = String(l.status ?? 'draft');
    const same = JSON.stringify(c.variants ?? l.variants) === JSON.stringify(l.variants) && (c.name ?? l.name) === l.name && (c.hypothesis ?? null) === (l.hypothesis ?? null);
    if (!same) {
      if (have !== 'draft') throw new CliError(`journey_experiments ${live.key}: a ${have} experiment keeps its name and variants; add a new experiment instead`);
      await http.patch(`/v1/flows/${enc(flowId)}/experiments/${enc(id)}`, { name: c.name, hypothesis: c.hypothesis ?? null, variants: c.variants });
    }
    if (wanted === have) return;
    if (have === 'draft' && wanted === 'running') await http.post(`/v1/flows/${enc(flowId)}/experiments/${enc(id)}/start`, {});
    else if (have === 'running' && wanted === 'stopped') await http.post(`/v1/flows/${enc(flowId)}/experiments/${enc(id)}/stop`, {});
    else throw new CliError(`journey_experiments ${live.key}: cannot go from ${have} to ${wanted}`);
  },
  async remove(http, live) {
    const [flowId, id] = live.id.split('/') as [string, string];
    await http.delete(`/v1/flows/${enc(flowId)}/experiments/${enc(id)}`);
  },
};

async function journeyIdByName(http: ConfigHttp, name: string): Promise<string> {
  const res = await http.get<{ data?: Array<{ id: string; name: string }> }>('/v1/flows');
  const row = (Array.isArray(res?.data) ? res.data : []).find((f) => f.name === name);
  if (!row) throw new CliError(`journey_experiments: no journey named "${name}" (add it to journeys first)`);
  return row.id;
}

const workflows = simpleResourceSpec({
  type: 'workflows',
  path: '/v1/workflows',
  idKey: 'id',
  fileKeys: ['name', 'description', 'enabled', 'trigger', 'steps'],
});

// Types with a `required_scope` belong to third-party apps and are set with PUT /v1/instance/app_event_types.
const appEventTypes = simpleResourceSpec({
  type: 'app_event_types',
  path: '/v1/app_event_types',
  nameKey: 'type',
  fileKeys: ['type', 'description', 'schema', 'deprecated'],
  liveFilter: (row) => row.required_scope === null || row.required_scope === undefined,
});

// A schema version is immutable: only its description and status change in place.
const auditEventSchemas = simpleResourceSpec({
  type: 'audit_event_schemas',
  path: '/v1/audit_event_schemas',
  keyKeys: ['action', 'version'],
  idKey: 'id',
  fileKeys: ['action', 'version', 'description', 'target_types', 'actor_types', 'metadata_schema', 'status'],
  createOnly: ['target_types', 'actor_types', 'metadata_schema'],
});

const logStreams = simpleResourceSpec({
  type: 'log_streams',
  path: '/v1/log_streams',
  idKey: 'id',
  fileKeys: ['name', 'type', 'destination', 'event_filter', 'enabled'],
  createOnly: ['type'],
  markers: ['destination'],
});

const auditExports = simpleResourceSpec({
  type: 'audit_exports',
  path: '/v1/audit_exports',
  idKey: 'id',
  fileKeys: ['name', 'type', 'destination', 'action_filter', 'enabled', 'backfill_hours'],
  createOnly: ['type', 'backfill_hours'],
  markers: ['destination'],
});

/**
 * How long the audit log is kept. `retention_days: null` is the default. Shortening needs
 * `confirm_deletion: true` in the file (it deletes older entries); it is never exported.
 */
function auditRetentionSpec(): SingletonSpec {
  let defaultDays: number | null = null;
  return {
    kind: 'singleton',
    type: 'audit_retention',
    fileKeys: ['retention_days', 'confirm_deletion'],
    async fetchLive(http) {
      const res = await http.get<{ retention_days?: number; configured?: boolean; default_days?: number }>('/v1/audit_retention');
      defaultDays = typeof res?.default_days === 'number' ? res.default_days : null;
      return { retention_days: res?.configured ? (res.retention_days ?? null) : null };
    },
    normalize(c) {
      if (!isObj(c)) return c;
      const { confirm_deletion: _drop, ...rest } = c;
      return rest;
    },
    align(live, desired) {
      if (!isObj(live) || !isObj(desired)) return live;
      // Not configured and the file asks for the default length: the same thing.
      return (live.retention_days ?? null) === null && desired.retention_days === defaultDays ? { ...live, retention_days: defaultDays } : live;
    },
    async apply(http, config) {
      const c = isObj(config) ? config : {};
      await http.put('/v1/audit_retention', { retention_days: c.retention_days ?? null, ...(c.confirm_deletion === true ? { confirm_deletion: true } : {}) });
    },
  };
}

// OTLP/HTTP export of gateway and relay calls; the headers are write-only credentials.
const telemetryExport = simpleSingletonSpec({
  type: 'telemetry_export',
  path: '/v1/telemetry_export',
  fileKeys: ['enabled', 'endpoint', 'headers', 'service_name', 'traces', 'metrics'],
  sealed: ['headers'],
});

// A webhook_url is left out: Atlas mints its signing secret and shows it once, which a file cannot receive.
const alertRules = simpleResourceSpec({
  type: 'alert_rules',
  path: '/v1/analytics/alert_rules',
  idKey: 'id',
  fileKeys: ['name', 'metric', 'comparator', 'threshold', 'window_minutes', 'min_sample', 'cooldown_minutes', 'email_contacts', 'enabled', 'subject_type', 'subject_id', 'ssf'],
});

export function signInOpsTypes(): ResourceSpec[] {
  return [
    notificationCategories,
    smsTemplates,
    localizations,
    pageTemplates,
    passkeyCampaigns,
    stepUpPolicies,
    mfaCampaigns,
    policySettings,
    policySource,
    actions,
    actionBindings,
    journeys,
    journeyExperiments,
    workflows,
    appEventTypes,
    auditEventSchemas,
    logStreams,
    auditExports,
    auditRetentionSpec(),
    telemetryExport,
    alertRules,
  ];
}
