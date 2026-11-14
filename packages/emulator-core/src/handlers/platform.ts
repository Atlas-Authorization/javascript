/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Engine, RouteDef } from '../engine';
import { EmulatorError, notFound } from '../errors';
import type { Obj } from '../openapi';
import { Table } from '../store';
import { engineState, intIn, sessionFromBearer } from './support';
import { listReply } from './util';

/**
 * Platform and onboarding surfaces on the engine's own state: write budgets (per-instance caps with an observe or enforce
 * mode, charged by the engine itself), the deprecation list (read from the OpenAPI document, with first use recorded as
 * calls arrive), the path-mount probe, journey runs (resumable onboarding with drafts and an abandon sweep) and hosted-page
 * templates per audience (client, organization, language) with a draft and a live slot.
 */
const bad = (message: string, param: string) => new EmulatorError('VALIDATION_FAILED', message, param);

// ── write budgets ────────────────────────────────────────────────────

const BUDGETS = ['writes', 'counter_writes', 'events', 'webhook_fanout'] as const;
type Budget = (typeof BUDGETS)[number];
const DEFAULT_LIMITS: Record<Budget, number> = { writes: 6000, counter_writes: 60_000, events: 12_000, webhook_fanout: 30_000 };
const BUDGET_MAX = 10_000_000;
const WINDOW_MS = 60_000;
/** Only `writes` and `counter_writes` can reject a request; events and fan-out are counted and announced, never dropped, because a dropped event is lost data. */
const REJECTING: Budget[] = ['writes', 'counter_writes'];

interface BudgetState {
  mode: 'observe' | 'enforce';
  custom: Partial<Record<Budget, number>>;
  windowStart: number;
  used: Record<Budget, number>;
  exceededInWindow: Set<Budget>;
  announced: Set<Budget>;
  lastExceededAt: number | null;
  lastExceededBudget: Budget | null;
  exceededTotal: number;
  updatedAt: number | null;
}
const fresh = (): BudgetState => ({ mode: 'observe', custom: {}, windowStart: 0, used: { writes: 0, counter_writes: 0, events: 0, webhook_fanout: 0 }, exceededInWindow: new Set(), announced: new Set(), lastExceededAt: null, lastExceededBudget: null, exceededTotal: 0, updatedAt: null });
const budgets = engineState(fresh);
const limitOf = (b: BudgetState, n: Budget): number => b.custom[n] ?? DEFAULT_LIMITS[n];

function roll(e: Engine, b: BudgetState): void {
  const now = e.clock.now();
  if (now - b.windowStart >= WINDOW_MS) Object.assign(b, { windowStart: now, used: { writes: 0, counter_writes: 0, events: 0, webhook_fanout: 0 }, exceededInWindow: new Set(), announced: new Set() });
}

/**
 * Count `n` against a budget. Returns `rejected` when the budget is exceeded in enforce mode (writes and counter writes only)
 * and `exceeded` whenever the window's limit is passed. The first overrun of a window per budget emits `write_budget.exceeded`.
 */
export function chargeBudget(e: Engine, name: Budget, n = 1): { exceeded: boolean; rejected: boolean } {
  const b = budgets(e);
  roll(e, b);
  b.used[name] += n;
  if (b.used[name] <= limitOf(b, name)) return { exceeded: false, rejected: false };
  b.exceededInWindow.add(name);
  b.lastExceededAt = e.clock.now();
  b.lastExceededBudget = name;
  b.exceededTotal++;
  if (!b.announced.has(name)) {
    b.announced.add(name);
    e.webhooks.emit('write_budget.exceeded', { object: 'write_budget_exceeded', budget: name, limit: limitOf(b, name), mode: b.mode, window_seconds: WINDOW_MS / 1000 });
  }
  return { exceeded: true, rejected: b.mode === 'enforce' && REJECTING.includes(name) };
}

const budgetView = (e: Engine): Obj => {
  const b = budgets(e);
  roll(e, b);
  return {
    object: 'write_budget',
    mode: b.mode,
    window_seconds: WINDOW_MS / 1000,
    budgets: Object.fromEntries(BUDGETS.map((n) => [n, { limit: limitOf(b, n), default: DEFAULT_LIMITS[n], custom: b.custom[n] !== undefined, used_on_this_node: b.used[n] }])),
    exceeded_in_window: [...b.exceededInWindow],
    resets_in_seconds: Math.max(0, Math.ceil((b.windowStart + WINDOW_MS - e.clock.now()) / 1000)),
    last_exceeded_at: b.lastExceededAt,
    last_exceeded_budget: b.lastExceededBudget,
    exceeded_total: b.exceededTotal,
    updated_at: b.updatedAt,
  };
};

// ── deprecations ─────────────────────────────────────────────────────

const firstUse = engineState(() => new Map<string, number>());

/** Called by the engine for every request that matched a documented operation: remembers the first use of a deprecated one. */
export function noteOperationUse(e: Engine, method: string, path: string): void {
  const op = (e.options.openapi as any).paths?.[path]?.[method.toLowerCase()];
  if (!op?.deprecated) return;
  const seen = firstUse(e);
  const key = `${method.toUpperCase()} ${path}`;
  if (!seen.has(key)) seen.set(key, e.clock.now());
}

function deprecationList(e: Engine, perInstance: boolean): Obj[] {
  const now = e.clock.now();
  const out: Obj[] = [];
  for (const [path, item] of Object.entries((e.options.openapi as any).paths ?? {})) {
    for (const [method, op] of Object.entries(item as Obj)) {
      if (!(op as Obj)?.deprecated) continue;
      const sunset = typeof (op as Obj)['x-sunset'] === 'string' ? String((op as Obj)['x-sunset']) : null;
      const key = `${method.toUpperCase()} ${path}`;
      out.push({ object: 'api_deprecation', id: String((op as Obj).operationId ?? key), kind: 'route', method: method.toUpperCase(), path, field: null, replacement: (op as Obj)['x-successor'] ?? null, announced: (op as Obj)['x-deprecated-since'] ?? null, sunset: sunset?.slice(0, 10) ?? null, days_until_sunset: sunset ? Math.ceil((Date.parse(sunset) - now) / 86_400_000) : null, ...(perInstance ? { in_use: firstUse(e).has(key), first_seen_at: firstUse(e).get(key) ?? null } : {}) });
    }
  }
  return out.sort((a, b) => String(a.sunset ?? '9999').localeCompare(String(b.sunset ?? '9999')));
}
const POLICY = { window_months: 12, headers: ['Deprecation', 'Sunset', 'Link (rel="successor-version")', 'Warning'] };

// ── journeys ─────────────────────────────────────────────────────────

interface Journeys {
  runs: Table;
}
const journeys = engineState((e: Engine): Journeys => ({ runs: new Table('journey_runs', e.clock.now, 'jrun') }));
const flowOf = (e: Engine, id: string | undefined): Obj => {
  const f = e.generic.get('flows')?.get(id);
  if (!f) throw notFound('Flow');
  return f;
};
const runView = (r: Obj, drafts = true): Obj => ({ object: 'journey_run', id: r.id, flow_id: r.flow_id, user_id: r.user_id, stage: r.stage, status: r.status, open_steps: r.open_steps, completed_steps: r.completed_steps, ...(drafts ? { drafts: r.drafts } : {}), started_at: r.started_at, updated_at: r.updated_at, completed_at: r.completed_at ?? null, abandoned_at: r.abandoned_at ?? null });
const journeyEvent = (e: Engine, type: string, r: Obj, extra: Obj = {}): void => void e.webhooks.emit(type, { object: 'journey_run', id: r.id, flow_id: r.flow_id, user_id: r.user_id, status: r.status, ...extra });

// ── page templates ───────────────────────────────────────────────────

const PAGES = ['sign-in', 'sign-up', 'user-profile', 'mfa', 'reset', 'verify', 'consent', 'device'];
const REGIONS = ['header', 'above_form', 'below_form', 'footer'];
const COMPONENTS = ['heading', 'text', 'image', 'link', 'button_link', 'list', 'divider', 'spacer', 'columns'];
interface Template {
  page: string;
  scope_type: 'instance' | 'client' | 'organization';
  scope_id: string | null;
  locale: string | null;
  draft: Obj | null;
  live: Obj | null;
  version: number;
  updated_at: number;
}
const templates = engineState(() => new Map<string, Template>());

function audience(e: Engine, q: URLSearchParams): { type: Template['scope_type']; id: string | null; locale: string | null } {
  const [client, org, locale] = [q.get('client_id'), q.get('organization_id'), q.get('locale')];
  if (client && org) throw bad('Send client_id or organization_id, not both.', 'client_id');
  if (client && !e.db.oauthClients.get(client)) throw notFound('Client');
  if (org && !e.db.organizations.get(org)) throw notFound('Organization');
  if (locale !== null && !/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(locale)) throw bad('locale must be a language tag such as fr or pt-BR.', 'locale');
  return { type: client ? 'client' : org ? 'organization' : 'instance', id: client ?? org ?? null, locale };
}
const tKey = (page: string, a: { type: string; id: string | null; locale: string | null }) => `${page}|${a.type}|${a.id ?? ''}|${a.locale ?? ''}`;
const pageOf = (p: string | undefined): string => {
  if (!PAGES.includes(p ?? '')) throw notFound(`Page (use one of: ${PAGES.join(', ')})`);
  return p!;
};
const tView = (page: string, a: { type: string; id: string | null; locale: string | null }, t?: Template): Obj => ({ object: 'page_template', page, scope: { type: a.type, id: a.id }, locale: a.locale, draft: t?.draft ?? null, live: t?.live ?? null, version: t?.version ?? 0, updated_at: t?.updated_at ?? null });

function checkDefinition(def: unknown): Obj {
  if (!def || typeof def !== 'object' || Array.isArray(def)) throw bad('definition must be an object with regions.', 'definition');
  const d = def as Obj;
  const regions = d.regions ?? {};
  if (typeof regions !== 'object' || Array.isArray(regions)) throw bad('definition.regions must be an object.', 'definition.regions');
  let count = 0;
  for (const [name, list] of Object.entries(regions)) {
    if (!REGIONS.includes(name)) throw bad(`Unknown region ${name}. Use ${REGIONS.join(', ')}.`, `definition.regions.${name}`);
    if (!Array.isArray(list)) throw bad(`Region ${name} must be a list of components.`, `definition.regions.${name}`);
    for (const c of list) {
      if (!c || typeof c !== 'object' || !COMPONENTS.includes(c.type)) throw bad(`A component type is one of: ${COMPONENTS.join(', ')}.`, `definition.regions.${name}`);
      count++;
    }
  }
  if (count > 60) throw bad('A template holds at most 60 components.', 'definition');
  return { version: 1, ...d, regions };
}

export function platformHandlers(): RouteDef[] {
  return [
    // ── write budget ──
    { method: 'GET', pattern: '/v1/instance/write_budget', scope: 'instance:read', handler: (c) => ({ body: budgetView(c.engine) }) },
    {
      method: 'PUT',
      pattern: '/v1/instance/write_budget',
      scope: 'instance:write',
      handler: (c) => {
        const e = c.engine;
        const known = new Set(['mode', ...BUDGETS.map((n) => `${n}_per_minute`)]);
        const unknown = Object.keys(c.body).filter((k) => !known.has(k));
        if (unknown.length) throw bad(`Unknown fields: ${unknown.join(', ')}.`, unknown[0]!);
        if (!Object.keys(c.body).length) throw bad('Send mode or at least one *_per_minute limit.', 'mode');
        const b = budgets(e);
        const next = { mode: b.mode, custom: { ...b.custom } };
        if ('mode' in c.body) {
          if (c.body.mode !== 'observe' && c.body.mode !== 'enforce') throw bad('mode must be "observe" or "enforce".', 'mode');
          next.mode = c.body.mode;
        }
        for (const n of BUDGETS) {
          const key = `${n}_per_minute`;
          if (!(key in c.body)) continue;
          const v = c.body[key];
          if (v === null) delete next.custom[n];
          else next.custom[n] = intIn(v, key, 1, BUDGET_MAX);
        }
        Object.assign(b, next, { updatedAt: e.clock.now() });
        return { body: budgetView(e) };
      },
    },
    {
      method: 'DELETE',
      pattern: '/v1/instance/write_budget',
      scope: 'instance:write',
      handler: (c) => {
        const b = budgets(c.engine);
        Object.assign(b, { mode: 'observe', custom: {}, updatedAt: null });
        return { body: budgetView(c.engine) };
      },
    },
    // ── deprecations ──
    { method: 'GET', pattern: '/v1/deprecations', public: true, handler: (c) => ({ headers: { 'cache-control': 'public, max-age=300' }, body: { object: 'list', data: deprecationList(c.engine, false), has_more: false, policy: POLICY } }) },
    {
      method: 'GET',
      pattern: '/v1/instance/deprecations',
      scope: 'instance:read',
      handler: (c) => {
        const data = deprecationList(c.engine, true);
        return { body: { object: 'list', data, has_more: false, in_use: data.filter((d) => d.in_use).length, policy: POLICY } };
      },
    },
    // ── path mount probe ──
    {
      // No key: how this request reached a path mount. The emulator is never mounted, so it says so.
      method: 'GET',
      pattern: '/v1/path_mount/probe',
      public: true,
      handler: () => ({ headers: { 'cache-control': 'no-store' }, body: { object: 'path_mount_probe', mounted: false, via: null, base_path: null } }),
    },
    // ── journeys ──
    {
      method: 'GET',
      pattern: '/v1/flows/:id/runs',
      scope: 'actions:read',
      handler: (c) => {
        const e = c.engine;
        const f = flowOf(e, c.params.id);
        const status = c.query.get('status');
        if (status && !['in_progress', 'completed', 'abandoned'].includes(status)) throw bad('status must be in_progress, completed or abandoned.', 'status');
        return listReply(c, journeys(e).runs.filter((r) => r.flow_id === f.id && (!status || r.status === status)), (r) => runView(r, false));
      },
    },
    {
      method: 'GET',
      pattern: '/v1/users/:id/journeys',
      scope: 'users:read',
      handler: (c) => {
        if (!c.engine.db.users.get(c.params.id)) throw notFound('User');
        return { body: { object: 'list', data: journeys(c.engine).runs.filter((r) => r.user_id === c.params.id).map((r) => runView(r)), has_more: false, next_cursor: null } };
      },
    },
    {
      method: 'DELETE',
      pattern: '/v1/users/:id/journeys',
      scope: 'users:write',
      handler: (c) => {
        const e = c.engine;
        if (!e.db.users.get(c.params.id)) throw notFound('User');
        const only = c.query.get('journey_id');
        const rows = journeys(e).runs.filter((r) => r.user_id === c.params.id && (!only || r.flow_id === only));
        for (const r of rows) journeys(e).runs.delete(r.id);
        return { body: { object: 'user_journeys_reset', user_id: c.params.id, journey_id: only, removed: rows.length } };
      },
    },
    {
      method: 'GET',
      pattern: '/v1/client/me/journeys',
      public: true,
      handler: async (c) => {
        const { userId } = await sessionFromBearer(c);
        return { body: { object: 'list', data: journeys(c.engine).runs.filter((r) => r.user_id === userId).map((r) => runView(r)), has_more: false } };
      },
    },
    {
      // Emulator: the user reaches the journey. A returning user reopens an abandoned run; steps follow the flow's `on` stages (default sign_in).
      method: 'POST',
      pattern: '/__emulator/journeys/:flowId/start',
      public: true,
      handler: (c) => {
        const e = c.engine;
        const f = flowOf(e, c.params.flowId);
        const userId = c.body.user_id;
        if (typeof userId !== 'string' || !e.db.users.get(userId)) throw notFound('User');
        const stage = c.body.stage === 'sign_up' ? 'sign_up' : 'sign_in';
        const have = journeys(e).runs.find((r) => r.flow_id === f.id && r.user_id === userId && r.status !== 'completed');
        const now = e.clock.now();
        if (have) {
          if (have.status === 'abandoned') Object.assign(have, { status: 'in_progress', abandoned_at: null, updated_at: now });
          return { body: runView(have) };
        }
        const steps = ((Array.isArray(f.definition?.steps) ? f.definition.steps : f.steps) ?? []).filter((s: Obj) => (Array.isArray(s.on) ? s.on : ['sign_in']).includes(stage));
        if (!steps.length) throw new EmulatorError('CONFLICT', `This flow has no step for the ${stage} stage.`);
        const r = journeys(e).runs.insert({ flow_id: f.id, user_id: userId, stage, status: 'in_progress', open_steps: steps.map((s: Obj, i: number) => String(s.id ?? s.name ?? `step_${i}`)), completed_steps: [], drafts: {}, started_at: now, updated_at: now });
        journeyEvent(e, 'journey.started', r, { stage });
        return { status: 201, body: runView(r) };
      },
    },
    {
      method: 'POST',
      pattern: '/__emulator/journeys/runs/:id/draft',
      public: true,
      handler: (c) => {
        const e = c.engine;
        const r = journeys(e).runs.get(c.params.id);
        if (!r) throw notFound('Journey run');
        if (r.status !== 'in_progress') throw new EmulatorError('CONFLICT', `This run is ${r.status}.`);
        if (typeof c.body.step !== 'string' || !r.open_steps.includes(c.body.step)) throw bad('step is not an open step of this run.', 'step');
        if (!c.body.values || typeof c.body.values !== 'object' || Array.isArray(c.body.values) || Object.keys(c.body.values).length > 100) throw bad('values is an object of at most 100 answers.', 'values');
        r.drafts[c.body.step] = { ...(r.drafts[c.body.step] ?? {}), ...c.body.values };
        r.updated_at = e.clock.now();
        return { body: runView(r) };
      },
    },
    {
      method: 'POST',
      pattern: '/__emulator/journeys/runs/:id/complete_step',
      public: true,
      handler: (c) => {
        const e = c.engine;
        const r = journeys(e).runs.get(c.params.id);
        if (!r) throw notFound('Journey run');
        if (r.status !== 'in_progress') throw new EmulatorError('CONFLICT', `This run is ${r.status}.`);
        if (typeof c.body.step !== 'string' || !r.open_steps.includes(c.body.step)) throw bad('step is not an open step of this run.', 'step');
        r.open_steps = r.open_steps.filter((s: string) => s !== c.body.step);
        r.completed_steps.push(c.body.step);
        delete r.drafts[c.body.step];
        r.updated_at = e.clock.now();
        journeyEvent(e, 'journey.step_completed', r, { step: c.body.step });
        if (!r.open_steps.length) {
          r.status = 'completed';
          r.completed_at = r.updated_at;
          journeyEvent(e, 'journey.completed', r);
        }
        return { body: runView(r) };
      },
    },
    {
      // Emulator: the worker's abandon sweep. A run idle for the flow's `abandon_after_hours` (default 72) is abandoned, once.
      method: 'POST',
      pattern: '/__emulator/journeys/sweep',
      public: true,
      handler: (c) => {
        const e = c.engine;
        const now = e.clock.now();
        let abandoned = 0;
        for (const r of journeys(e).runs.filter((x) => x.status === 'in_progress')) {
          const flow = e.generic.get('flows')?.get(r.flow_id);
          const hours = Number(flow?.definition?.abandon_after_hours ?? flow?.abandon_after_hours ?? 72) || 72;
          if (now - r.updated_at < hours * 3_600_000) continue;
          Object.assign(r, { status: 'abandoned', abandoned_at: now });
          journeyEvent(e, 'journey.abandoned', r);
          abandoned++;
        }
        return { body: { object: 'journey_sweep', abandoned } };
      },
    },
    // ── page templates per audience ──
    {
      method: 'GET',
      pattern: '/v1/instance/page_templates',
      scope: 'instance:read',
      handler: (c) => {
        const e = c.engine;
        const a = audience(e, c.query);
        const data = PAGES.map((p) => tView(p, a, templates(e).get(tKey(p, a))));
        return { body: { object: 'list', data, has_more: false } };
      },
    },
    {
      method: 'GET',
      pattern: '/v1/instance/page_templates/:page',
      scope: 'instance:read',
      handler: (c) => {
        const e = c.engine;
        const page = pageOf(c.params.page);
        const a = audience(e, c.query);
        return { body: tView(page, a, templates(e).get(tKey(page, a))) };
      },
    },
    {
      method: 'PUT',
      pattern: '/v1/instance/page_templates/:page',
      scope: 'instance:write',
      handler: (c) => {
        const e = c.engine;
        const page = pageOf(c.params.page);
        const a = audience(e, c.query);
        const key = tKey(page, a);
        const t = templates(e).get(key) ?? { page, scope_type: a.type, scope_id: a.id, locale: a.locale, draft: null, live: null, version: 0, updated_at: 0 };
        t.draft = checkDefinition(c.body.definition);
        t.updated_at = e.clock.now();
        templates(e).set(key, t);
        return { body: tView(page, a, t) };
      },
    },
    {
      // A signed link that shows the draft for this audience only (the emulator has no hosted pages: the link names what it would open).
      method: 'POST',
      pattern: '/v1/instance/page_templates/:page/preview',
      scope: 'instance:read',
      handler: async (c) => {
        const e = c.engine;
        const page = pageOf(c.params.page);
        const a = audience(e, c.query);
        const t = templates(e).get(tKey(page, a));
        if (!t?.draft) throw new EmulatorError('CONFLICT', 'There is no draft to preview. Save one with PUT first.');
        const exp = e.clock.now() + 3_600_000;
        const token = await e.tokens.signClaims({ token_use: 'page_preview', page, atlas_preview_for: { type: a.type, id: a.id, locale: a.locale } }, 3600);
        return { body: { object: 'page_template_preview', page, url: `${e.issuer}/hosted/${page}?atlas_preview=${token}`, expires_at: exp } };
      },
    },
    {
      method: 'POST',
      pattern: '/v1/instance/page_templates/:page/promote',
      scope: 'instance:write',
      handler: (c) => {
        const e = c.engine;
        const page = pageOf(c.params.page);
        const a = audience(e, c.query);
        const t = templates(e).get(tKey(page, a));
        if (!t?.draft) throw new EmulatorError('CONFLICT', 'There is no draft to promote.');
        t.live = t.draft;
        t.draft = null;
        t.version++;
        t.updated_at = e.clock.now();
        return { body: tView(page, a, t) };
      },
    },
    {
      method: 'DELETE',
      pattern: '/v1/instance/page_templates/:page',
      scope: 'instance:write',
      handler: (c) => {
        const e = c.engine;
        const page = pageOf(c.params.page);
        const a = audience(e, c.query);
        const status = c.query.get('status') ?? 'draft';
        if (status !== 'draft' && status !== 'live') throw bad('status must be draft or live.', 'status');
        const t = templates(e).get(tKey(page, a));
        if (!t?.[status]) throw notFound(`${status} template`);
        t[status] = null;
        t.updated_at = e.clock.now();
        return { body: { object: 'page_template', page, status, deleted: true } };
      },
    },
  ];
}
