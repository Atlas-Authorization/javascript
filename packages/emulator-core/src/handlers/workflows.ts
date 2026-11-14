/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Engine, RouteContext, RouteDef } from '../engine';
import { EmulatorError, notFound } from '../errors';
import type { Obj } from '../openapi';
import { Table, paginate } from '../store';
import { engineState, intIn } from './support';
import { listReply, pageOf } from './util';

/**
 * Webhook dead letters, Action versions with staged rollout, workflow runs (with cancel and retry from a step) and app
 * events (with the all-organizations broadcast). Actions and workflows themselves are the generic CRUD layer's rows; the
 * versions, runs and events here are real state on top of them.
 */
const bad = (message: string, param: string) => new EmulatorError('VALIDATION_FAILED', message, param);
const MAX_VERSIONS = 50;
const MAX_BROADCAST = 500;
const MAX_EVENT_BYTES = 256 * 1024;

interface Ops {
  acked: Set<string>;
  versions: Map<string, Obj[]>;
  runs: Table;
  events: Table;
  approvals: Map<string, Obj>;
}
const st = engineState((e: Engine): Ops => ({ acked: new Set(), versions: new Map(), runs: new Table('workflow_runs', e.clock.now, 'wfr'), events: new Table('app_events', e.clock.now, 'apev'), approvals: new Map() }));

// ── dead letters ─────────────────────────────────────────────────────

/** Exhausted deliveries of an endpoint: the last attempt for an event failed and no retry is left (attempts reached the retry budget), not yet acknowledged. */
function deadLetters(e: Engine, endpointId: string): Obj[] {
  const budget = (e.options.webhookRetryDelaysMs ?? [1000, 5000, 30000]).length + 1;
  const last = new Map<string, Obj>();
  for (const d of e.webhooks.deliveries) if (d.endpoint_id === endpointId) last.set(d.event_id, d);
  return [...last.values()].filter((d) => !d.success && d.attempt >= budget && !st(e).acked.has(d.id)).reverse();
}
const dlqView = (d: Obj): Obj => ({ object: 'webhook_dead_letter', delivery_id: d.id, event_id: d.event_id, event_type: d.event_type, attempts: d.attempt, last_status: d.response_status, last_error: d.error, failed_at: d.at });

function ids(body: Obj): string[] {
  const v = body.delivery_ids;
  if (!Array.isArray(v) || !v.length || v.length > 100 || v.some((x) => typeof x !== 'string' || !x)) throw bad('delivery_ids is a list of 1 to 100 delivery ids.', 'delivery_ids');
  return [...new Set(v as string[])];
}

// ── action versions ──────────────────────────────────────────────────

const actionOf = (e: Engine, id: string | undefined): Obj => {
  const a = e.generic.get('actions')?.get(id);
  if (!a) throw notFound('Action');
  return a;
};
const bucketOf = (actionId: string, who: string): number => {
  let h = 2166136261;
  for (const ch of `${actionId}:${who}`) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  return h % 100;
};
const versionView = (a: Obj, v: Obj): Obj => ({ object: 'action_version', action_id: a.id, version: v.version, code: v.code, note: v.note ?? null, live: a.live_version === v.version, staged: a.staged?.version === v.version, created_at: v.created_at });
const rolloutView = (a: Obj): Obj => ({ object: 'action_rollout', action_id: a.id, live_version: a.live_version ?? null, staged: a.staged ? { version: a.staged.version, percent: a.staged.percent } : null });
const snapshot = (e: Engine, a: Obj, note: string | null = null): Obj => {
  const list = st(e).versions.get(a.id) ?? [];
  if (list.length >= MAX_VERSIONS) throw new EmulatorError('CONFLICT', `An action keeps at most ${MAX_VERSIONS} versions.`);
  const v = { version: (list[list.length - 1]?.version ?? 0) + 1, code: a.code ?? '', note, created_at: e.clock.now() };
  st(e).versions.set(a.id, [...list, v]);
  return v;
};
const EGRESS = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

// ── workflow runs ────────────────────────────────────────────────────

const workflowOf = (e: Engine, id: string | undefined): Obj => {
  const w = e.generic.get('workflows')?.get(id);
  if (!w) throw notFound('Workflow');
  return w;
};
const runOf = (e: Engine, w: Obj, id: string | undefined): Obj => {
  const r = st(e).runs.get(id);
  if (!r || r.workflow_id !== w.id) throw notFound('Workflow run');
  return r;
};
const stepKey = (s: Obj, i: number): string => String(s?.id ?? s?.name ?? `step_${i}`);
const runView = (r: Obj): Obj => ({ object: 'workflow_run', id: r.id, workflow_id: r.workflow_id, status: r.status, input: r.input, vars: r.vars, steps: r.steps, current_step: r.current_step ?? null, error: r.error ?? null, started_at: r.started_at, finished_at: r.finished_at ?? null });

/** Run steps from `from` until one fails, waits for an approval, or the end. Earlier step outputs and the variables are kept. */
function advance(e: Engine, w: Obj, r: Obj, from: number): void {
  const defs: Obj[] = Array.isArray(w.steps) ? w.steps : [];
  r.status = 'running';
  for (let i = from; i < defs.length; i++) {
    const d = defs[i]!;
    const key = stepKey(d, i);
    const rec = (status: string, extra: Obj = {}) => {
      const at = r.steps.findIndex((s: Obj) => s.step === key);
      const row = { step: key, type: d.type, status, ...extra };
      if (at >= 0) r.steps[at] = row;
      else r.steps.push(row);
    };
    r.current_step = key;
    if (d.type === 'approval') {
      const id = e.db.newId('wfa');
      st(e).approvals.set(id, { id, run_id: r.id, workflow_id: w.id, step: key, status: 'pending' });
      rec('waiting_approval', { approval_id: id });
      r.status = 'waiting_approval';
      r.stopped_at = i;
      e.webhooks.emit('workflow.approval_needed', { object: 'workflow_approval', id, workflow_id: w.id, run_id: r.id, step: key });
      return;
    }
    if (d.type === 'set_variable' && typeof d.name === 'string') r.vars[d.name] = d.value ?? null;
    if (d.fail === true || r.input?.fail_step === key) {
      rec('failed', { error: 'step failed' });
      r.status = 'failed';
      r.error = `Step ${key} failed.`;
      r.stopped_at = i;
      r.finished_at = e.clock.now();
      e.webhooks.emit('workflow.run_failed', { object: 'workflow_run', id: r.id, workflow_id: w.id, step: key });
      return;
    }
    rec('succeeded', { output: d.type === 'set_variable' ? { [d.name]: d.value ?? null } : {} });
  }
  r.status = 'succeeded';
  r.current_step = null;
  r.stopped_at = defs.length;
  r.finished_at = e.clock.now();
  e.webhooks.emit('workflow.run_succeeded', { object: 'workflow_run', id: r.id, workflow_id: w.id });
}

// ── app events ───────────────────────────────────────────────────────

const eventView = (r: Obj): Obj => ({ object: 'app_event', id: r.id, type: r.type, organization_id: r.organization_id, data: r.data, idempotency_key: r.idempotency_key ?? null, endpoints: r.endpoints, created_at: r.created_at });
const orgEndpoints = (e: Engine, orgId: string): Obj[] => (e.generic.get('organizations/app_webhook_endpoints')?.filter((x) => x._parent === orgId && !x.disabled_at) ?? []);

function publishTo(e: Engine, orgId: string, type: string, data: Obj, key: string | null): { row: Obj; created: boolean } {
  const s = st(e);
  if (key) {
    const have = s.events.find((x) => x.organization_id === orgId && x.idempotency_key === key);
    if (have) return { row: have, created: false };
  }
  const row = s.events.insert({ type, organization_id: orgId, data, idempotency_key: key, endpoints: orgEndpoints(e, orgId).length, created_at: e.clock.now() });
  return { row, created: true };
}

export function workflowHandlers(): RouteDef[] {
  const endpointOf = (e: Engine, id: string | undefined): Obj => {
    const ep = e.db.endpoints.get(id);
    if (!ep) throw notFound('Webhook endpoint');
    return ep;
  };
  return [
    // ── DLQ ──
    {
      method: 'GET',
      pattern: '/v1/webhook_endpoints/:id/dlq',
      handler: (c) => {
        endpointOf(c.engine, c.params.id);
        const page = paginate(deadLetters(c.engine, c.params.id ?? '') as Array<Obj & { id: string }>, pageOf(c));
        return { body: { object: 'list', data: page.data.map(dlqView), has_more: page.has_more, next_cursor: page.next_cursor } };
      },
    },
    {
      method: 'POST',
      pattern: '/v1/webhook_endpoints/:id/dlq/ack',
      handler: (c) => {
        endpointOf(c.engine, c.params.id);
        const open = new Set(deadLetters(c.engine, c.params.id ?? '').map((d) => d.id));
        const want = ids(c.body);
        const acked = want.filter((i) => open.has(i));
        for (const i of acked) st(c.engine).acked.add(i);
        return { body: { object: 'webhook_dlq_ack', acknowledged: acked.length, not_found: want.length - acked.length } };
      },
    },
    {
      method: 'POST',
      pattern: '/v1/webhook_endpoints/:id/dlq/requeue',
      handler: async (c) => {
        const e = c.engine;
        endpointOf(e, c.params.id);
        const open = new Map(deadLetters(e, c.params.id ?? '').map((d) => [d.id, d]));
        const want = ids(c.body);
        let requeued = 0;
        for (const i of want) {
          const d = open.get(i);
          if (!d) continue;
          st(e).acked.add(i); // out of the queue; a new failure lands there again as a new delivery
          if (await e.webhooks.redeliver(c.params.id ?? '', d.event_id)) requeued++;
        }
        return { body: { object: 'webhook_dlq_requeue', requeued, not_found: want.length - requeued } };
      },
    },
    // ── action versions ──
    {
      method: 'GET',
      pattern: '/v1/actions/:id/versions',
      handler: (c) => {
        const a = actionOf(c.engine, c.params.id);
        const list = [...(st(c.engine).versions.get(a.id) ?? [])].reverse();
        return { body: { object: 'list', data: list.map((v) => versionView(a, v)), has_more: false, next_cursor: null } };
      },
    },
    {
      method: 'POST',
      pattern: '/v1/actions/:id/versions',
      handler: (c) => {
        const e = c.engine;
        const a = actionOf(e, c.params.id);
        if (c.body.note !== undefined && c.body.note !== null && (typeof c.body.note !== 'string' || c.body.note.length > 500)) throw bad('note is text up to 500 characters.', 'note');
        const v = snapshot(e, typeof c.body.code === 'string' ? { ...a, code: c.body.code } : a, c.body.note ?? null);
        if (a.live_version === undefined) a.live_version = v.version; // the first version goes live; later ones are staged or promoted
        return { status: 201, body: versionView(a, v) };
      },
    },
    {
      method: 'GET',
      pattern: '/v1/actions/:id/versions/:version',
      handler: (c) => {
        const a = actionOf(c.engine, c.params.id);
        const v = (st(c.engine).versions.get(a.id) ?? []).find((x) => String(x.version) === c.params.version);
        if (!v) throw notFound('Action version');
        return { body: versionView(a, v) };
      },
    },
    {
      // 1-99 stages the newest unpromoted version for that share of runs; 100 promotes it; 0 aborts the stage.
      method: 'PATCH',
      pattern: '/v1/actions/:id/rollout',
      handler: (c) => {
        const e = c.engine;
        const a = actionOf(e, c.params.id);
        const percent = intIn(c.body.percent, 'percent', 0, 100);
        const list = st(e).versions.get(a.id) ?? [];
        const target = a.staged?.version ?? c.body.version ?? list[list.length - 1]?.version;
        if (!list.find((v) => v.version === target)) throw new EmulatorError('CONFLICT', 'There is no version to roll out: publish one first.');
        if (percent === 0) {
          if (!a.staged) throw new EmulatorError('CONFLICT', 'No rollout is staged.');
          a.staged = null;
        } else if (percent === 100) {
          a.live_version = target;
          a.staged = null;
        } else {
          if (target === a.live_version) throw new EmulatorError('CONFLICT', 'That version is already live.');
          a.staged = { version: target, percent };
        }
        return { body: rolloutView(a) };
      },
    },
    {
      method: 'POST',
      pattern: '/v1/actions/:id/rollback',
      handler: (c) => {
        const e = c.engine;
        const a = actionOf(e, c.params.id);
        const list = st(e).versions.get(a.id) ?? [];
        const want = c.body.version === undefined ? list.filter((v) => v.version < (a.live_version ?? Infinity)).pop()?.version : intIn(c.body.version, 'version', 1, 1_000_000);
        const v = list.find((x) => x.version === want);
        if (!v) throw new EmulatorError('CONFLICT', 'There is no earlier version to roll back to.');
        a.live_version = v.version;
        a.staged = null;
        a.code = v.code;
        return { body: rolloutView(a) };
      },
    },
    {
      // A direct edit of code becomes a new live version, and is refused while a rollout is staged. Other fields update as written.
      method: 'PATCH',
      pattern: '/v1/actions/:id',
      handler: (c: RouteContext) => {
        const e = c.engine;
        const a = actionOf(e, c.params.id);
        const b = c.body;
        if (b.egress_allowlist !== undefined) {
          if (!Array.isArray(b.egress_allowlist) || b.egress_allowlist.length > 50 || b.egress_allowlist.some((h: unknown) => typeof h !== 'string' || !EGRESS.test(h))) throw bad('egress_allowlist is a list of up to 50 hosts: an exact host or *.host.', 'egress_allowlist');
        }
        if (b.code !== undefined && a.staged) throw new EmulatorError('CONFLICT', 'A rollout is staged: promote or abort it before editing the code.');
        for (const [k, v] of Object.entries(b)) if (!['id', 'object', 'created_at', 'updated_at', 'live_version', 'staged'].includes(k) && !k.startsWith('_')) a[k] = v;
        a.updated_at = e.clock.now();
        if (typeof b.code === 'string') a.live_version = snapshot(e, a, 'edit').version;
        const { _parent, staged, live_version, ...out } = a;
        return { body: { ...out, live_version: live_version ?? null, staged: staged ?? null } };
      },
    },
    {
      // Emulator: which version a run for `user_id` would use (a stable bucket per action and user; a coin toss without one).
      method: 'POST',
      pattern: '/__emulator/actions/:id/resolve',
      public: true,
      handler: (c) => {
        const a = actionOf(c.engine, c.params.id);
        const who = typeof c.body.user_id === 'string' ? c.body.user_id : String(Math.random());
        const useStaged = a.staged && bucketOf(a.id, who) < a.staged.percent;
        return { body: { version: useStaged ? a.staged.version : (a.live_version ?? null), staged: !!useStaged } };
      },
    },
    // ── workflow runs ──
    {
      method: 'POST',
      pattern: '/v1/workflows/:id/run',
      handler: (c) => {
        const e = c.engine;
        const w = workflowOf(e, c.params.id);
        if (w.enabled === false) throw new EmulatorError('CONFLICT', 'The workflow is disabled.');
        const r = st(e).runs.insert({ workflow_id: w.id, status: 'running', input: c.body.input ?? {}, vars: {}, steps: [], started_at: e.clock.now() });
        advance(e, w, r, 0);
        return { status: 202, body: runView(r) };
      },
    },
    { method: 'GET', pattern: '/v1/workflows/:id/runs', handler: (c) => listReply(c, st(c.engine).runs.filter((r) => r.workflow_id === workflowOf(c.engine, c.params.id).id && (!c.query.get('status') || r.status === c.query.get('status'))), runView) },
    { method: 'GET', pattern: '/v1/workflows/:id/runs/:runId', handler: (c) => ({ body: runView(runOf(c.engine, workflowOf(c.engine, c.params.id), c.params.runId)) }) },
    {
      method: 'POST',
      pattern: '/v1/workflows/:id/runs/:runId/resume',
      handler: (c) => {
        const e = c.engine;
        const w = workflowOf(e, c.params.id);
        const r = runOf(e, w, c.params.runId);
        if (r.status !== 'waiting_approval') throw new EmulatorError('CONFLICT', `This run is ${r.status}, not waiting for an approval.`);
        for (const a of st(e).approvals.values()) if (a.run_id === r.id && a.status === 'pending') a.status = 'approved';
        e.webhooks.emit('workflow.approval_decided', { object: 'workflow_approval', run_id: r.id, decision: 'approved' });
        advance(e, w, r, r.stopped_at + 1);
        return { body: runView(r) };
      },
    },
    {
      // Only a run that is still going (running or waiting for an approval) can be cancelled; pending approvals close with it.
      method: 'POST',
      pattern: '/v1/workflows/:id/runs/:runId/cancel',
      handler: (c) => {
        const e = c.engine;
        const w = workflowOf(e, c.params.id);
        const r = runOf(e, w, c.params.runId);
        if (r.status !== 'running' && r.status !== 'waiting_approval') throw new EmulatorError('CONFLICT', `This run is ${r.status} and cannot be cancelled.`);
        for (const a of st(e).approvals.values()) if (a.run_id === r.id && a.status === 'pending') a.status = 'cancelled';
        for (const s of r.steps) if (s.status === 'waiting_approval') s.status = 'cancelled';
        r.status = 'cancelled';
        r.finished_at = e.clock.now();
        e.webhooks.emit('workflow.run_cancelled', { object: 'workflow_run', id: r.id, workflow_id: w.id });
        return { body: runView(r) };
      },
    },
    {
      // From a step (by id or name) at or before where the run stopped; variables and the outputs of earlier steps are kept.
      method: 'POST',
      pattern: '/v1/workflows/:id/runs/:runId/retry',
      handler: (c) => {
        const e = c.engine;
        const w = workflowOf(e, c.params.id);
        const r = runOf(e, w, c.params.runId);
        if (r.status !== 'failed' && r.status !== 'cancelled') throw new EmulatorError('CONFLICT', `Only a failed or cancelled run can be retried; this one is ${r.status}.`);
        const defs: Obj[] = Array.isArray(w.steps) ? w.steps : [];
        const from = c.body.from_step === undefined ? r.stopped_at : defs.findIndex((d, i) => stepKey(d, i) === c.body.from_step);
        if (typeof from !== 'number' || from < 0) throw bad('from_step is not a step of this workflow.', 'from_step');
        if (from > (r.stopped_at ?? 0)) throw bad('A retry can start at or before the step the run stopped at, not after it.', 'from_step');
        r.steps = r.steps.filter((s: Obj) => defs.findIndex((d, i) => stepKey(d, i) === s.step) < from);
        r.error = null;
        r.finished_at = null;
        if (r.input?.fail_step) r.input = { ...r.input, fail_step: null };
        advance(e, w, r, from);
        return { body: runView(r) };
      },
    },
    // ── app events ──
    {
      method: 'POST',
      pattern: '/v1/app_events',
      handler: (c) => {
        const e = c.engine;
        const b = c.body;
        const org = b.organization_id ?? b.org;
        if (typeof b.type !== 'string' || !b.type) throw bad('type is required.', 'type');
        if (!b.data || typeof b.data !== 'object' || Array.isArray(b.data)) throw bad('data must be an object.', 'data');
        if (JSON.stringify(b.data).length > MAX_EVENT_BYTES) throw bad('data can be at most 256 KB.', 'data');
        const key = b.idempotency_key ?? null;
        if (key !== null && (typeof key !== 'string' || !key || key.length > 255)) throw bad('idempotency_key is up to 255 characters.', 'idempotency_key');
        const types = e.generic.get('app_event_types');
        if (types && types.size && !types.find((t) => t.name === b.type || t.type === b.type || t.key === b.type)) throw bad(`${b.type} is not a registered app event type.`, 'type');
        if (org === '*') {
          // One event per organization with an active endpoint, each with its own idempotency key.
          const targets = e.db.organizations.all().filter((o) => orgEndpoints(e, o.id).length).map((o) => o.id);
          if (targets.length > MAX_BROADCAST) throw bad(`A broadcast reaches at most ${MAX_BROADCAST} organizations; ${targets.length} have an active endpoint.`, 'organization_id');
          const made = targets.map((id) => publishTo(e, id, b.type, b.data, key ? `${key}:${id}` : null));
          return { status: 201, body: { object: 'app_event_broadcast', count: made.length, created: made.filter((m) => m.created).length, events: made.map((m) => eventView(m.row)) } };
        }
        if (typeof org !== 'string' || !org) throw bad('organization_id is required (or "*" to broadcast).', 'organization_id');
        if (!e.db.organizations.get(org)) throw notFound('Organization');
        const r = publishTo(e, org, b.type, b.data, key);
        return { status: r.created ? 201 : 200, body: eventView(r.row) };
      },
    },
    { method: 'GET', pattern: '/v1/app_events', handler: (c) => listReply(c, st(c.engine).events.filter((x) => (!c.query.get('organization_id') || x.organization_id === c.query.get('organization_id')) && (!c.query.get('type') || x.type === c.query.get('type'))), eventView) },
    {
      method: 'GET',
      pattern: '/v1/app_events/:id',
      handler: (c) => {
        const r = st(c.engine).events.get(c.params.id);
        if (!r) throw notFound('App event');
        return { body: eventView(r) };
      },
    },
  ];
}
