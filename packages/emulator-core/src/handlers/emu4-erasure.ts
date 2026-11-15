/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Engine, RouteContext, RouteDef } from '../engine';
import { notFound } from '../errors';
import type { Obj } from '../openapi';
import { Table } from '../store';
import { dsrRows, erasureHooks, view as dsrView } from './emu3-misc';
import { activeHold, engineState } from './support';
import { audit, actorOf, bad, conflict, DAY, instanceConfig, isObj, pageReply, listOf } from './emu4-shared';
import { eraseCookieRecordsOfUser } from './emu4-cookies';

/**
 * Data-rights operations: the request board (assignee, priority, labels, notes), downstream erasure connectors (a catalog of
 * known systems; modes ack, manual and api), per-request connector results with a probe, a dry run and a retry, and the signed
 * compliance posture and record-of-processing reports. API connectors call stub vendors that the emulator owns
 * (`/__emulator/compliance/erasure_vendors/...`); no network is touched and a saved key is never echoed anywhere.
 */
const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
const KEY_RE = /^[a-z][a-z0-9_-]{0,47}$/;
const LABEL_RE = /^[a-z0-9][a-z0-9_.:-]{0,31}$/;

type Method = 'api' | 'dashboard' | 'support_request';
const cat = (id: string, name: string, category: string, method: Method, identifier: 'email' | 'user_id' | 'device_id', instructions: string, holds: string[]) => ({ id, name, category, method, identifier, instructions, holds });
const CATALOG = [
  cat('stripe', 'Stripe', 'payments', 'api', 'email', 'Delete the customer object through the API; payment records the law requires you to keep stay as retained records.', ['name', 'email', 'billing address', 'payment method tokens']),
  cat('paddle', 'Paddle', 'payments', 'support_request', 'email', 'Ask the vendor to erase the customer record; it keeps transaction records it must keep as the merchant of record.', ['name', 'email', 'billing address']),
  cat('brevo', 'Brevo', 'email', 'api', 'email', 'Delete the contact; also remove it from lists and the transactional log.', ['email', 'name', 'message log']),
  cat('mailchimp', 'Mailchimp', 'email', 'api', 'email', 'Archive then permanently delete the audience member.', ['email', 'name', 'tags']),
  cat('sendgrid', 'SendGrid', 'email', 'dashboard', 'email', 'Delete the contact and clear the activity feed entries for the address.', ['email', 'message log']),
  cat('postmark', 'Postmark', 'email', 'dashboard', 'email', 'Delete message content for the recipient and remove suppressions you no longer need.', ['email', 'message log']),
  cat('resend', 'Resend', 'email', 'dashboard', 'email', 'Delete the contact and the sent-email records for the address.', ['email', 'message log']),
  cat('customerio', 'Customer.io', 'marketing', 'api', 'user_id', 'Suppress then delete the person by id.', ['email', 'attributes', 'event history']),
  cat('twilio', 'Twilio', 'sms', 'dashboard', 'email', 'Delete message logs that carry the number; keep only what telecom rules require.', ['phone number', 'message log']),
  cat('vonage', 'Vonage', 'sms', 'support_request', 'email', 'Ask the vendor to purge message logs for the number.', ['phone number', 'message log']),
  cat('segment', 'Segment', 'analytics', 'api', 'user_id', 'Submit a regulation request for the user id; it forwards to connected destinations.', ['user id', 'traits', 'event history']),
  cat('mixpanel', 'Mixpanel', 'analytics', 'api', 'user_id', 'Submit a data deletion task for the distinct id.', ['user id', 'event history']),
  cat('amplitude', 'Amplitude', 'analytics', 'api', 'user_id', 'Submit a deletion job for the user id.', ['user id', 'event history']),
  cat('posthog', 'PostHog', 'analytics', 'api', 'user_id', 'Delete the person and their events by distinct id.', ['user id', 'event history', 'session recordings']),
  cat('googleanalytics', 'Google Analytics', 'analytics', 'dashboard', 'user_id', 'Use the user deletion request for the client or user id.', ['client id', 'event history']),
  cat('hubspot', 'HubSpot', 'crm', 'api', 'email', 'Permanently delete the contact (the GDPR delete, not an archive).', ['email', 'name', 'activity timeline']),
  cat('salesforce', 'Salesforce', 'crm', 'api', 'email', 'Delete the lead or contact and clear it from the recycle bin.', ['email', 'name', 'activity history']),
  cat('intercom', 'Intercom', 'support', 'api', 'email', 'Permanently delete the contact.', ['email', 'name', 'conversations']),
  cat('zendesk', 'Zendesk', 'support', 'api', 'email', 'Permanently delete the user and their tickets or redact them.', ['email', 'name', 'tickets']),
  cat('helpscout', 'Help Scout', 'support', 'dashboard', 'email', 'Delete the customer and their conversations.', ['email', 'name', 'conversations']),
  cat('sentry', 'Sentry', 'monitoring', 'api', 'user_id', 'Delete events for the user id and scrub the user from issues.', ['user id', 'ip address', 'event payloads']),
  cat('datadog', 'Datadog', 'monitoring', 'support_request', 'user_id', 'Ask support to purge logs carrying the user id; set retention short to limit exposure.', ['user id', 'logs']),
  cat('s3', 'Object storage (S3-compatible)', 'storage', 'api', 'user_id', 'Delete objects under the user prefix, including versions and backups on the lifecycle.', ['uploaded files']),
  cat('warehouse', 'Data warehouse', 'data_warehouse', 'api', 'user_id', 'Run the deletion for the user id across tables, snapshots and exports.', ['user id', 'event history', 'derived tables']),
];

interface Vendor { id: string; name: string; identifier: 'email' | 'user_id'; credentialHelp: string; settings: Array<{ key: string; required: boolean; pattern: RegExp; description: string }> }
const VENDORS: Vendor[] = [
  { id: 'stripe', name: 'Stripe', identifier: 'email', credentialHelp: 'A restricted key that can read and delete customers.', settings: [] },
  { id: 'hubspot', name: 'HubSpot', identifier: 'email', credentialHelp: 'A private app access token with the contacts scopes (it can permanently delete contacts).', settings: [] },
  { id: 'mailchimp', name: 'Mailchimp', identifier: 'email', credentialHelp: 'A Mailchimp API key (it ends with the data center, like -us21).', settings: [{ key: 'list_id', required: true, pattern: /^[A-Za-z0-9]{6,20}$/, description: 'The audience (list) id the members live in.' }] },
  { id: 'segment', name: 'Segment', identifier: 'user_id', credentialHelp: 'A Segment Public API token that can create regulations.', settings: [{ key: 'region', required: false, pattern: /^(us|eu)$/, description: 'us (default) or eu.' }] },
  { id: 'intercom', name: 'Intercom', identifier: 'email', credentialHelp: 'An Intercom access token that can read and delete contacts.', settings: [{ key: 'region', required: false, pattern: /^(us|eu|au)$/, description: 'us (default), eu or au.' }] },
  { id: 'zendesk', name: 'Zendesk', identifier: 'email', credentialHelp: 'A Zendesk API token for that agent (it needs permission to delete users permanently).', settings: [{ key: 'subdomain', required: true, pattern: /^[a-z0-9][a-z0-9-]{0,62}$/, description: 'Your Zendesk subdomain (the part before .zendesk.com).' }, { key: 'agent_email', required: true, pattern: /^[^\s@]{1,64}@[^\s@]{1,255}$/, description: 'The agent email the API token belongs to.' }] },
  { id: 'brevo', name: 'Brevo', identifier: 'email', credentialHelp: 'A Brevo API key (v3).', settings: [] },
  { id: 'customerio', name: 'Customer.io', identifier: 'user_id', credentialHelp: 'The Track API key for that site id.', settings: [{ key: 'site_id', required: true, pattern: /^[A-Za-z0-9]{1,64}$/, description: 'The workspace site id.' }, { key: 'region', required: false, pattern: /^(us|eu)$/, description: 'us (default) or eu.' }] },
];
const vendorOf = (id: string | null | undefined): Vendor | undefined => VENDORS.find((v) => v.id === id);

function readVendorConfig(v: Vendor, raw: unknown): Record<string, string> {
  const src = isObj(raw) ? raw : {};
  const out: Record<string, string> = {};
  for (const k of Object.keys(src)) if (!v.settings.some((s) => s.key === k)) throw new Error(`${v.name} has no setting "${k}".`);
  for (const s of v.settings) {
    const x = src[s.key];
    if (x === undefined || x === null || x === '') {
      if (s.required) throw new Error(`${v.name} needs config.${s.key}: ${s.description}`);
      continue;
    }
    if (typeof x !== 'string' || !s.pattern.test(x)) throw new Error(`config.${s.key} is not valid: ${s.description}`);
    out[s.key] = x;
  }
  return out;
}

/** The stub vendor the emulator plays for an api connector: which keys it accepts, what it holds, how it fails, and a call log without keys. */
interface VendorStub { valid_keys: string[] | null; records: Record<string, number>; fail_status: number | null; calls: Obj[] }
interface State {
  connectors: Table;
  /** The vendor key of a connector: write-only, never presented, never snapshotted. */
  credentials: Map<string, string>;
  tasks: Map<string, Obj>;
  notes: Table;
  stubs: Map<string, VendorStub>;
  acks: Set<string>;
  reports: Table;
}
const st = engineState((e: Engine): State => ({ connectors: new Table('erasure_connectors', e.clock.now, 'ec'), credentials: new Map(), tasks: new Map(), notes: new Table('dsr_notes', e.clock.now, 'dsrn'), stubs: new Map(), acks: new Set(), reports: new Table('compliance_reports', e.clock.now, 'crep') }));
const stub = (e: Engine, vendor: string): VendorStub => {
  let s = st(e).stubs.get(vendor);
  if (!s) st(e).stubs.set(vendor, (s = { valid_keys: null, records: {}, fail_status: null, calls: [] }));
  return s;
};

const presentConnector = (e: Engine, c: Obj): Obj => ({
  object: 'erasure_connector', id: c.id, key: c.key, catalog_id: c.catalog_id ?? null, name: c.name, mode: c.mode, ack_source: c.ack_source ?? null, enabled: c.enabled, notes: c.notes ?? null,
  vendor: c.vendor ?? null, config: c.config ?? {}, has_credential: st(e).credentials.has(c.id), created_at: c.created_at, updated_at: c.updated_at,
});

function readConnector(e: Engine, b: Obj, existing?: Obj): { row: Obj; credential: string | null | undefined } {
  const out: Obj = { key: existing?.key ?? '', catalog_id: existing?.catalog_id ?? null, name: existing?.name ?? '', mode: existing?.mode ?? 'ack', ack_source: existing?.ack_source ?? null, enabled: existing?.enabled ?? true, notes: existing?.notes ?? null, vendor: existing?.vendor ?? null, config: existing?.config ?? {} };
  if (b.catalog_id !== undefined && b.catalog_id !== null) {
    const entry = CATALOG.find((x) => x.id === b.catalog_id);
    if (!entry) throw bad('catalog_id is not in the erasure connector catalog (GET /v1/erasure_connector_catalog).', 'catalog_id');
    out.catalog_id = entry.id;
    if (!existing) { out.key = entry.id; out.name = entry.name; }
  }
  if (b.key !== undefined) {
    if (existing && b.key !== existing.key) throw bad('key cannot change.', 'key');
    if (typeof b.key !== 'string' || !KEY_RE.test(b.key)) throw bad('key is a slug: lowercase letters, digits, - and _, starting with a letter (at most 48).', 'key');
    out.key = b.key;
  }
  if (b.name !== undefined) {
    if (typeof b.name !== 'string' || !b.name.trim() || b.name.length > 120) throw bad('name is required text of at most 120 characters.', 'name');
    out.name = b.name.trim();
  }
  if (b.mode !== undefined) {
    if (b.mode !== 'ack' && b.mode !== 'manual' && b.mode !== 'api') throw bad('mode is ack, manual or api.', 'mode');
    out.mode = b.mode;
  }
  if (b.ack_source !== undefined) {
    if (b.ack_source !== null && (typeof b.ack_source !== 'string' || !b.ack_source.trim() || b.ack_source.length > 200)) throw bad('ack_source is text of at most 200 characters, or null.', 'ack_source');
    out.ack_source = b.ack_source === null ? null : b.ack_source.trim();
  }
  if (b.enabled !== undefined) {
    if (typeof b.enabled !== 'boolean') throw bad('enabled is a boolean.', 'enabled');
    out.enabled = b.enabled;
  }
  if (b.notes !== undefined) {
    if (b.notes !== null && (typeof b.notes !== 'string' || b.notes.length > 1000)) throw bad('notes is text of at most 1000 characters, or null.', 'notes');
    out.notes = b.notes;
  }
  if (b.vendor !== undefined && b.vendor !== null) out.vendor = b.vendor;
  if (b.vendor === undefined && out.mode === 'api' && !out.vendor && out.catalog_id && vendorOf(out.catalog_id)) out.vendor = out.catalog_id;
  let credential: string | null | undefined;
  if (out.mode === 'api') {
    const vendor = vendorOf(out.vendor);
    if (!vendor) throw bad('mode api needs a vendor: stripe, hubspot, mailchimp, segment, intercom, zendesk, brevo or customerio.', 'vendor');
    try {
      out.config = readVendorConfig(vendor, b.config === undefined ? out.config : (b.config ?? {}));
    } catch (err) {
      throw bad(err instanceof Error ? err.message : 'config is not valid.', 'config');
    }
    if (b.credential !== undefined) {
      if (typeof b.credential !== 'string' || !b.credential.trim() || b.credential.length > 2000) throw bad('credential is your key for the vendor (at most 2000 characters).', 'credential');
      credential = b.credential.trim();
    }
    if (credential === undefined && !(existing && st(e).credentials.has(existing.id))) throw bad(`mode api needs credential: ${vendor.credentialHelp}`, 'credential');
  } else {
    if (b.credential !== undefined && b.credential !== null) throw bad('credential is only for mode api.', 'credential');
    out.vendor = null;
    out.config = {};
    credential = null;
  }
  if (!out.key) throw bad('Send key (or catalog_id to take the catalog entry).', 'key');
  if (!out.name) throw bad('name is required.', 'name');
  if (out.mode === 'ack' && !out.ack_source) out.ack_source = out.key;
  return { row: out, credential };
}

const CONNECTOR_FIELDS = ['key', 'catalog_id', 'name', 'mode', 'ack_source', 'enabled', 'notes', 'vendor', 'config', 'credential'];
const knownFields = (b: Obj, allowed: string[]) => {
  const k = Object.keys(b).find((x) => !allowed.includes(x));
  if (k) throw bad(`Unrecognised field ${k}. Expected any of ${allowed.join(', ')}.`, k);
};

// ── running a vendor ──

const emailsOf = (e: Engine, userId: string): string[] => [...new Set(((e.db.users.get(userId)?.emails as Obj[]) ?? []).map((m) => String(m.email_address).toLowerCase()))];

function vendorCall(e: Engine, connector: Obj, action: 'probe' | 'erase', identifier?: string): { erased: number } {
  const vendor = vendorOf(connector.vendor)!;
  const s = stub(e, vendor.id);
  const key = st(e).credentials.get(connector.id);
  const log = (status: number) => s.calls.push({ at: e.clock.now(), action, connector_id: connector.id, identifier_hash: identifier ? identifier.length : null, status, key_accepted: status !== 401 });
  if (!key) throw new Error('This connector has no key saved.');
  if (s.valid_keys && !s.valid_keys.includes(key)) {
    log(401);
    throw new Error(`${vendor.name} refused the key (HTTP 401).`);
  }
  if (s.fail_status) {
    log(s.fail_status);
    throw new Error(`${vendor.name} returned HTTP ${s.fail_status}.`);
  }
  log(200);
  if (action === 'probe' || !identifier) return { erased: 0 };
  const n = s.records[identifier] ?? 0;
  delete s.records[identifier];
  return { erased: n };
}

type RunResult = { connector_id: string; key: string; vendor: string; status: 'done' | 'failed' | 'dry_run'; note: string | null; error: string | null };

function runApiConnectors(e: Engine, c: RouteContext | null, input: { dsrId: string; userId: string; connectorId?: string; dryRun?: boolean }): RunResult[] {
  const s = st(e);
  const out: RunResult[] = [];
  const subject = { userId: input.userId, emails: emailsOf(e, input.userId) };
  for (const conn of s.connectors.all().reverse()) {
    if (conn.mode !== 'api' || !conn.enabled || (input.connectorId && conn.id !== input.connectorId)) continue;
    const vendor = vendorOf(conn.vendor);
    if (!vendor) continue;
    const taskKey = `${conn.id}:${input.dsrId}`;
    if (!input.dryRun && s.tasks.get(taskKey)?.status === 'done') continue;
    const row = { connector_id: conn.id, key: conn.key, vendor: vendor.id };
    try {
      if (input.dryRun) {
        vendorCall(e, conn, 'probe');
        const what = vendor.identifier === 'email' ? `${subject.emails.length} email address(es)` : 'the user id';
        out.push({ ...row, status: 'dry_run', note: `The key works. Would look up ${what} and erase what is found. Nothing was deleted.`, error: null });
        continue;
      }
      let erased = 0;
      for (const id of vendor.identifier === 'email' ? subject.emails : [subject.userId]) erased += vendorCall(e, conn, 'erase', id).erased;
      const note = erased === 0 ? `${vendor.name}: nothing found for this person.` : `${vendor.name}: ${erased} record${erased === 1 ? '' : 's'} erased.`;
      const prev = s.tasks.get(taskKey);
      s.tasks.set(taskKey, { status: 'done', note, error: null, attempts: (prev?.attempts ?? 0) + 1, completed_by: 'automatic', at: e.clock.now() });
      out.push({ ...row, status: 'done', note, error: null });
    } catch (err) {
      const error = (err instanceof Error ? err.message : 'The call failed.').slice(0, 300);
      if (!input.dryRun) {
        const prev = s.tasks.get(taskKey);
        s.tasks.set(taskKey, { status: 'failed', note: null, error, attempts: (prev?.attempts ?? 0) + 1, completed_by: 'automatic', at: e.clock.now() });
      }
      out.push({ ...row, status: input.dryRun ? 'dry_run' : 'failed', note: null, error });
    }
    if (!input.dryRun) audit(e, c, 'erasure_connector.run', 'data_subject_request', input.dsrId, { connector_id: conn.id, vendor: vendor.id, status: out[out.length - 1]!.status });
  }
  return out;
}

function downstream(e: Engine, dsrId: string): Obj {
  const dsr = dsrRows(e).get(dsrId);
  if (!dsr) throw notFound('Data subject request');
  const s = st(e);
  const acked = new Set<string>(s.acks);
  const g = e.generic.get('users/erasure_acks');
  if (g) for (const r of g.all()) if (r._parent === dsr.user_id) acked.add(String(r.source ?? r.app_id));
  const rows = s.connectors.all().reverse().filter((x) => x.enabled).map((x) => {
    const task = s.tasks.get(`${x.id}:${dsrId}`);
    const ack = x.mode === 'ack' && !!x.ack_source && (acked.has(`${dsr.user_id}:${x.ack_source}`) || acked.has(x.ack_source));
    const status = task ? (task.status === 'not_applicable' ? 'not_applicable' : task.status === 'failed' ? 'failed' : 'done') : ack ? 'done' : 'pending';
    return { connector_id: x.id, key: x.key, name: x.name, mode: x.mode, status, by: task ? (task.completed_by === 'automatic' ? 'automatic' : 'operator') : ack ? 'acknowledgement' : null, note: task?.note ?? null, error: task?.error ?? null, attempts: task?.attempts ?? 0, completed_at: task?.at ?? null };
  });
  return { object: 'downstream_erasure', request_id: dsrId, complete: rows.every((r) => r.status === 'done' || r.status === 'not_applicable'), pending: rows.filter((r) => r.status === 'pending').length, failed: rows.filter((r) => r.status === 'failed').length, connectors: rows };
}

const dsrOf = (e: Engine, id: string | undefined): Obj => {
  const r = dsrRows(e).get(id);
  if (!r) throw notFound('Data subject request');
  return r;
};

// ── reports ──

const jwtKid = (jws: string): string | null => {
  try {
    return JSON.parse(atob(jws.split('.')[0]!.replace(/-/g, '+').replace(/_/g, '/'))).kid ?? null;
  } catch {
    return null;
  }
};

function summary(e: Engine): { open: number; overdue: number; due_soon: number; unassigned: number; by_status: Record<string, number>; oldest_open_at: number | null } {
  const rows = dsrRows(e).all().map((r) => ({ r, v: dsrView(e, r) }));
  const open = rows.filter((x) => !['completed', 'rejected', 'cancelled'].includes(x.v.status));
  const by: Record<string, number> = {};
  for (const x of rows) by[x.v.status] = (by[x.v.status] ?? 0) + 1;
  return {
    open: open.length,
    overdue: open.filter((x) => x.v.overdue === true).length,
    due_soon: open.filter((x) => x.v.due_at !== null && x.v.due_at >= e.clock.now() && x.v.due_at <= e.clock.now() + 7 * DAY).length,
    unassigned: open.filter((x) => !x.r.assignee).length,
    by_status: by,
    oldest_open_at: open.length ? Math.min(...open.map((x) => x.r.requested_at)) : null,
  };
}

function posture(e: Engine): Obj {
  const c = instanceConfig(e).compliance;
  const policies = (e.generic.get('policies')?.all() ?? []).filter((p) => p.status !== 'retired');
  const connectors = st(e).connectors.all().filter((x) => x.enabled);
  const sm = summary(e);
  const holds = [...(e.generic.get('legal_holds')?.all() ?? [])].length;
  const on = (b: boolean) => (b ? 'configured' : 'not_configured');
  const controls = [
    { id: 'dsr_deadline', title: 'Data rights response deadline', status: 'configured', detail: `${c.retention.dsrDueDays} days` },
    { id: 'erasure_grace', title: 'Erasure cancellation window', status: 'configured', detail: `${c.retention.erasureGraceDays} days, personal data scrubbed ${c.retention.deletedUserGraceDays} days after deletion` },
    { id: 'ownership_transfer', title: 'Ownership hand-over before deleting a sole admin', status: on(c.retention.ownershipTransfer !== 'off'), detail: c.retention.ownershipTransfer },
    { id: 'policy_acceptance', title: 'Policy acceptance', status: on(policies.some((p) => p.required !== false)), detail: `${policies.filter((p) => p.required !== false).length} required, ${policies.length} active policies` },
    { id: 'consent_versions', title: 'Declared consent versions', status: on(c.consents.length > 0), detail: `${c.consents.length} declared` },
    { id: 'cookie_consent_store', title: 'Cookie consent store', status: on(c.cookieConsent.enabled), detail: c.cookieConsent.enabled ? `GPC ${c.cookieConsent.honorGpc ? 'honored' : 'ignored'}, re-prompt on policy change ${c.cookieConsent.policyVersion ? 'on' : 'off'}` : 'off' },
    { id: 'age_gating', title: 'Age gating and parental consent', status: on(c.minors.enabled), detail: c.minors.enabled ? `consent methods ${c.minors.consentMethods.join(', ')}, floor ${c.minors.minAssuranceLevel}` : 'off' },
    { id: 'inactive_users', title: 'Inactive-user policy', status: on(c.inactiveUsers.enabled), detail: c.inactiveUsers.enabled ? `${c.inactiveUsers.action} after ${c.inactiveUsers.afterDays} days` : 'off' },
    { id: 'record_of_processing', title: 'Record of processing', status: on(c.dataPolicy.activities.length > 0 && !!c.dataPolicy.controller.name), detail: `${c.dataPolicy.activities.length} activities` },
    { id: 'downstream_erasure', title: 'Downstream erasure tracking', status: on(connectors.length > 0), detail: `${connectors.length} systems tracked` },
    { id: 'data_region', title: 'Declared data region', status: on(!!c.dataRegion), detail: c.dataRegion ?? 'not declared' },
  ];
  const completed90 = dsrRows(e).all().filter((r) => r.status === 'completed' && r.completed_at && e.clock.now() - r.completed_at <= 90 * DAY).length;
  return {
    object: 'compliance_posture', instance_id: e.instanceId, generated_at: new Date(e.clock.now()).toISOString(), controls,
    summary: { configured: controls.filter((x) => x.status === 'configured').length, total: controls.length },
    data_rights: { open: sm.open, overdue: sm.overdue, due_in_7_days: sm.due_soon, unassigned: sm.unassigned, completed_last_90_days: completed90, active_legal_holds: Math.min(holds, 100) },
    downstream_erasure: connectors.map((x) => ({ key: x.key, name: x.name, mode: x.mode })),
  };
}

function ropa(e: Engine): Obj {
  const c = instanceConfig(e).compliance;
  const dp = c.dataPolicy;
  const findings: Array<{ code: string; message: string; activity?: string }> = [];
  if (!dp.controller.name) findings.push({ code: 'controller_missing', message: 'Name the controller in compliance.dataPolicy.controller.name.' });
  if (dp.activities.length === 0) findings.push({ code: 'no_activities', message: 'No processing activities are declared.' });
  const consentBacked = c.consents.length > 0 || c.cookieConsent.enabled;
  for (const a of dp.activities as Obj[]) {
    if (a.legalBasis === 'consent' && !consentBacked) findings.push({ code: 'consent_without_record', message: 'The legal basis is consent but no consent versions or cookie consent store are configured to record it.', activity: a.key });
    if (a.retentionDays === null || a.retentionDays === undefined) findings.push({ code: 'no_retention', message: 'No retention period: data is kept until the account is deleted.', activity: a.key });
    if ((a.transfersTo?.length ?? 0) > 0 && (a.recipients?.length ?? 0) === 0) findings.push({ code: 'transfer_without_recipient', message: 'Transfers are listed with no recipient named.', activity: a.key });
  }
  return {
    object: 'record_of_processing', instance_id: e.instanceId, generated_at: new Date(e.clock.now()).toISOString(), controller: dp.controller, processor: { name: 'Atlas', role: 'processor' }, data_region: c.dataRegion, activities: dp.activities,
    retention: { deleted_user_scrub_days: c.retention.deletedUserGraceDays, erasure_grace_days: c.retention.erasureGraceDays, anonymous_retention_days: c.retention.anonymousRetentionDays, inactive_users: c.inactiveUsers.enabled ? { action: c.inactiveUsers.action, after_days: c.inactiveUsers.afterDays } : null },
    atlas_sub_processors: [], findings,
  };
}

const presentReport = (e: Engine, r: Obj, signed = true): Obj => ({ object: 'compliance_report', id: r.id, kind: r.kind, generated_at: r.created_at, generated_by: r.generated_by, claims: r.payload, ...(signed ? { report: r.jws, kid: jwtKid(r.jws), jwks_uri: `${e.issuer}/.well-known/jwks.json` } : {}) });

let hooked = false;
export function erasureHandlers(): RouteDef[] {
  // Fulfilling an erasure runs the api connectors (a failure is recorded and never blocks it) and drops the user's cookie choices.
  if (!hooked) {
    hooked = true;
    erasureHooks.push((e, r) => {
      runApiConnectors(e, null, { dsrId: r.id, userId: r.user_id });
      eraseCookieRecordsOfUser(e, r.user_id);
    });
  }
  const READ = 'data_subject_requests:read';
  const WRITE = 'data_subject_requests:write';
  const connectorOf = (e: Engine, id: string | undefined): Obj => {
    const x = st(e).connectors.get(id);
    if (!x) throw notFound('Erasure connector');
    return x;
  };

  return [
    // ── reports ──
    { method: 'GET', pattern: '/v1/compliance/posture', scope: 'instance:read', handler: (c) => ({ body: posture(c.engine) }) },
    { method: 'GET', pattern: '/v1/compliance/ropa', scope: 'instance:read', handler: (c) => ({ body: ropa(c.engine) }) },
    { method: 'POST', pattern: '/v1/compliance/reports', scope: 'instance:write', handler: async (c) => {
      const e = c.engine;
      knownFields(c.body, ['kind']);
      const kind = c.body.kind;
      if (kind !== 'posture' && kind !== 'ropa') throw bad('kind is posture or ropa.', 'kind');
      const payload = kind === 'posture' ? posture(e) : ropa(e);
      // shortcut: signed as a JWT with the engine key (verifies against the engine JWKS), not as a typ "atlas-compliance-report+jwt" JWS.
      const jws = await e.tokens.signClaims(payload, 10 * 365 * 86_400);
      const row = st(e).reports.insert({ kind, payload, jws, generated_by: actorOf(c).id, created_at: e.clock.now() } as any);
      audit(e, c, 'compliance.report_generated', 'compliance_report', row.id, { kind });
      e.webhooks.emit('compliance.report_generated', { object: 'compliance_report', id: row.id, kind, generated_at: row.created_at });
      return { status: 201, body: presentReport(e, row) };
    } },
    { method: 'GET', pattern: '/v1/compliance/reports', scope: 'instance:read', handler: (c) => ({ body: pageReply(c, st(c.engine).reports.filter((r) => !c.query.get('kind') || r.kind === c.query.get('kind')).map((r) => presentReport(c.engine, r, false))) }) },
    { method: 'GET', pattern: '/v1/compliance/reports/:id', scope: 'instance:read', handler: (c) => {
      const r = st(c.engine).reports.get(c.params.id);
      if (!r) throw notFound('Report');
      return { body: presentReport(c.engine, r) };
    } },
    { method: 'GET', pattern: '/v1/compliance/inactive_users/preview', scope: 'users:read', handler: (c) => {
      const e = c.engine;
      const cfg = instanceConfig(e).compliance.inactiveUsers;
      const now = e.clock.now();
      const limit = Math.min(Math.max(Math.floor(Number(c.query.get('limit') ?? 20)) || 20, 1), 100);
      const last = (u: Obj): number => Math.max(u.created_at ?? 0, ...e.db.sessions.filter((s) => s.user_id === u.id).map((s) => s.last_active_at ?? 0));
      const live = e.db.users.all().filter((u) => !u.deleted && !u.banned && !activeHold(e, u.id));
      const due = live.filter((u) => last(u) <= now - cfg.afterDays * DAY).slice(0, limit);
      const dueIds = new Set(due.map((u) => u.id));
      const warn = cfg.warnDays > 0 ? live.filter((u) => last(u) <= now - (cfg.afterDays - cfg.warnDays) * DAY && !dueIds.has(u.id)).slice(0, limit) : [];
      return { body: { object: 'inactive_users_preview', enabled: cfg.enabled, action: cfg.action, after_days: cfg.afterDays, warn_days: cfg.warnDays, would_act: due.map((u) => ({ user_id: u.id, last_active_at: last(u) })), would_warn: warn.map((u) => ({ user_id: u.id, last_active_at: last(u) })), truncated: due.length >= limit || warn.length >= limit } };
    } },

    // ── the request board ──
    { method: 'GET', pattern: '/v1/dsr_console/summary', scope: READ, handler: (c) => ({ body: { object: 'dsr_console_summary', ...summary(c.engine) } }) },
    { method: 'GET', pattern: '/v1/dsr_console/requests', scope: READ, handler: (c) => {
      const e = c.engine;
      const q = (k: string) => c.query.get(k);
      let within: number | null = null;
      if (q('due_within_days') !== null) {
        within = Number(q('due_within_days'));
        if (!Number.isInteger(within) || within < 0 || within > 365) throw bad('due_within_days is a whole number from 0 to 365.', 'due_within_days');
      }
      const rows = dsrRows(e).all().filter((r) => {
        const v = dsrView(e, r);
        return (!q('status') || r.status === q('status')) && (!q('type') || r.type === q('type')) && (!q('assignee') || r.assignee === q('assignee')) && (q('unassigned') !== 'true' || !r.assignee) && (!q('priority') || (r.priority ?? 'normal') === q('priority')) && (!q('label') || (r.labels ?? []).includes(q('label'))) && (q('overdue') !== 'true' || v.overdue === true) && (within === null || (v.due_at !== null && v.due_at <= e.clock.now() + within * DAY));
      });
      return { body: pageReply(c, rows.map((r) => dsrView(e, r))) };
    } },
    { method: 'PATCH', pattern: '/v1/data_subject_requests/:id/triage', scope: WRITE, handler: (c) => {
      const e = c.engine;
      knownFields(c.body, ['assignee', 'priority', 'labels']);
      const r = dsrOf(e, c.params.id);
      const b = c.body;
      const patch: Obj = {};
      if (b.assignee !== undefined) {
        if (b.assignee !== null && (typeof b.assignee !== 'string' || !b.assignee.trim() || b.assignee.length > 200)) throw bad('assignee is a name or id of at most 200 characters, or null.', 'assignee');
        patch.assignee = b.assignee === null ? null : b.assignee.trim();
      }
      if (b.priority !== undefined) {
        if (!(PRIORITIES as readonly unknown[]).includes(b.priority)) throw bad(`priority must be one of ${PRIORITIES.join(', ')}.`, 'priority');
        patch.priority = b.priority;
      }
      if (b.labels !== undefined) {
        if (!Array.isArray(b.labels) || b.labels.length > 10 || b.labels.some((l) => typeof l !== 'string' || !LABEL_RE.test(l))) throw bad('labels is up to 10 lowercase labels (letters, digits, _ . : -).', 'labels');
        patch.labels = [...new Set(b.labels as string[])];
      }
      if (Object.keys(patch).length === 0) throw bad('Send assignee, priority or labels.', 'assignee');
      Object.assign(r, patch, { updated_at: e.clock.now() });
      audit(e, c, 'data_subject_request.triaged', 'data_subject_request', r.id, patch);
      return { body: dsrView(e, r) };
    } },
    { method: 'GET', pattern: '/v1/data_subject_requests/:id/notes', scope: READ, handler: (c) => {
      const e = c.engine;
      dsrOf(e, c.params.id);
      return { body: listOf(st(e).notes.filter((n) => n.request_id === c.params.id).reverse().map((n) => ({ object: 'dsr_note', id: n.id, request_id: n.request_id, author: n.author, body: n.body, created_at: n.created_at }))) };
    } },
    { method: 'POST', pattern: '/v1/data_subject_requests/:id/notes', scope: WRITE, handler: (c) => {
      const e = c.engine;
      knownFields(c.body, ['body']);
      dsrOf(e, c.params.id);
      const text = typeof c.body.body === 'string' ? c.body.body.trim() : '';
      if (!text || text.length > 4000) throw bad('body is required (at most 4000 characters).', 'body');
      const n = st(e).notes.insert({ request_id: c.params.id, author: actorOf(c).id, body: text, created_at: e.clock.now() } as any);
      audit(e, c, 'data_subject_request.note_added', 'data_subject_request', c.params.id!, { note_id: n.id });
      return { status: 201, body: { object: 'dsr_note', id: n.id, request_id: n.request_id, author: n.author, body: n.body, created_at: n.created_at } };
    } },

    // ── downstream erasure ──
    { method: 'GET', pattern: '/v1/erasure_connector_catalog', scope: READ, handler: () => ({ body: listOf(CATALOG.map((x) => {
      const v = vendorOf(x.id);
      return { object: 'erasure_catalog_entry', ...x, holds: [...x.holds], api_vendor: v ? { settings: v.settings.map((s) => ({ key: s.key, required: s.required, description: s.description })), credential_help: v.credentialHelp } : null };
    })) }) },
    { method: 'GET', pattern: '/v1/erasure_connectors', scope: READ, handler: (c) => ({ body: listOf(st(c.engine).connectors.all().reverse().map((x) => presentConnector(c.engine, x))) }) },
    { method: 'POST', pattern: '/v1/erasure_connectors', scope: WRITE, handler: (c) => {
      const e = c.engine;
      knownFields(c.body, CONNECTOR_FIELDS);
      const { row, credential } = readConnector(e, c.body);
      if (st(e).connectors.find((x) => x.key === row.key)) throw conflict(`An erasure connector with key "${row.key}" already exists.`);
      const now = e.clock.now();
      const made = st(e).connectors.insert({ ...row, created_at: now, updated_at: now } as any);
      if (credential) st(e).credentials.set(made.id, credential);
      audit(e, c, 'erasure_connector.created', 'erasure_connector', made.id, { key: made.key, mode: made.mode, vendor: made.vendor });
      return { status: 201, body: presentConnector(e, made) };
    } },
    { method: 'GET', pattern: '/v1/erasure_connectors/:id', scope: READ, handler: (c) => ({ body: presentConnector(c.engine, connectorOf(c.engine, c.params.id)) }) },
    { method: 'PATCH', pattern: '/v1/erasure_connectors/:id', scope: WRITE, handler: (c) => {
      const e = c.engine;
      knownFields(c.body, CONNECTOR_FIELDS);
      const x = connectorOf(e, c.params.id);
      const { row, credential } = readConnector(e, c.body, x);
      Object.assign(x, { name: row.name, mode: row.mode, ack_source: row.ack_source, enabled: row.enabled, notes: row.notes, vendor: row.vendor, config: row.config, updated_at: e.clock.now() });
      if (credential) st(e).credentials.set(x.id, credential);
      else if (credential === null) st(e).credentials.delete(x.id);
      audit(e, c, 'erasure_connector.updated', 'erasure_connector', x.id, { key: x.key, credential_changed: c.body.credential !== undefined });
      return { body: presentConnector(e, x) };
    } },
    { method: 'POST', pattern: '/v1/erasure_connectors/:id/probe', scope: WRITE, handler: (c) => {
      const e = c.engine;
      const x = connectorOf(e, c.params.id);
      const vendor = x.mode === 'api' ? vendorOf(x.vendor) : undefined;
      if (!vendor) throw bad('Only an api connector can be probed.', 'mode');
      let ok = true;
      let error: string | null = null;
      try {
        vendorCall(e, x, 'probe');
      } catch (err) {
        ok = false;
        error = err instanceof Error ? err.message : 'The probe failed.';
      }
      audit(e, c, 'erasure_connector.probed', 'erasure_connector', x.id, { ok });
      return { body: { object: 'erasure_connector_probe', connector_id: x.id, vendor: vendor.id, ok, error } };
    } },
    { method: 'DELETE', pattern: '/v1/erasure_connectors/:id', scope: WRITE, handler: (c) => {
      const e = c.engine;
      const x = connectorOf(e, c.params.id);
      st(e).connectors.delete(x.id);
      st(e).credentials.delete(x.id);
      audit(e, c, 'erasure_connector.deleted', 'erasure_connector', x.id, {});
      return { status: 204 };
    } },
    { method: 'GET', pattern: '/v1/data_subject_requests/:id/downstream', scope: READ, handler: (c) => ({ body: downstream(c.engine, c.params.id!) }) },
    { method: 'POST', pattern: '/v1/data_subject_requests/:id/downstream/:connectorId', scope: WRITE, handler: (c) => {
      const e = c.engine;
      knownFields(c.body, ['status', 'note']);
      dsrOf(e, c.params.id);
      const x = connectorOf(e, c.params.connectorId);
      if (x.mode !== 'manual') throw bad('Only a manual connector is marked by an operator; an ack connector confirms itself.', 'connector_id');
      const status = c.body.status === undefined ? 'done' : c.body.status;
      if (status !== 'done' && status !== 'not_applicable') throw bad('status is done or not_applicable.', 'status');
      if (c.body.note !== undefined && (typeof c.body.note !== 'string' || c.body.note.length > 1000)) throw bad('note is text of at most 1000 characters.', 'note');
      st(e).tasks.set(`${x.id}:${c.params.id}`, { status, note: c.body.note ?? null, error: null, attempts: 1, completed_by: actorOf(c).id ?? 'operator', at: e.clock.now() });
      audit(e, c, 'erasure_connector.task_marked', 'data_subject_request', c.params.id!, { connector_id: x.id, status });
      return { body: downstream(e, c.params.id!) };
    } },
    { method: 'POST', pattern: '/v1/data_subject_requests/:id/downstream/:connectorId/run', scope: WRITE, handler: (c) => {
      const e = c.engine;
      knownFields(c.body, ['dry_run']);
      if (c.body.dry_run !== undefined && typeof c.body.dry_run !== 'boolean') throw bad('dry_run is a boolean.', 'dry_run');
      const dsr = dsrOf(e, c.params.id);
      const x = connectorOf(e, c.params.connectorId);
      if (x.mode !== 'api') throw bad('Only an api connector runs automatically.', 'connector_id');
      if (dsr.type !== 'erasure') throw bad('Erasure connectors run for erasure requests.', 'id');
      const results = runApiConnectors(e, c, { dsrId: dsr.id, userId: dsr.user_id, connectorId: x.id, dryRun: c.body.dry_run === true });
      return { body: { object: 'erasure_connector_run', dry_run: c.body.dry_run === true, results, downstream: downstream(e, dsr.id) } };
    } },

    // ── emulator helpers ──
    // PUT /__emulator/compliance/erasure_vendors/:vendor { valid_keys?: string[] | null, records?: { <email or user id>: <count> }, fail_status?: number | null }
    { method: 'PUT', pattern: '/__emulator/compliance/erasure_vendors/:vendor', public: true, handler: (c) => {
      const e = c.engine;
      if (!vendorOf(c.params.vendor)) throw notFound('Vendor');
      const s = stub(e, c.params.vendor!);
      const b = c.body;
      if (b.valid_keys !== undefined) {
        if (b.valid_keys !== null && !(Array.isArray(b.valid_keys) && b.valid_keys.every((k) => typeof k === 'string'))) throw bad('valid_keys is a list of keys the vendor accepts, or null for any key.', 'valid_keys');
        s.valid_keys = b.valid_keys;
      }
      if (b.records !== undefined) {
        if (!isObj(b.records) || Object.values(b.records).some((n) => !Number.isInteger(n) || (n as number) < 0)) throw bad('records maps an email address or user id to a count.', 'records');
        s.records = Object.fromEntries(Object.entries(b.records).map(([k, n]) => [k.toLowerCase(), n as number]));
      }
      if (b.fail_status !== undefined) {
        if (b.fail_status !== null && !(Number.isInteger(b.fail_status) && b.fail_status >= 400 && b.fail_status <= 599)) throw bad('fail_status is an HTTP status from 400 to 599, or null.', 'fail_status');
        s.fail_status = b.fail_status;
      }
      return { body: { object: 'erasure_vendor_stub', vendor: c.params.vendor, accepts_any_key: s.valid_keys === null, records: s.records, fail_status: s.fail_status } };
    } },
    { method: 'GET', pattern: '/__emulator/compliance/erasure_vendors/:vendor/calls', public: true, handler: (c) => {
      if (!vendorOf(c.params.vendor)) throw notFound('Vendor');
      return { body: listOf([...stub(c.engine, c.params.vendor!).calls]) };
    } },
    // POST /__emulator/compliance/erasure_acks { user_id, source }: a downstream system confirming it erased the user.
    { method: 'POST', pattern: '/__emulator/compliance/erasure_acks', public: true, handler: (c) => {
      const e = c.engine;
      if (typeof c.body.user_id !== 'string' || typeof c.body.source !== 'string' || !c.body.source) throw bad('user_id and source are required.', 'source');
      st(e).acks.add(`${c.body.user_id}:${c.body.source}`);
      return { status: 201, body: { object: 'erasure_ack', user_id: c.body.user_id, source: c.body.source } };
    } },
  ];
}
