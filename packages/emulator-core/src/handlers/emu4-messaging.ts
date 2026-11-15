/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Engine, RouteContext, RouteDef } from '../engine';
import { EmulatorError, notFound } from '../errors';
import { genericHandler } from '../generic';
import type { Obj } from '../openapi';
import { Table } from '../store';
import { fromPem, certificatePublicKey, toPem } from '../sns-cert';
import { SNS_CERT_URL, receiverToken, snsStringToSign } from '../messaging-callbacks';
import { journeys } from './platform';
import { experimentBucket, experimentReadout, validateVariants, variantForBucket, type ExperimentVariant } from './emu4-journey-math';
import { keyStore } from './messaging';
import { snsState } from './emu4-sns';
import { engineState } from './support';
import { listReply } from './util';

/**
 * Round-four messaging: journeys that keep saved versions, A/B experiments over those versions, the messages a journey's
 * `send_message` steps schedule (email and text, delivered through the message sink when the engine clock reaches their
 * time), and the Amazon SNS certificate endpoints. Event names, route shapes and error messages follow the real API.
 */
const MAX_EXPERIMENTS_PER_JOURNEY = 50;
const MAX_DELAY_SECONDS = 30 * 24 * 3600;
const MAX_ATTEMPTS = 3;
const MESSAGE_STATUSES = ['pending', 'sending', 'sent', 'failed', 'canceled'];
const SNS_HOST = /^sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/;

interface FlowVersion {
  version: number;
  definition: Obj;
  created_at: number;
}
interface Journey {
  versions: Map<string, FlowVersion[]>;
  experiments: Table;
  assignments: Map<string, Obj>;
  messages: Table;
  audit: Obj[];
}
const st = engineState((e: Engine): Journey => ({ versions: new Map(), experiments: new Table('journey_experiments', e.clock.now, 'jexp'), assignments: new Map(), messages: new Table('journey_messages', e.clock.now, 'jmsg'), audit: [] }));

const bad = (message: string, param: string) => new EmulatorError('VALIDATION_FAILED', message, param);
const conflict = (message: string) => new EmulatorError('CONFLICT', message);
const flows = (e: Engine) => e.generic.get('flows');
const flowOf = (e: Engine, id: string | undefined): Obj => {
  const f = flows(e)?.get(id);
  if (!f) throw new EmulatorError('NOT_FOUND', 'Unknown journey.');
  return f;
};
const strip = ({ _parent, ...row }: Obj): Obj => row;

function audit(e: Engine, action: string, targetType: string, targetId: string, metadata: Obj = {}): void {
  st(e).audit.push({ id: e.db.newId('audit'), action, actor_type: 'api_key', target_type: targetType, target_id: targetId, ip: null, metadata, created_at: e.clock.now() });
}

// ── journey versions ─────────────────────────────────────────────────

/** Saved versions of a journey, oldest first; a journey made before versions were tracked starts at version 1 with its stored definition. */
function versionsOf(e: Engine, flow: Obj): FlowVersion[] {
  const s = st(e).versions;
  let list = s.get(flow.id);
  if (!list) {
    list = [{ version: 1, definition: flow.definition ?? {}, created_at: flow.created_at ?? e.clock.now() }];
    s.set(flow.id, list);
    flows(e)!.update(flow.id, { latest_version: 1, active_version: flow.active_version === undefined ? 1 : flow.active_version });
  }
  return list;
}
const activeDefinition = (e: Engine, flow: Obj): Obj => (flow.active_version == null ? (flow.definition ?? {}) : (versionsOf(e, flow).find((v) => v.version === flow.active_version)?.definition ?? flow.definition ?? {}));
const versionView = (v: FlowVersion): Obj => ({ object: 'sign_in_journey_version', version: v.version, definition: v.definition, created_by: null, created_at: v.created_at });

// ── experiments ──────────────────────────────────────────────────────

const experimentView = (x: Obj): Obj => ({ object: 'journey_experiment', id: x.id, journey_id: x.journey_id, name: x.name, hypothesis: x.hypothesis ?? null, status: x.status, variants: x.variants, promoted_variant: x.promoted_variant ?? null, started_at: x.started_at ?? null, stopped_at: x.stopped_at ?? null, created_at: x.created_at, updated_at: x.updated_at });
const expOf = (e: Engine, flowId: string, id: string | undefined): Obj => {
  const x = st(e).experiments.get(id);
  if (!x || x.journey_id !== flowId) throw new EmulatorError('NOT_FOUND', 'Unknown experiment.');
  return x;
};
const runningOn = (e: Engine, flowId: string): Obj | undefined => st(e).experiments.find((x) => x.journey_id === flowId && x.status === 'running');

function parseExperimentBody(e: Engine, flow: Obj, body: Obj, mode: 'create' | 'update'): { name?: string; hypothesis?: string | null; variants?: ExperimentVariant[] } {
  const KNOWN = ['name', 'hypothesis', 'variants'];
  const unknown = Object.keys(body).find((k) => !KNOWN.includes(k));
  if (unknown) throw bad(`Unrecognised field ${unknown}. Expected any of ${KNOWN.join(', ')}.`, unknown);
  const out: { name?: string; hypothesis?: string | null; variants?: ExperimentVariant[] } = {};
  if (body.name !== undefined || mode === 'create') {
    if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 100) throw bad('name is required (1-100 characters).', 'name');
    out.name = body.name.trim();
  }
  if (body.hypothesis !== undefined) {
    if (body.hypothesis !== null && (typeof body.hypothesis !== 'string' || body.hypothesis.length > 500)) throw bad('hypothesis: at most 500 characters.', 'hypothesis');
    out.hypothesis = body.hypothesis as string | null;
  }
  if (body.variants !== undefined || mode === 'create') {
    const have = new Set(versionsOf(e, flow).map((v) => v.version));
    const problem = validateVariants(body.variants, (n) => have.has(n));
    if (problem) throw bad(problem.message, problem.path);
    out.variants = body.variants as ExperimentVariant[];
  }
  return out;
}

/**
 * What a user reaching a journey runs: the version their experiment variant names when an experiment is running (the choice is stored at the first
 * visit, so later changes never move anybody), else the active version. An experiment problem never fails the sign-in.
 */
export async function journeyEntry(e: Engine, flow: Obj, userId: string): Promise<{ steps: Obj[]; version: number | null; experiment_id: string | null; variant: string | null }> {
  const plain = (): { steps: Obj[]; version: number | null; experiment_id: null; variant: null } => {
    const def = activeDefinition(e, flow);
    return { steps: (Array.isArray(def.steps) ? def.steps : flow.steps) ?? [], version: flow.active_version ?? null, experiment_id: null, variant: null };
  };
  try {
    const x = runningOn(e, flow.id);
    if (!x) return plain();
    const key = `${x.id}|${userId}`;
    let a = st(e).assignments.get(key);
    if (!a) {
      const v = variantForBucket(x.variants, await experimentBucket(x.id, userId));
      st(e).assignments.set(key, (a = { experiment_id: x.id, user_id: userId, variant: v.key, version: v.version, assigned_at: e.clock.now() }));
    }
    const def = versionsOf(e, flow).find((v) => v.version === a!.version)?.definition;
    if (!def) return plain();
    return { steps: (Array.isArray(def.steps) ? def.steps : []) as Obj[], version: a.version, experiment_id: x.id, variant: a.variant };
  } catch {
    return plain();
  }
}

function readout(e: Engine, x: Obj): Obj {
  const runs = journeys(e).runs.filter((r) => r.experiment_id === x.id);
  const counts = (x.variants as ExperimentVariant[]).map((v) => {
    const mine = runs.filter((r) => r.variant === v.key);
    const done = mine.filter((r) => r.status === 'completed');
    return { key: v.key, assigned: [...st(e).assignments.values()].filter((a) => a.experiment_id === x.id && a.variant === v.key).length, started: mine.length, completed: done.length, abandoned: mine.filter((r) => r.status === 'abandoned').length, durationMsTotal: done.reduce((n, r) => n + Math.max((r.completed_at ?? r.updated_at) - r.started_at, 0), 0) };
  });
  const byKey = new Map((x.variants as ExperimentVariant[]).map((v) => [v.key, v]));
  return {
    object: 'journey_experiment_readout',
    experiment_id: x.id,
    journey_id: x.journey_id,
    status: x.status,
    metric: 'completion',
    control: (x.variants as ExperimentVariant[])[0]?.key ?? null,
    significance_level: 0.05,
    started_at: x.started_at ?? null,
    stopped_at: x.stopped_at ?? null,
    variants: experimentReadout(counts).map((v) => ({ key: v.key, version: byKey.get(v.key)?.version ?? null, weight: byKey.get(v.key)?.weight ?? null, assigned: v.assigned, started: v.started, completed: v.completed, abandoned: v.abandoned, in_progress: v.in_progress, completion_rate: v.completion_rate, abandon_rate: v.abandon_rate, avg_duration_ms: v.avg_duration_ms, completion_interval: v.completion_interval, lift: v.lift, p_value: v.p_value, significant: v.significant })),
  };
}

// ── scheduled messages ───────────────────────────────────────────────

const messageView = (m: Obj): Obj => ({ object: 'journey_message', id: m.id, journey_id: m.journey_id, step: m.step, user_id: m.user_id, channel: m.channel, subject: m.subject, status: m.status, send_at: m.send_at, attempts: m.attempts, last_error: m.last_error ?? null, sent_at: m.sent_at ?? null, created_at: m.created_at });

/** One row per user per step and channel, ever: a second schedule of the same step changes nothing. Returns how many rows were added. */
function schedule(e: Engine, input: { journey_id: string; user_id: string; messages: Array<{ step: string; subject: string; body: string; delaySeconds: number; smsBody?: string }> }): number {
  const t = st(e).messages;
  const now = e.clock.now();
  let added = 0;
  for (const m of input.messages) {
    const base = { journey_id: input.journey_id, user_id: input.user_id, step: m.step, send_at: now + m.delaySeconds * 1000, status: 'pending', attempts: 0, last_error: null, sent_at: null, created_at: now };
    for (const row of [{ ...base, channel: 'email', subject: m.subject, body: m.body }, ...(m.smsBody ? [{ ...base, channel: 'sms', subject: '', body: m.smsBody }] : [])]) {
      if (t.find((x) => x.journey_id === row.journey_id && x.user_id === row.user_id && x.step === row.step && x.channel === row.channel)) continue;
      t.insert(row);
      added++;
    }
  }
  return added;
}

/** A run that finished the whole journey schedules the journey's `send_message` steps, each after the `delay` steps before it (the version the run followed). */
export function scheduleJourneyMessages(e: Engine, run: Obj): number {
  const flow = flows(e)?.get(run.flow_id);
  if (!flow) return 0;
  const def = (run.journey_version != null ? versionsOf(e, flow).find((v) => v.version === run.journey_version)?.definition : undefined) ?? activeDefinition(e, flow);
  let delay = 0;
  const messages: Array<{ step: string; subject: string; body: string; delaySeconds: number; smsBody?: string }> = [];
  for (const s of (Array.isArray(def.steps) ? def.steps : []) as Obj[]) {
    if (s.type === 'delay') delay = Math.min(delay + (Number(s.delay_seconds) || 0), MAX_DELAY_SECONDS);
    else if (s.type === 'send_message') messages.push({ step: String(s.id), subject: String(s.subject ?? ''), body: String(s.body ?? ''), delaySeconds: delay, ...(s.sms_body ? { smsBody: String(s.sms_body) } : {}) });
  }
  return schedule(e, { journey_id: flow.id, user_id: run.user_id, messages });
}

const fill = (text: string, vars: Record<string, string>): string => text.replace(/\{\{\s*(first_name|last_name|email|user_id)\s*\}\}/g, (_m, k: string) => vars[k] ?? '');

/** Deliver every message whose time has come on the engine clock: to the user's verified primary email or phone, through the message sink (so suppression, providers and the ledger apply). */
export function deliverDueJourneyMessages(e: Engine): { sent: number; retried: number; failed: number } {
  const out = { sent: 0, retried: 0, failed: 0 };
  const now = e.clock.now();
  const due = st(e).messages.filter((m) => m.status === 'pending' && m.send_at <= now).reverse();
  for (const m of due) {
    const flow = flows(e)?.get(m.journey_id);
    if (!flow) {
      Object.assign(m, { status: 'canceled', last_error: 'The journey was deleted.' });
      continue;
    }
    m.attempts += 1;
    const user = e.db.users.get(m.user_id);
    const data = { object: 'journey_message', journey_id: m.journey_id, user_id: m.user_id, step: m.step, channel: m.channel };
    let error: string | null = null;
    let retry = true;
    let sunk: ReturnType<Engine['messages']['send']> | undefined;
    if (!user || user.deleted || user.banned) [error, retry] = ['The user was deleted or banned.', false];
    else {
      const sms = m.channel === 'sms';
      const to = sms ? (user.phone?.verified ? user.phone.phone_number : null) : ((user.emails as Obj[]).find((x) => x.id === user.primary_email_address_id && x.verified)?.email_address ?? null);
      if (!to) [error, retry] = [sms ? 'The user has no verified phone number.' : 'The user has no verified email address.', false];
      else {
        const vars = { email: sms ? '' : to, first_name: user.first_name ?? '', last_name: user.last_name ?? '', user_id: user.id };
        sunk = e.messages.send({ channel: m.channel, to, ...(sms ? {} : { subject: fill(m.subject, vars) }), body: fill(m.body, vars), meta: { template: 'journey_message', journey_id: m.journey_id, step: m.step, message_id: m.id } });
        if (sunk.id === 0) error = 'The message was not delivered (suppressed, or the provider failed).';
      }
    }
    if (!error) {
      Object.assign(m, { status: 'sent', sent_at: now, last_error: null });
      e.webhooks.emit('journey.message_sent', { ...data, message_id: m.id, at: now });
      out.sent++;
    } else if (retry && m.attempts < MAX_ATTEMPTS) {
      Object.assign(m, { last_error: error, send_at: now + m.attempts * 10 * 60_000 });
      out.retried++;
    } else {
      Object.assign(m, { status: 'failed', last_error: error });
      e.webhooks.emit('journey.message_failed', { ...data, reason: retry ? 'Delivery failed after retries.' : error, at: now });
      out.failed++;
    }
  }
  return out;
}

// ── routes ───────────────────────────────────────────────────────────

const pemOf = (b: Uint8Array) => toPem('PRIVATE KEY', b);

export function emu4MessagingHandlers(): RouteDef[] {
  const exp = (c: RouteContext) => {
    const flow = flowOf(c.engine, c.params.id);
    return { flow, x: expOf(c.engine, flow.id, c.params.experimentId) };
  };
  const withDef = (e: Engine, flow: Obj): Obj => ({ ...strip(flow), definition: activeDefinition(e, flow) });

  return [
    // ── journey versions (what experiments run) ──
    {
      method: 'POST',
      pattern: '/v1/flows',
      scope: 'actions:write',
      handler: (c) => {
        const e = c.engine;
        const r = genericHandler(c);
        const row = flows(e)!.get((r.body as Obj).id)!;
        const def = (c.body.definition as Obj | undefined) ?? row.definition ?? {};
        st(e).versions.set(row.id, [{ version: 1, definition: def, created_at: e.clock.now() }]);
        flows(e)!.update(row.id, { definition: def, enabled: c.body.enabled ?? true, latest_version: 1, active_version: c.body.activate === false ? null : 1 });
        audit(e, 'sign_in_journey.created', 'sign_in_journey', row.id, { version: 1 });
        return { status: 201, body: strip(flows(e)!.get(row.id)!) };
      },
    },
    {
      method: 'PATCH',
      pattern: '/v1/flows/:id',
      scope: 'actions:write',
      handler: (c) => {
        const e = c.engine;
        const before = flowOf(e, c.params.id);
        const list = versionsOf(e, before);
        genericHandler(c);
        const row = flows(e)!.get(before.id)!;
        let { latest_version: latest, active_version: active } = row;
        if (c.body.definition && typeof c.body.definition === 'object') {
          list.push({ version: (latest = (latest ?? list.length) + 1), definition: c.body.definition as Obj, created_at: e.clock.now() });
          if (c.body.activate !== false) active = latest;
        }
        flows(e)!.update(row.id, { latest_version: latest, active_version: active, ...(typeof c.body.enabled === 'boolean' ? { enabled: c.body.enabled } : {}) });
        flows(e)!.update(row.id, { definition: activeDefinition(e, flows(e)!.get(row.id)!) });
        audit(e, 'sign_in_journey.updated', 'sign_in_journey', row.id, { fields: Object.keys(c.body), version: latest });
        return { body: strip(flows(e)!.get(row.id)!) };
      },
    },
    {
      method: 'GET',
      pattern: '/v1/flows/:id/versions',
      scope: 'actions:read',
      handler: (c) => ({ body: { object: 'list', data: [...versionsOf(c.engine, flowOf(c.engine, c.params.id))].reverse().map(versionView), has_more: false } }),
    },
    {
      method: 'POST',
      pattern: '/v1/flows/:id/activate',
      scope: 'actions:write',
      handler: (c) => {
        const e = c.engine;
        const flow = flowOf(e, c.params.id);
        const version = c.body.version;
        if (typeof version !== 'number' || !Number.isInteger(version)) throw bad('version must be an integer.', 'version');
        const v = versionsOf(e, flow).find((x) => x.version === version);
        if (!v) throw new EmulatorError('NOT_FOUND', 'Unknown journey version.');
        flows(e)!.update(flow.id, { active_version: version, definition: v.definition });
        audit(e, 'sign_in_journey.activated', 'sign_in_journey', flow.id, { version });
        return { body: withDef(e, flows(e)!.get(flow.id)!) };
      },
    },
    // ── experiments ──
    { method: 'GET', pattern: '/v1/flows/:id/experiments', scope: 'actions:read', handler: (c) => ({ body: { object: 'list', data: st(c.engine).experiments.filter((x) => x.journey_id === flowOf(c.engine, c.params.id).id).map(experimentView), has_more: false } }) },
    {
      method: 'POST',
      pattern: '/v1/flows/:id/experiments',
      scope: 'actions:write',
      handler: (c) => {
        const e = c.engine;
        const flow = flowOf(e, c.params.id);
        const b = parseExperimentBody(e, flow, c.body, 'create');
        if (st(e).experiments.filter((x) => x.journey_id === flow.id).length >= MAX_EXPERIMENTS_PER_JOURNEY) throw bad(`At most ${MAX_EXPERIMENTS_PER_JOURNEY} experiments per journey; delete old ones.`, 'name');
        if (st(e).experiments.find((x) => x.journey_id === flow.id && x.name === b.name)) throw bad(`An experiment named "${b.name}" already exists on this journey.`, 'name');
        const now = e.clock.now();
        const x = st(e).experiments.insert({ journey_id: flow.id, name: b.name!, hypothesis: b.hypothesis ?? null, status: 'draft', variants: b.variants!, promoted_variant: null, started_at: null, stopped_at: null, created_at: now, updated_at: now });
        audit(e, 'journey_experiment.created', 'journey_experiment', x.id, { journey_id: flow.id });
        return { status: 201, body: experimentView(x) };
      },
    },
    { method: 'GET', pattern: '/v1/flows/:id/experiments/:experimentId', scope: 'actions:read', handler: (c) => ({ body: experimentView(exp(c).x) }) },
    {
      method: 'PATCH',
      pattern: '/v1/flows/:id/experiments/:experimentId',
      scope: 'actions:write',
      handler: (c) => {
        const e = c.engine;
        const { flow, x } = exp(c);
        if (x.status !== 'draft') throw conflict('Only a draft experiment can be changed; a started experiment keeps its variants so nobody moves.');
        const b = parseExperimentBody(e, flow, c.body, 'update');
        if (b.name !== undefined && st(e).experiments.find((y) => y.journey_id === flow.id && y.name === b.name && y.id !== x.id)) throw bad(`An experiment named "${b.name}" already exists on this journey.`, 'name');
        Object.assign(x, b, { updated_at: e.clock.now() });
        audit(e, 'journey_experiment.updated', 'journey_experiment', x.id, { journey_id: flow.id, fields: Object.keys(c.body) });
        return { body: experimentView(x) };
      },
    },
    {
      method: 'DELETE',
      pattern: '/v1/flows/:id/experiments/:experimentId',
      scope: 'actions:write',
      handler: (c) => {
        const e = c.engine;
        const { flow, x } = exp(c);
        if (x.status === 'running') throw conflict('Stop a running experiment before deleting it.');
        st(e).experiments.delete(x.id);
        for (const k of [...st(e).assignments.keys()]) if (k.startsWith(`${x.id}|`)) st(e).assignments.delete(k);
        audit(e, 'journey_experiment.deleted', 'journey_experiment', x.id, { journey_id: flow.id });
        return { body: { object: 'journey_experiment', id: x.id, deleted: true } };
      },
    },
    {
      method: 'POST',
      pattern: '/v1/flows/:id/experiments/:experimentId/start',
      scope: 'actions:write',
      handler: (c) => {
        const e = c.engine;
        const { flow, x } = exp(c);
        if (x.status !== 'draft') throw conflict('Only a draft experiment can be started.');
        if (flow.enabled === false || flow.active_version == null) throw conflict('The journey must be enabled with an active version before an experiment can run on it.');
        const have = new Set(versionsOf(e, flow).map((v) => v.version));
        const problem = validateVariants(x.variants, (n) => have.has(n));
        if (problem) throw bad(problem.message, problem.path);
        if (runningOn(e, flow.id)) throw conflict('Another experiment is already running on this journey. Stop it first.');
        const now = e.clock.now();
        Object.assign(x, { status: 'running', started_at: now, updated_at: now });
        e.webhooks.emit('journey.experiment_started', { object: 'journey_experiment', experiment_id: x.id, journey_id: flow.id, variants: x.variants, at: now });
        audit(e, 'journey_experiment.started', 'journey_experiment', x.id, { journey_id: flow.id });
        return { body: experimentView(x) };
      },
    },
    {
      method: 'POST',
      pattern: '/v1/flows/:id/experiments/:experimentId/stop',
      scope: 'actions:write',
      handler: (c) => {
        const e = c.engine;
        const { flow, x } = exp(c);
        if (x.status !== 'running') throw conflict('Only a running experiment can be stopped.');
        const promote = c.body.promote_variant;
        let promoted: ExperimentVariant | undefined;
        if (promote !== undefined && promote !== null) {
          if (typeof promote !== 'string') throw bad('promote_variant must be a variant key.', 'promote_variant');
          promoted = (x.variants as ExperimentVariant[]).find((v) => v.key === promote);
          if (!promoted) throw bad(`Unknown variant "${promote}".`, 'promote_variant');
        }
        const now = e.clock.now();
        Object.assign(x, { status: 'stopped', stopped_at: now, promoted_variant: promoted?.key ?? null, updated_at: now });
        if (promoted) {
          const v = versionsOf(e, flow).find((y) => y.version === promoted!.version)!;
          flows(e)!.update(flow.id, { active_version: v.version, definition: v.definition });
        }
        e.webhooks.emit('journey.experiment_stopped', { object: 'journey_experiment', experiment_id: x.id, journey_id: flow.id, promoted_variant: promoted?.key ?? null, at: now });
        audit(e, 'journey_experiment.stopped', 'journey_experiment', x.id, { journey_id: flow.id, promoted_variant: promoted?.key ?? null });
        return { body: experimentView(x) };
      },
    },
    { method: 'GET', pattern: '/v1/flows/:id/experiments/:experimentId/readout', scope: 'actions:read', handler: (c) => ({ body: readout(c.engine, exp(c).x) }) },
    {
      // Emulator: where a user's bucket falls and which variant it picks, without assigning anybody.
      method: 'GET',
      pattern: '/__emulator/journeys/:id/experiments/:experimentId/bucket',
      public: true,
      handler: async (c) => {
        const { x } = exp(c);
        const userId = c.query.get('user_id');
        if (!userId) throw bad('user_id is required.', 'user_id');
        const bucket = await experimentBucket(x.id, userId);
        const stored = st(c.engine).assignments.get(`${x.id}|${userId}`);
        return { body: { object: 'journey_experiment_bucket', experiment_id: x.id, user_id: userId, bucket, variant: variantForBucket(x.variants, bucket).key, assigned: stored ? stored.variant : null } };
      },
    },
    // ── scheduled messages ──
    {
      method: 'GET',
      pattern: '/v1/flows/:id/messages',
      scope: 'actions:read',
      handler: (c) => {
        const e = c.engine;
        const flow = flowOf(e, c.params.id);
        const status = c.query.get('status');
        const userId = c.query.get('user_id');
        if (status !== null && !MESSAGE_STATUSES.includes(status)) throw bad(`status must be one of ${MESSAGE_STATUSES.join(', ')}.`, 'status');
        deliverDueJourneyMessages(e);
        const limit = Math.min(Math.max(Number(c.query.get('limit')) || 50, 1), 200);
        const rows = st(e).messages.filter((m) => m.journey_id === flow.id && (!status || m.status === status) && (!userId || m.user_id === userId)).slice(0, limit);
        return { body: { object: 'list', data: rows.map(messageView), has_more: false } };
      },
    },
    {
      method: 'POST',
      pattern: '/v1/flows/:id/messages/:messageId/cancel',
      scope: 'actions:write',
      handler: (c) => {
        const e = c.engine;
        const flow = flowOf(e, c.params.id);
        const m = st(e).messages.get(c.params.messageId);
        if (!m || m.journey_id !== flow.id) throw new EmulatorError('NOT_FOUND', 'Unknown message.');
        if (m.status !== 'pending' && m.status !== 'failed') throw conflict('Only a message that has not gone out (pending or failed) can be canceled.');
        m.status = 'canceled';
        audit(e, 'journey_message.canceled', 'journey_message', m.id, { journey_id: flow.id, user_id: m.user_id, step: m.step });
        return { body: messageView(m) };
      },
    },
    {
      // Emulator: the worker's delivery loop. It also runs when the clock is advanced and whenever messages are listed.
      method: 'POST',
      pattern: '/__emulator/journeys/messages/deliver',
      public: true,
      handler: (c) => ({ body: { object: 'journey_message_sweep', ...deliverDueJourneyMessages(c.engine) } }),
    },
    {
      // Emulator: schedule messages for a user without finishing a journey (the real API schedules them when a journey completes).
      method: 'POST',
      pattern: '/__emulator/journeys/:id/messages',
      public: true,
      handler: (c) => {
        const e = c.engine;
        const flow = flowOf(e, c.params.id);
        if (typeof c.body.user_id !== 'string' || !e.db.users.get(c.body.user_id)) throw notFound('User');
        const list = c.body.messages;
        if (!Array.isArray(list) || !list.length || list.length > 20) throw bad('messages is a list of 1 to 20 messages.', 'messages');
        const messages = list.map((m: Obj, i: number) => {
          if (typeof m?.step !== 'string' || !m.step) throw bad('step is required.', `messages.${i}.step`);
          if (typeof m.subject !== 'string' || !m.subject.trim() || m.subject.length > 150) throw bad('subject is required (at most 150 characters).', `messages.${i}.subject`);
          if (typeof m.body !== 'string' || !m.body.trim() || m.body.length > 5000) throw bad('body is required (at most 5000 characters).', `messages.${i}.body`);
          if (m.sms_body !== undefined && (typeof m.sms_body !== 'string' || !m.sms_body.trim() || m.sms_body.length > 320)) throw bad('sms_body: text of at most 320 characters.', `messages.${i}.sms_body`);
          const d = m.delay_seconds ?? 0;
          if (!Number.isInteger(d) || d < 0 || d > MAX_DELAY_SECONDS) throw bad(`delay_seconds: a whole number from 0 to ${MAX_DELAY_SECONDS}.`, `messages.${i}.delay_seconds`);
          return { step: m.step, subject: m.subject, body: m.body, delaySeconds: d, ...(m.sms_body ? { smsBody: m.sms_body } : {}) };
        });
        const added = schedule(e, { journey_id: flow.id, user_id: c.body.user_id, messages });
        return { status: 201, body: { object: 'journey_message_schedule', journey_id: flow.id, user_id: c.body.user_id, scheduled: added } };
      },
    },
    {
      // Emulator: users have no phone numbers of their own in this engine; this gives one to text.
      method: 'PUT',
      pattern: '/__emulator/users/:id/phone_number',
      public: true,
      handler: (c) => {
        const u = c.engine.db.users.get(c.params.id);
        if (!u || u.deleted) throw notFound('User');
        if (typeof c.body.phone_number !== 'string' || !/^\+[1-9]\d{6,14}$/.test(c.body.phone_number)) throw bad('phone_number must be an E.164 number such as +4915112345678.', 'phone_number');
        u.phone = { phone_number: c.body.phone_number, verified: c.body.verified !== false };
        return { body: { object: 'phone_number', user_id: u.id, ...u.phone } };
      },
    },
    { method: 'GET', pattern: '/__emulator/messaging/audit', public: true, handler: (c) => listReply(c, [...st(c.engine).audit].reverse() as any[], (a) => ({ object: 'audit_log_entry', ...a })) },
    // ── Amazon SNS certificates ──
    {
      // The test certificate and key: sign your own SNS messages with the private key and point SigningCertURL at signing_cert_url.
      method: 'GET',
      pattern: '/__emulator/messaging/sns',
      public: true,
      handler: async (c) => {
        const k = await keyStore(c.engine).rsa();
        const s = snsState(c.engine);
        return { body: { object: 'sns_signing_certificate', signing_cert_url: SNS_CERT_URL, certificate_pem: k.certPem, private_key_pem: pemOf(k.pkcs8), public_key: k.publicB64, signature_versions: ['1', '2'], extra_certificates: [...s.certs.keys()], subscription_confirmations: s.confirmations } };
      },
    },
    {
      // What the built-in SigningCertURL serves, as a real certificate file.
      method: 'GET',
      pattern: '/__emulator/messaging/sns/SimpleNotificationService-emulator.pem',
      public: true,
      handler: async (c) => ({ raw: (await keyStore(c.engine).rsa()).certPem, headers: { 'content-type': 'application/x-pem-file' } }),
    },
    {
      // Serve a certificate of your own at a URL SNS could use, so a message signed with your key verifies.
      method: 'PUT',
      pattern: '/__emulator/messaging/sns/certificates',
      public: true,
      handler: (c) => {
        const url = c.body.url;
        let host: URL | null = null;
        try {
          host = typeof url === 'string' ? new URL(url) : null;
        } catch {
          host = null;
        }
        if (!host || host.protocol !== 'https:' || !SNS_HOST.test(host.hostname) || host.username || host.password || (host.port && host.port !== '443')) throw bad('url must be an https URL on an sns.<region>.amazonaws.com host, as SNS signing certificates are.', 'url');
        if (typeof c.body.certificate_pem !== 'string' || !fromPem(c.body.certificate_pem, 'CERTIFICATE') || !certificatePublicKey(c.body.certificate_pem)) throw bad('certificate_pem must be an X.509 certificate in PEM form.', 'certificate_pem');
        snsState(c.engine).certs.set(host.href, c.body.certificate_pem);
        return { status: 201, body: { object: 'sns_certificate', url: host.href } };
      },
    },
    {
      method: 'DELETE',
      pattern: '/__emulator/messaging/sns/certificates',
      public: true,
      handler: (c) => {
        const url = c.query.get('url');
        if (!url || !snsState(c.engine).certs.delete(url)) throw notFound('Certificate');
        return { body: { object: 'sns_certificate', url, deleted: true } };
      },
    },
    {
      // Build an SNS message signed with the test key (a Notification, or a SubscriptionConfirmation to see the confirmation URL "visited").
      method: 'POST',
      pattern: '/__emulator/messaging/sns/sign',
      public: true,
      handler: async (c) => {
        const e = c.engine;
        const b = c.body;
        const type = b.type === undefined ? 'Notification' : b.type;
        if (type !== 'Notification' && type !== 'SubscriptionConfirmation') throw bad('type must be Notification or SubscriptionConfirmation.', 'type');
        const version = b.signature_version === undefined ? '2' : String(b.signature_version);
        if (version !== '1' && version !== '2') throw bad('signature_version must be 1 or 2.', 'signature_version');
        if (b.message !== undefined && typeof b.message !== 'string') throw bad('message must be a string (the SES notification JSON).', 'message');
        const certUrl = typeof b.signing_cert_url === 'string' ? b.signing_cert_url : SNS_CERT_URL;
        const topic = typeof b.topic_arn === 'string' ? b.topic_arn : 'arn:aws:sns:us-east-1:123456789012:atlas-emulator';
        const iso = new Date(e.clock.now()).toISOString();
        const m: Record<string, string> = { Type: type, MessageId: `sns_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`, TopicArn: topic, Message: typeof b.message === 'string' ? b.message : type === 'Notification' ? '{}' : 'You have chosen to subscribe to the topic.', Timestamp: iso, SignatureVersion: version, SigningCertURL: certUrl };
        if (type === 'SubscriptionConfirmation') {
          m.Token = 'emulator-subscription-token';
          m.SubscribeURL = typeof b.subscribe_url === 'string' ? b.subscribe_url : `https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription&TopicArn=${encodeURIComponent(topic)}&Token=${m.Token}`;
        }
        const k = await keyStore(e).rsa();
        const key = await crypto.subtle.importKey('pkcs8', k.pkcs8 as BufferSource, { name: 'RSASSA-PKCS1-v1_5', hash: version === '2' ? 'SHA-256' : 'SHA-1' }, false, ['sign']);
        const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(snsStringToSign(m)! + (b.tamper === true ? 'tampered' : '')) as BufferSource));
        let bin = '';
        for (const x of sig) bin += String.fromCharCode(x);
        m.Signature = btoa(bin);
        const token = await receiverToken(e.instanceId, 'ses');
        return { body: { object: 'messaging_callback', provider: 'ses', method: 'POST', url: `${e.issuer}/v1/webhooks/ses/${e.instanceId}?t=${token}`, headers: { 'content-type': 'application/json' }, body: JSON.stringify(m), signed_with: 'signature' } };
      },
    },
  ];
}
