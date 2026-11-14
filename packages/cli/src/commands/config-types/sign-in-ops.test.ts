import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ConfigHttp } from '../../config-http';
import type { Json } from '../../serialize';
import { planConfigImport } from '../config';
import { registeredConfigTypes } from './index';
import { signInOpsTypes } from './sign-in-ops';

type Call = { method: string; path: string; body?: unknown };

/** A fake API: `lists` answers a GET with `{ data }`, `raw` answers it with the body as given. */
class Http implements ConfigHttp {
  calls: Call[] = [];
  constructor(
    private lists: Record<string, unknown[]> = {},
    private raw: Record<string, unknown> = {},
  ) {}
  async get<T>(path: string): Promise<T> {
    if (path in this.raw) return this.raw[path] as T;
    return { data: this.lists[path] ?? [] } as T;
  }
  async post<T>(path: string, body: unknown): Promise<T> {
    this.calls.push({ method: 'POST', path, body });
    return {} as T;
  }
  async put<T>(path: string, body: unknown): Promise<T> {
    this.calls.push({ method: 'PUT', path, body });
    return {} as T;
  }
  async patch<T>(path: string, body: unknown): Promise<T> {
    this.calls.push({ method: 'PATCH', path, body });
    return {} as T;
  }
  async delete(path: string): Promise<void> {
    this.calls.push({ method: 'DELETE', path });
  }
}

let dir = '';
afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

/** Plan `doc` as `<type>.json` against the fake, apply every change, and return what was planned and called. */
async function run(type: string, doc: Json, http: Http, opts: { prune?: boolean; pruneTypes?: string[] } = {}) {
  dir = mkdtempSync(join(tmpdir(), 'atlas-f1-'));
  writeFileSync(join(dir, `${type}.json`), JSON.stringify(doc));
  const plan = await planConfigImport(http, { dir, format: 'json', env: { TOKEN: 'tok-value' }, prune: opts.prune ?? false, pruneTypes: opts.pruneTypes });
  for (const c of plan.changes) await c.apply!();
  return { plan, summary: plan.changes.map((c) => `${c.action} ${c.type}${c.key ? ` ${c.key}` : ''}`) };
}

const liveOf = async (type: string, http: Http) => (signInOpsTypes().find((s) => s.type === type) as unknown as { fetchLive(h: ConfigHttp): Promise<Array<{ config: Json }>> }).fetchLive(http);

describe('registry', () => {
  it('registers the group once, after the core types, all opt-in to deletion', () => {
    const names = registeredConfigTypes().map((s) => s.type);
    expect(names.slice(0, 4)).toEqual(['notification_categories', 'sms_templates', 'localizations', 'page_templates']);
    for (const s of signInOpsTypes()) if (s.kind === 'collection') expect(s.prune).toBe(false);
  });
});

describe('notification_categories', () => {
  it('creates and updates (PUT) by key', async () => {
    const http = new Http({ '/v1/notification_categories': [{ key: 'news', label: 'Old' }] });
    const { summary } = await run('notification_categories', [{ key: 'news', label: 'News' }, { key: 'tips', label: 'Tips' }], http);
    expect(summary.sort()).toEqual(['create notification_categories tips', 'update notification_categories news']);
    expect(http.calls).toContainEqual({ method: 'PUT', path: '/v1/notification_categories/news', body: { label: 'News' } });
    expect(http.calls).toContainEqual({ method: 'POST', path: '/v1/notification_categories', body: { key: 'tips', label: 'Tips' } });
  });
});

describe('sms_templates', () => {
  it('treats only customised templates as live', async () => {
    const http = new Http({ '/v1/sms_templates': [{ name: 'otp', body: null, enabled: false, customised: false }, { name: 'login', body: 'Code {{code}}', enabled: true, customised: true }] });
    const live = await liveOf('sms_templates', http);
    expect(live).toHaveLength(1);
    const { summary } = await run('sms_templates', [{ name: 'otp', body: 'Your code {{code}}', enabled: true }, { name: 'login', body: 'Code {{code}}', enabled: true }], http);
    expect(summary).toEqual(['create sms_templates otp']);
  });
});

describe('localizations', () => {
  it('is keyed by type, name and locale and patched by id', async () => {
    const row = { id: 'loc_1', resource_type: 'sms_template', resource_name: 'otp', locale: 'fr', content: { body: 'Ancien {{code}}' }, enabled: true };
    const http = new Http({ '/v1/localizations': [row] });
    const { summary } = await run('localizations', [{ ...row, content: { body: 'Code {{code}}' }, id: undefined } as never], http);
    expect(summary).toEqual(['update localizations sms_template/otp/fr']);
    expect(http.calls).toEqual([{ method: 'PATCH', path: '/v1/localizations/loc_1', body: { content: { body: 'Code {{code}}' }, enabled: true } }]);
  });
});

describe('page_templates', () => {
  it('saves a draft and promotes it', async () => {
    const http = new Http({ '/v1/instance/page_templates': [{ page: 'sign-in', live: null, draft: null }] });
    const definition = { version: 1, regions: { header: [] } };
    await run('page_templates', [{ page: 'sign-in', definition }], http);
    expect(http.calls).toEqual([
      { method: 'PUT', path: '/v1/instance/page_templates/sign-in', body: { definition } },
      { method: 'POST', path: '/v1/instance/page_templates/sign-in/promote', body: {} },
    ]);
  });

  it('is unchanged when the live definition matches, and deletes only the live slot', async () => {
    const definition = { version: 1, regions: { header: [] } };
    const http = new Http({ '/v1/instance/page_templates': [{ page: 'sign-in', live: { definition }, draft: null }] });
    expect((await run('page_templates', [{ page: 'sign-in', definition }], http)).summary).toEqual([]);
    const gone = new Http({ '/v1/instance/page_templates': [{ page: 'sign-up', live: { definition }, draft: null }] });
    await run('page_templates', [], gone, { pruneTypes: ['page_templates'] });
    expect(gone.calls).toEqual([{ method: 'DELETE', path: '/v1/instance/page_templates/sign-up?status=live' }]);
  });

  it('keeps a template per client, organization and language, each its own entry', async () => {
    const definition = { version: 1, regions: { header: [] } };
    const http = new Http({
      '/v1/instance/page_templates': [
        { page: 'sign-in', scope: { type: 'instance', id: null }, locale: null, live: { definition }, draft: null },
        { page: 'sign-in', scope: { type: 'client', id: 'client_a' }, locale: 'fr', live: { definition }, draft: null },
      ],
    });
    const live = await liveOf('page_templates', http);
    expect(live.map((l) => (l as unknown as { key: string }).key)).toEqual(['sign-in', 'sign-in|client:client_a|fr']);
    // Unchanged when both match; a new organization entry is saved with its audience in the query.
    const doc: Json = [
      { page: 'sign-in', definition },
      { page: 'sign-in', client_id: 'client_a', locale: 'fr', definition },
      { page: 'consent', organization_id: 'org_1', definition },
    ];
    const out = await run('page_templates', doc, http);
    expect(out.summary).toEqual(['create page_templates consent|org:org_1']);
    expect(http.calls).toEqual([
      { method: 'PUT', path: '/v1/instance/page_templates/consent?organization_id=org_1', body: { definition } },
      { method: 'POST', path: '/v1/instance/page_templates/consent/promote?organization_id=org_1', body: {} },
    ]);
    // Taking one down names its audience.
    const gone = new Http({ '/v1/instance/page_templates': [{ page: 'sign-in', scope: { type: 'client', id: 'client_a' }, locale: 'fr', live: { definition }, draft: null }] });
    await run('page_templates', [], gone, { pruneTypes: ['page_templates'] });
    expect(gone.calls).toEqual([{ method: 'DELETE', path: '/v1/instance/page_templates/sign-in?client_id=client_a&locale=fr&status=live' }]);
  });
});

describe('passkey_campaigns', () => {
  it('warns instead of failing when an immutable field differs', async () => {
    const http = new Http({ '/v1/passkey_campaigns': [{ id: 'pkc_1', name: 'spring', segment: {}, frequency_cap_days: 30, starts_at: 1, ends_at: null }] });
    const { plan, summary } = await run('passkey_campaigns', [{ name: 'spring', segment: {}, frequency_cap_days: 7, starts_at: 1 }], http);
    expect(summary).toEqual([]);
    expect(plan.warnings.join(' ')).toContain('frequency_cap_days cannot be changed in place');
  });
});

describe('step_up_policies', () => {
  it('matches by name and patches only what drifted', async () => {
    const live = { id: 'supol_1', name: 'wire_transfer', description: null, enabled: true, max_age_seconds: 300, required_acr: [], required_amr: [], required_amr_any: [], phishing_resistant: false, allowed_methods: [], receipt_ttl_seconds: 60 };
    const http = new Http({ '/v1/step_up/policies': [live] });
    const same = await run('step_up_policies', [{ name: 'wire_transfer', max_age_seconds: 300, phishing_resistant: false }], http);
    expect(same.summary).toEqual([]);
    const drift = await run('step_up_policies', [{ name: 'wire_transfer', max_age_seconds: 120, phishing_resistant: true, allowed_methods: ['passkey'] }], http);
    expect(drift.summary.length).toBeGreaterThan(0);
    expect(http.calls.some((c) => c.method === 'PATCH' && c.path === '/v1/step_up/policies/supol_1')).toBe(true);
  });
  it('creates a missing policy', async () => {
    const http = new Http({ '/v1/step_up/policies': [] });
    await run('step_up_policies', [{ name: 'export_data', max_age_seconds: 600 }], http);
    expect(http.calls).toContainEqual({ method: 'POST', path: '/v1/step_up/policies', body: { name: 'export_data', max_age_seconds: 600 } });
  });
});

describe('mfa_campaigns', () => {
  it('warns instead of failing when the target differs, and ignores ended campaigns', async () => {
    const http = new Http({
      '/v1/mfa_campaigns': [
        { id: 'mfacp_1', name: 'staff', target_type: 'group', target_value: 'staff', required_factors: ['totp'], starts_at: 1, grace_until: null, nag_interval_days: 3, enforce: false, status: 'active' },
        { id: 'mfacp_0', name: 'old', target_type: 'all', target_value: null, required_factors: [], starts_at: 1, grace_until: null, nag_interval_days: 3, enforce: false, status: 'ended' },
      ],
    });
    const { plan } = await run('mfa_campaigns', [{ name: 'staff', target_type: 'org', target_value: 'org_1', required_factors: ['totp'], starts_at: 1, nag_interval_days: 3, enforce: false }], http);
    expect(plan.warnings.join(' ')).toContain('target_type cannot be changed in place');
  });
});

describe('policy_settings and policy_source', () => {
  it('patches the settings and puts the source, never reading the signing secret back', async () => {
    const http = new Http({}, { '/v1/instance/policy_settings': { session_claim: false }, '/v1/instance/policy_source': { enabled: false, endpoint_url: null, signing_secret_set: true, sync: 'webhook', poll_interval_minutes: 60 } });
    await run('policy_settings', { session_claim: true }, http);
    await run('policy_source', { enabled: true, endpoint_url: 'https://policies.example.com/p', signing_secret: '${TOKEN}', sync: 'poll' }, http);
    expect(http.calls[0]).toEqual({ method: 'PATCH', path: '/v1/instance/policy_settings', body: { session_claim: true } });
    expect(http.calls[1]).toEqual({ method: 'PUT', path: '/v1/instance/policy_source', body: { enabled: true, endpoint_url: 'https://policies.example.com/p', signing_secret: 'tok-value', sync: 'poll' } });
  });
});

describe('actions and action_bindings', () => {
  const rows = [
    { id: 'act_1', name: 'tag', trigger: 'post_login', code: 'x', runtime: 'node', enabled: true, secret_names: ['K'], http_target: null },
    { id: 'act_2', name: 'audit', trigger: 'post_login', code: 'y', runtime: 'node', enabled: true, secret_names: [], http_target: null },
  ];

  it('never exports secrets and does not compare them', async () => {
    const http = new Http({ '/v1/actions': rows });
    const live = await liveOf('actions', http);
    expect(JSON.stringify(live)).not.toContain('secret');
    const { summary } = await run('actions', [{ name: 'tag', code: 'x', secrets: { K: '${TOKEN}' } }], http);
    expect(summary).toEqual([]);
  });

  it('creates an action with a trigger that stays fixed', async () => {
    const http = new Http({ '/v1/actions': [] });
    await run('actions', [{ name: 'tag', trigger: 'post_login', code: 'x', secrets: { K: '${TOKEN}' } }], http);
    expect(http.calls).toEqual([{ method: 'POST', path: '/v1/actions', body: { name: 'tag', trigger: 'post_login', code: 'x', secrets: { K: 'tok-value' } } }]);
  });

  it('binds actions by name, in order', async () => {
    const http = new Http({ '/v1/actions': rows }, { '/v1/actions/bindings/post_login': { action_ids: ['act_1'] } });
    const { summary } = await run('action_bindings', [{ trigger: 'post_login', actions: ['audit', 'tag'] }], http);
    expect(summary).toEqual(['update action_bindings post_login']);
    expect(http.calls).toEqual([{ method: 'PUT', path: '/v1/actions/bindings/post_login', body: { action_ids: ['act_2', 'act_1'] } }]);
  });

  it('refuses a binding that names an unknown action', async () => {
    const http = new Http({ '/v1/actions': rows }, { '/v1/actions/bindings/post_login': { action_ids: [] } });
    await expect(run('action_bindings', [{ trigger: 'post_login', actions: ['nope'] }], http)).rejects.toThrow(/no post_login action named "nope"/);
  });
});

describe('journeys', () => {
  it('reads each definition from the item route', async () => {
    const def = { start: 'a' };
    const http = new Http({ '/v1/flows': [{ id: 'flw_1', name: 'main' }] }, { '/v1/flows/flw_1': { id: 'flw_1', name: 'main', enabled: true, definition: def } });
    expect((await run('journeys', [{ name: 'main', enabled: true, definition: def }], http)).summary).toEqual([]);
    const { summary } = await run('journeys', [{ name: 'main', definition: { start: 'b' } }], http);
    expect(summary).toEqual(['update journeys main']);
    expect(http.calls).toEqual([{ method: 'PATCH', path: '/v1/flows/flw_1', body: { definition: { start: 'b' } } }]);
  });
});

describe('workflows and alert_rules', () => {
  it('create and update through their collection routes', async () => {
    const http = new Http({ '/v1/workflows': [{ id: 'wf_1', name: 'a', enabled: true }], '/v1/analytics/alert_rules': [] });
    await run('workflows', [{ name: 'a', enabled: false }], http);
    await run('alert_rules', [{ name: 'spike', metric: 'sign_in_failures', comparator: 'gt', threshold: 5, email_contacts: ['ops@example.com'] }], http);
    expect(http.calls[0]).toEqual({ method: 'PATCH', path: '/v1/workflows/wf_1', body: { enabled: false } });
    expect(http.calls[1]).toMatchObject({ method: 'POST', path: '/v1/analytics/alert_rules', body: { name: 'spike', threshold: 5 } });
  });
});

describe('app_event_types', () => {
  it('leaves third-party types (with a required scope) alone', async () => {
    const http = new Http({ '/v1/app_event_types': [{ id: 'aet_1', type: 'call.done', description: 'd', deprecated: false, required_scope: null }, { id: 'aet_2', type: 'app.thing', required_scope: 'read' }] });
    const { summary } = await run('app_event_types', [{ type: 'call.done', description: 'd2' }], http, { prune: true, pruneTypes: ['app_event_types'] });
    expect(summary).toEqual(['update app_event_types call.done']);
    expect(http.calls).toEqual([{ method: 'PATCH', path: '/v1/app_event_types/call.done', body: { description: 'd2' } }]);
  });
});

describe('audit_event_schemas', () => {
  it('keys by action and version; only description and status change in place', async () => {
    const row = { id: 'aes_1', action: 'invoice.sent', version: 2, description: 'a', target_types: ['invoice'], actor_types: [], metadata_schema: { type: 'object' }, status: 'active' };
    const http = new Http({ '/v1/audit_event_schemas': [row] });
    const { summary, plan } = await run('audit_event_schemas', [{ ...row, id: undefined, description: 'b', metadata_schema: { type: 'object', required: ['x'] } } as never], http);
    expect(summary).toEqual(['update audit_event_schemas invoice.sent/2']);
    expect(http.calls).toEqual([{ method: 'PATCH', path: '/v1/audit_event_schemas/aes_1', body: { description: 'b', status: 'active' } }]);
    expect(plan.warnings.join(' ')).toContain('metadata_schema cannot be changed in place');
  });
});

describe('log_streams and audit_exports', () => {
  it('never exports secret markers and compares only what the server returns', async () => {
    const row = { id: 'ls_1', name: 'dd', type: 'datadog', enabled: true, event_filter: null, destination: { site: 'datadoghq.com', has_api_key: true } };
    const http = new Http({ '/v1/log_streams': [row] });
    const live = (await liveOf('log_streams', http)) as Array<{ config: Record<string, Json> }>;
    expect(live[0]!.config.destination).toEqual({ site: 'datadoghq.com' });
    expect((await run('log_streams', [{ name: 'dd', type: 'datadog', enabled: true, destination: { site: 'datadoghq.com', api_key: '${TOKEN}' } }], http)).summary).toEqual([]);
    const { summary } = await run('log_streams', [{ name: 'dd', type: 'datadog', enabled: false }], http);
    expect(summary).toEqual(['update log_streams dd']);
    expect(http.calls).toEqual([{ method: 'PATCH', path: '/v1/log_streams/ls_1', body: { enabled: false } }]);
  });

  it('sends create-only fields on create but never on update', async () => {
    const http = new Http({ '/v1/audit_exports': [{ id: 'ae_1', name: 'siem', type: 'webhook', enabled: true, action_filter: null, destination: { url: 'https://x.example.com', has_secret: true } }] });
    await run('audit_exports', [{ name: 'siem', type: 'webhook', enabled: true, backfill_hours: 24, destination: { url: 'https://y.example.com' } }, { name: 'new', type: 'webhook', backfill_hours: 6, destination: { url: 'https://z.example.com' } }], http);
    expect(http.calls).toContainEqual({ method: 'PATCH', path: '/v1/audit_exports/ae_1', body: { destination: { url: 'https://y.example.com' }, enabled: true } });
    expect(http.calls).toContainEqual({ method: 'POST', path: '/v1/audit_exports', body: { name: 'new', type: 'webhook', destination: { url: 'https://z.example.com' }, backfill_hours: 6 } });
  });
});

describe('audit_retention', () => {
  const view = (configured: boolean, days: number) => ({ retention_days: days, configured, default_days: 365 });

  it('treats the default length as already set', async () => {
    const http = new Http({}, { '/v1/audit_retention': view(false, 365) });
    expect((await run('audit_retention', { retention_days: 365 }, http)).summary).toEqual([]);
  });

  it('sends confirm_deletion only when the file carries it', async () => {
    const http = new Http({}, { '/v1/audit_retention': view(true, 365) });
    await run('audit_retention', { retention_days: 90, confirm_deletion: true }, http);
    expect(http.calls).toEqual([{ method: 'PUT', path: '/v1/audit_retention', body: { retention_days: 90, confirm_deletion: true } }]);
  });
});

describe('telemetry_export', () => {
  it('never reads the headers back', async () => {
    const http = new Http({}, { '/v1/telemetry_export': { enabled: true, endpoint: 'https://otel.example.com', has_headers: true, service_name: 'atlas', traces: true, metrics: false } });
    const { summary } = await run('telemetry_export', { enabled: true, endpoint: 'https://otel.example.com', headers: { Authorization: '${TOKEN}' } }, http);
    expect(summary).toEqual([]);
  });
});
