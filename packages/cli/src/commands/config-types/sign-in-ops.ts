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

/** Hosted-page templates: the file is the LIVE template; apply saves a draft and promotes it. */
const pageTemplates: CollectionSpec = {
  kind: 'collection',
  type: 'page_templates',
  prune: false,
  fileKeys: ['page', 'definition'],
  keyOf: (c) => String(isObj(c) ? (c.page ?? '') : ''),
  async fetchLive(http: ConfigHttp): Promise<LiveEntry[]> {
    const res = await http.get<{ data?: Array<{ page?: string; live?: { definition?: Json } | null }> }>('/v1/instance/page_templates');
    const out: LiveEntry[] = [];
    for (const row of Array.isArray(res?.data) ? res.data : []) {
      if (!row.page || !row.live?.definition) continue;
      out.push({ key: row.page, id: row.page, config: { page: row.page, definition: row.live.definition } });
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
    await http.delete(`/v1/instance/page_templates/${enc(live.id)}?status=live`);
  },
};

async function savePage(http: ConfigHttp, config: Json): Promise<void> {
  const c = isObj(config) ? config : {};
  const page = enc(String(c.page ?? ''));
  await http.put(`/v1/instance/page_templates/${page}`, { definition: c.definition ?? null });
  await http.post(`/v1/instance/page_templates/${page}/promote`, {});
}

// A passkey campaign is immutable: change it by deleting (--prune-type) and applying again.
const passkeyCampaigns = simpleResourceSpec({
  type: 'passkey_campaigns',
  path: '/v1/passkey_campaigns',
  idKey: 'id',
  fileKeys: ['name', 'segment', 'frequency_cap_days', 'starts_at', 'ends_at'],
  createOnly: ['segment', 'frequency_cap_days', 'starts_at', 'ends_at'],
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
  fileKeys: ['name', 'trigger', 'code', 'runtime', 'http_target', 'enabled', 'secrets', 'signing_secret'],
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
  fileKeys: ['name', 'description', 'is_default', 'applications', 'enabled', 'definition'],
});

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
    policySettings,
    policySource,
    actions,
    actionBindings,
    journeys,
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
