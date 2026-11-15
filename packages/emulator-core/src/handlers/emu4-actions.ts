/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Engine, RouteContext, RouteDef } from '../engine';
import { EmulatorError, notFound } from '../errors';
import type { Obj } from '../openapi';
import { Table, paginate } from '../store';
import { bytesToB64url } from '../crypto-util';
import { engineState } from './support';
import { actionRuns, runActionCode } from './emu4-actions-sandbox';
import { BUILT_IN_ACTIONS } from './emu4-actions-catalog';
import { buildActionRequest, parseActionDef, pick, validateInput, type ActionDef } from './emu4-actions-def';
import { actionTypesSource } from './emu4-actions-typegen';
import { accessRuleView, addProviderStub, assertConnectionAccess, matchProviderStub, parseAccessRules, providerStubs, replaceAccessRules, rulesOf } from './emu4-actions-access';
import { relayCall } from './connections';

/**
 * Actions and typed connection depth. Action code runs in the sandbox (`POST /v1/actions/{id}/test` is the dry run); a
 * connection's typed actions (first-party packs plus your own definitions) run through the connection relay, every answer is
 * checked against the action's declared output and observed by the provider change radar; connection access rules limit who
 * may use a credential; connection OAuth clients can be created at the provider by dynamic registration. The provider is
 * answered by the engine's `fetch` option or by a stub registered at `/__emulator/connections/provider_stubs`.
 */
const bad = (message: string, param?: string) => new EmulatorError('VALIDATION_FAILED', message, param);
const PROVIDER = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
const OWNER_TYPES = ['organization', 'user', 'external'];

interface State {
  defs: Map<string, ActionDef>;
  changes: Table;
  audit: Obj[];
}
const st = engineState((e: Engine): State => ({ defs: new Map(), changes: new Table('connection_provider_changes', e.clock.now, 'cpc'), audit: [] }));

const audit = (e: Engine, action: string, targetType: string, targetId: string, extra: Obj = {}): void => {
  st(e).audit.push({ id: e.db.newId('audit'), action: `connection.${action}`, target_type: targetType, target_id: targetId, metadata: extra, created_at: e.clock.now() });
};

const connOf = (e: Engine, id: string | undefined): Obj => {
  const c = e.generic.get('connections')?.get(id);
  if (!c) throw notFound('Connection');
  return c;
};

// ── the action catalog ──
const sameDef = (a: ActionDef, b: ActionDef): boolean => JSON.stringify(a) === JSON.stringify(b);
const isBuiltIn = (a: ActionDef): boolean => BUILT_IN_ACTIONS.some((b) => b.provider === a.provider && b.name === a.name && sameDef(b, a));
/** The actions of a provider: the first-party pack, with any custom definition of the same name replacing it. */
function actionsFor(e: Engine, provider: string): ActionDef[] {
  const byName = new Map(BUILT_IN_ACTIONS.filter((a) => a.provider === provider).map((a) => [a.name, a]));
  for (const d of st(e).defs.values()) if (d.provider === provider) byName.set(d.name, d);
  return [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
}
const providersOf = (e: Engine): string[] => [...new Set([...BUILT_IN_ACTIONS.map((a) => a.provider), ...[...st(e).defs.values()].map((d) => d.provider)])].sort();
const present = (a: ActionDef): Obj => ({ object: 'connection_action', provider: a.provider, name: a.name, description: a.description, input_schema: a.input, output_schema: a.output ?? null, method: a.request.method, mutating: a.mutating, scopes: a.scopes ?? [], source: isBuiltIn(a) ? 'first_party' : 'custom' });

// ── provider change radar ──
const CHANGE_KINDS = ['output_drift', 'deprecation', 'endpoint_gone'];
const CHANGE_STATUSES = ['open', 'acknowledged', 'resolved'];
const cap = (v: string | undefined, n = 200): string | null => (v === undefined ? null : v.slice(0, n));
const changeView = (c: Obj): Obj => ({ object: 'connection_provider_change', id: c.id, provider: c.provider, kind: c.kind, action: c.subject, detail: c.detail, status: c.status, occurrences: c.occurrences, first_seen_at: c.first_seen_at, last_seen_at: c.last_seen_at, handled_by: c.handled_by ?? null, handled_at: c.handled_at ?? null });

interface Observation {
  provider: string;
  action: string;
  status: number;
  headers: Record<string, string>;
  drift: string | null;
}
/** One observation of an action run: names, header values and the schema path that failed, never a request or a body. */
function observe(e: Engine, o: Observation): void {
  const found: Array<{ kind: string; fingerprint: string; detail: Obj }> = [];
  const deprecation = cap(o.headers.deprecation);
  const sunset = cap(o.headers.sunset);
  if (deprecation || sunset) found.push({ kind: 'deprecation', fingerprint: `${o.action}:${sunset ?? deprecation}`, detail: { deprecation, sunset } });
  if (o.drift) found.push({ kind: 'output_drift', fingerprint: `${o.action}:${o.drift.slice(0, 300)}`, detail: { problem: o.drift.slice(0, 300) } });
  if (o.status === 410) found.push({ kind: 'endpoint_gone', fingerprint: `${o.action}:410`, detail: { status: 410 } });
  const t = st(e).changes;
  const now = e.clock.now();
  for (const c of found) {
    const row = t.find((r) => r.provider === o.provider && r.kind === c.kind && r.fingerprint === c.fingerprint);
    if (row) {
      row.occurrences++;
      row.last_seen_at = now;
      // A change marked resolved that happens again is open again.
      if (row.status === 'resolved') row.status = 'open';
      continue;
    }
    const made = t.insert({ provider: o.provider, kind: c.kind, subject: o.action, fingerprint: c.fingerprint, detail: c.detail, status: 'open', occurrences: 1, first_seen_at: now, last_seen_at: now, handled_by: null, handled_at: null });
    e.webhooks.emit('connection.provider_change', changeView(made));
  }
}

// ── running an action ──
async function runAction(e: Engine, conn: Obj, def: ActionDef, b: Obj): Promise<Obj> {
  const input = (b.input ?? {}) as Obj;
  const badInput = validateInput(def.input, input);
  if (badInput) throw bad(badInput, 'input');
  const granted: string[] = Array.isArray(conn.scopes) ? conn.scopes : [];
  const missing = (def.scopes ?? []).filter((s) => granted.length > 0 && !granted.includes(s));
  if (missing.length) throw new EmulatorError('FORBIDDEN', `The connection lacks the provider scopes this action needs: ${missing.join(' ')}. Reconnect with them.`, undefined, { meta: { missing_scopes: missing, connection_id: conn.id } });
  const req = buildActionRequest(def, input);
  if (b.dry_run === true) return { object: 'connection_action_result', action: def.name, connection_id: conn.id, ok: true, status: null, data: null, error: null, truncated: false, attempts: 0, dry_run: req };
  const call = async (url: string): Promise<Obj> => {
    const headers = { ...req.headers, ...(req.body !== undefined && !Object.keys(req.headers).some((h) => h.toLowerCase() === 'content-type') ? { 'content-type': 'application/json' } : {}) };
    return relayCall(e, conn, { method: req.method, url, headers, ...(req.body !== undefined ? { body: req.body } : {}) });
  };
  const parse = (text: string): unknown => {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  };
  const pg = def.paginate as Obj | undefined;
  if (b.all_pages === true && pg && pg.type === 'cursor' && typeof pg.cursor_path === 'string' && typeof pg.cursor_param === 'string' && typeof pg.items_path === 'string') {
    const items: unknown[] = [];
    let url = req.url;
    let last: Obj = {};
    for (let page = 0; page < 10 && items.length < 1000; page++) {
      last = await call(url);
      const body = parse(last.body);
      const got = pick(body, pg.items_path);
      if (Array.isArray(got)) items.push(...got);
      const next = pick(body, pg.cursor_path);
      if (last.status < 200 || last.status >= 300 || typeof next !== 'string' || !next) break;
      const u = new URL(url);
      u.searchParams.set(pg.cursor_param, next);
      url = u.toString();
    }
    return { object: 'connection_action_result', action: def.name, connection_id: conn.id, ok: last.status >= 200 && last.status < 300, status: last.status, data: items.slice(0, 1000), error: null, truncated: false, attempts: 1 };
  }
  const out = await call(req.url);
  const data = parse(out.body);
  let ok = out.status >= 200 && out.status < 300;
  let error: string | null = ok ? null : `The provider answered ${out.status}.`;
  const r = def.response;
  if (ok && r?.ok_field && typeof data === 'object' && data !== null && pick(data, r.ok_field) === false) {
    ok = false;
    const x = r.error_field ? pick(data, r.error_field) : undefined;
    error = typeof x === 'string' ? x : 'The provider reported an error.';
  }
  const answer = ok && r?.path ? pick(data, r.path) : data;
  const drift = ok && def.output ? validateInput(def.output, answer, 'output') : null;
  observe(e, { provider: def.provider, action: def.name, status: out.status, headers: out.headers ?? {}, drift });
  return { object: 'connection_action_result', action: def.name, connection_id: conn.id, ok, status: out.status, data: answer, error, truncated: false, attempts: 1, output_valid: ok && def.output ? drift === null : null };
}

// ── Action dry run (the sandbox) ──
function testEvent(sample: Obj, trigger: string, ip: string): Obj {
  const u = (sample.user ?? {}) as Obj;
  const org = sample.organization as Obj | undefined;
  return {
    user: { id: u.id ?? 'user_sample', email: u.email ?? 'sample@example.com', emailVerified: u.emailVerified ?? true, firstName: u.firstName ?? null, lastName: u.lastName ?? null, username: u.username ?? null, metadata: u.metadata ?? {}, organizations: Array.isArray(u.organizations) ? u.organizations : [] },
    connection: { strategy: sample.connection?.strategy ?? 'password', ...(sample.connection?.method ? { method: sample.connection.method } : {}) },
    request: { ip: sample.request?.ip ?? ip, userAgent: sample.request?.user_agent ?? 'action-test', country: sample.request?.country ?? null },
    context: { trigger, ...(sample.context ?? {}) },
    ...(sample.sign_up_fields ? { signUpFields: sample.sign_up_fields } : {}),
    ...(org ? { organization: { id: org.id ?? null, name: org.name ?? 'Sample org', slug: org.slug ?? 'sample-org' } } : {}),
    secrets: {},
  };
}
/** What a dry run shows of a queued request: query values masked, header names only, whether there is a body. */
const maskedRequest = (r: Obj): Obj => {
  const u = new URL(r.url);
  for (const k of [...u.searchParams.keys()]) u.searchParams.set(k, '\u2026');
  return { method: r.method, url: u.toString(), header_names: Object.keys(r.headers ?? {}), has_body: r.body !== null, save_response_as: r.saveResponseAs ?? null };
};

// ── dynamic client registration ──
const DCR_METHODS = ['client_secret_basic', 'client_secret_post', 'private_key_jwt'];
const clientsTable = (e: Engine): Table => {
  let t = e.generic.get('connections/oauth_clients');
  if (!t) e.generic.set('connections/oauth_clients', (t = new Table('connections/oauth_clients', e.clock.now, 'oauthclient')));
  return t;
};

export function emu4ActionsHandlers(): RouteDef[] {
  const openAction = (e: Engine, id: string | undefined): Obj => {
    const a = e.generic.get('actions')?.get(id);
    if (!a) throw notFound('Action');
    return a;
  };
  const provider = (c: RouteContext): string => {
    const p = c.query.get('provider');
    if (p !== null && !PROVIDER.test(p)) throw bad('provider must be a short lowercase key.', 'provider');
    return p ?? '';
  };
  const changeOf = (e: Engine, id: string | undefined): Obj => {
    const r = st(e).changes.get(id);
    if (!r) throw notFound('Change');
    return r;
  };
  function handleChange(c: RouteContext, verb: 'acknowledge' | 'resolve') {
    const row = changeOf(c.engine, c.params.id);
    row.status = verb === 'acknowledge' ? 'acknowledged' : 'resolved';
    row.handled_by = 'emulator';
    row.handled_at = c.engine.clock.now();
    audit(c.engine, `provider_change_${row.status}`, 'connection_provider_change', row.id, { provider: row.provider, kind: row.kind, action: row.subject });
    return { body: changeView(row) };
  }

  return [
    // ── Action dry run ──
    {
      method: 'POST',
      pattern: '/v1/actions/:id/test',
      scope: 'actions:write',
      handler: (c) => {
        const a = openAction(c.engine, c.params.id);
        const event = testEvent((c.body.event ?? {}) as Obj, String(a.trigger ?? ''), '127.0.0.1');
        const base = { object: 'action_test_result', id: a.id };
        const none = { denied: false, deny_reason: null, access_token_claims: {}, id_token_claims: {}, app_metadata: {}, lock_reason: null, pause_reason: null, challenge: null, challenge_accepted: null, suppressed_access_claims: [], suppressed_id_claims: [], user_edits: {}, sign_up_prefill: {}, sign_up_modify: {}, logs: [], http_requests: [] };
        if (a.runtime === 'http') return { body: { ...base, ...none, error: 'An http Action is not called by the emulator; answer it with your own endpoint test.' } };
        const r = runActionCode(event, String(a.code ?? ''));
        if (!r) return { body: { ...base, ...none, error: 'This Action is not in the runtime form (a function body using `api` and `event`), so it was not run.' } };
        return {
          body: { ...base, denied: r.denied, deny_reason: r.denyReason, access_token_claims: r.accessTokenClaims, id_token_claims: r.idTokenClaims, app_metadata: r.appMetadata, lock_reason: r.lockReason, pause_reason: r.pauseReason, challenge: null, challenge_accepted: null, suppressed_access_claims: r.suppressedAccessClaims, suppressed_id_claims: r.suppressedIdClaims, user_edits: r.userEdits, sign_up_prefill: r.signUpPrefill, sign_up_modify: r.signUpModify, logs: r.logs, http_requests: r.httpRequests.map(maskedRequest), error: r.error },
        };
      },
    },
    // ── helpers for tests ──
    {
      method: 'GET',
      pattern: '/__emulator/actions/runs',
      public: true,
      handler: (c) => {
        const rows = actionRuns(c.engine).all().filter((r) => (!c.query.get('action_id') || r.action_id === c.query.get('action_id')) && (!c.query.get('trigger') || r.trigger === c.query.get('trigger')));
        return { body: { object: 'list', data: rows.map((r) => ({ object: 'emulator_action_run', ...r })), has_more: false, next_cursor: null } };
      },
    },
    { method: 'DELETE', pattern: '/__emulator/actions/runs', public: true, handler: (c) => (actionRuns(c.engine).clear(), { body: { ok: true } }) },
    { method: 'GET', pattern: '/__emulator/connections/audit', public: true, handler: (c) => ({ body: { object: 'list', data: [...st(c.engine).audit].reverse(), has_more: false, next_cursor: null } }) },
    {
      // Answer a provider call: `url` is an exact origin + path, or a prefix ending in `*`; `times` limits the uses.
      method: 'POST',
      pattern: '/__emulator/connections/provider_stubs',
      public: true,
      handler: (c) => ({ status: 201, body: { object: 'emulator_provider_stub', ...addProviderStub(c.engine, c.body) } }),
    },
    { method: 'GET', pattern: '/__emulator/connections/provider_stubs', public: true, handler: (c) => ({ body: { object: 'list', data: providerStubs(c.engine).list.map((s) => ({ object: 'emulator_provider_stub', ...s })), has_more: false, next_cursor: null } }) },
    { method: 'DELETE', pattern: '/__emulator/connections/provider_stubs', public: true, handler: (c) => ((providerStubs(c.engine).list.length = 0), { body: { ok: true } }) },
    {
      // Feed the radar an observation without a provider call: { provider, action, status?, headers?, drift? }.
      method: 'POST',
      pattern: '/__emulator/connections/radar_observation',
      public: true,
      handler: (c) => {
        if (typeof c.body.provider !== 'string' || typeof c.body.action !== 'string') throw bad('provider and action are required.', 'provider');
        observe(c.engine, { provider: c.body.provider, action: c.body.action, status: Number(c.body.status ?? 200), headers: Object.fromEntries(Object.entries((c.body.headers ?? {}) as Obj).map(([k, v]) => [k.toLowerCase(), String(v)])), drift: typeof c.body.drift === 'string' ? c.body.drift : null });
        return { body: { ok: true, open: st(c.engine).changes.filter((r) => r.status === 'open').length } };
      },
    },

    // ── catalog ──
    {
      method: 'GET',
      pattern: '/v1/connection_actions',
      scope: 'organizations:read',
      handler: (c) => {
        const p = provider(c);
        const data = (p ? [p] : providersOf(c.engine)).flatMap((x) => actionsFor(c.engine, x)).map(present);
        return { body: { object: 'list', data, has_more: false } };
      },
    },
    {
      method: 'GET',
      pattern: '/v1/connection_actions/types',
      scope: 'organizations:read',
      handler: (c) => {
        const p = provider(c);
        const actions = (p ? [p] : providersOf(c.engine)).flatMap((x) => actionsFor(c.engine, x));
        return { body: { object: 'connection_action_types', provider: p || null, actions: actions.length, source: actionTypesSource(actions) } };
      },
    },
    {
      method: 'GET',
      pattern: '/v1/connection_actions/:provider/:name',
      scope: 'organizations:read',
      handler: (c) => {
        const a = actionsFor(c.engine, c.params.provider ?? '').find((x) => x.name === c.params.name);
        if (!a) throw notFound('Action');
        return { body: present(a) };
      },
    },
    {
      method: 'PUT',
      pattern: '/v1/connection_actions/:provider/:name',
      scope: 'organizations:write',
      handler: (c) => {
        const { provider: p = '', name = '' } = c.params;
        const def = parseActionDef(p, name, c.body);
        st(c.engine).defs.set(`${p}/${name}`, def);
        audit(c.engine, 'action_defined', 'connection_action', `${p}/${name}`);
        return { body: present(def) };
      },
    },
    {
      method: 'DELETE',
      pattern: '/v1/connection_actions/:provider/:name',
      scope: 'organizations:write',
      handler: (c) => {
        const key = `${c.params.provider}/${c.params.name}`;
        if (!st(c.engine).defs.delete(key)) throw notFound('Custom definition');
        audit(c.engine, 'action_removed', 'connection_action', key);
        return { status: 204 };
      },
    },
    {
      method: 'GET',
      pattern: '/v1/connections/:id/actions',
      scope: 'organizations:read',
      handler: (c) => ({ body: { object: 'list', data: actionsFor(c.engine, String(connOf(c.engine, c.params.id).provider)).map(present), has_more: false } }),
    },
    {
      method: 'POST',
      pattern: '/v1/connections/:id/actions/:name',
      scope: 'oauth_tokens:read',
      handler: async (c) => {
        const e = c.engine;
        const conn = connOf(e, c.params.id);
        const def = actionsFor(e, String(conn.provider)).find((a) => a.name === c.params.name);
        if (!def) throw notFound('Action for this connection\'s provider');
        assertConnectionAccess(e, conn.id, c.key, 'run_actions');
        for (const f of ['dry_run', 'all_pages']) if (c.body[f] !== undefined && typeof c.body[f] !== 'boolean') throw bad(`${f} must be true or false.`, f);
        const out = await runAction(e, conn, def, c.body);
        // Action, provider status and attempts only: never the input or the answer.
        audit(e, 'action_ran', 'connection', conn.id, { action: def.name, provider: conn.provider, ok: out.ok, status: out.status, dry_run: c.body.dry_run === true });
        return { headers: { 'x-atlas-attempts': String(out.attempts) }, body: out };
      },
    },

    // ── provider change radar ──
    {
      method: 'GET',
      pattern: '/v1/connection_provider_changes',
      scope: 'organizations:read',
      handler: (c) => {
        const e = c.engine;
        const status = c.query.get('status');
        const kind = c.query.get('kind');
        if (status !== null && status !== 'all' && !CHANGE_STATUSES.includes(status)) throw bad('status must be open, acknowledged, resolved or all.', 'status');
        if (kind !== null && !CHANGE_KINDS.includes(kind)) throw bad(`kind must be one of ${CHANGE_KINDS.join(', ')}.`, 'kind');
        const limit = Math.min(Math.max(Number(c.query.get('limit')) || 100, 1), 200);
        const after = c.query.get('starting_after');
        if (after && !st(e).changes.get(after)) throw bad('Unknown starting_after cursor.', 'starting_after');
        const want = status === 'all' ? null : (status ?? 'open');
        const rows = st(e).changes.all().filter((r) => (!c.query.get('provider') || r.provider === c.query.get('provider')) && (!want || r.status === want) && (!kind || r.kind === kind)).sort((a, b) => b.last_seen_at - a.last_seen_at || (a.id < b.id ? 1 : -1));
        const page = paginate(rows, { limit, startingAfter: after ?? undefined });
        return { body: { object: 'list', data: page.data.map(changeView), has_more: page.has_more, next_cursor: page.next_cursor } };
      },
    },
    { method: 'GET', pattern: '/v1/connection_provider_changes/:id', scope: 'organizations:read', handler: (c) => ({ body: changeView(changeOf(c.engine, c.params.id)) }) },
    { method: 'POST', pattern: '/v1/connection_provider_changes/:id/acknowledge', scope: 'organizations:write', handler: (c) => handleChange(c, 'acknowledge') },
    { method: 'POST', pattern: '/v1/connection_provider_changes/:id/resolve', scope: 'organizations:write', handler: (c) => handleChange(c, 'resolve') },

    // ── access rules ──
    {
      method: 'GET',
      pattern: '/v1/connections/:id/access_rules',
      scope: 'organizations:read',
      handler: (c) => {
        const conn = connOf(c.engine, c.params.id);
        const rules = rulesOf(c.engine, conn.id);
        return { body: { object: 'connection_access_rules', connection_id: conn.id, restricted: rules.length > 0, rules: rules.map(accessRuleView) } };
      },
    },
    {
      method: 'PUT',
      pattern: '/v1/connections/:id/access_rules',
      scope: 'organizations:write',
      handler: (c) => {
        const e = c.engine;
        const conn = connOf(e, c.params.id);
        const saved = replaceAccessRules(e, conn.id, parseAccessRules(c.body));
        audit(e, 'access_rules_set', 'connection', conn.id, { provider: conn.provider, rules: saved.length, restricted: saved.length > 0 });
        return { body: { object: 'connection_access_rules', connection_id: conn.id, restricted: saved.length > 0, rules: saved.map(accessRuleView) } };
      },
    },
    {
      method: 'DELETE',
      pattern: '/v1/connections/:id/access_rules',
      scope: 'organizations:write',
      handler: (c) => {
        const conn = connOf(c.engine, c.params.id);
        replaceAccessRules(c.engine, conn.id, []);
        audit(c.engine, 'access_rules_cleared', 'connection', conn.id, { provider: conn.provider });
        return { status: 204 };
      },
    },

    // ── dynamic client registration (RFC 7591) ──
    {
      method: 'POST',
      pattern: '/v1/connections/oauth_clients/register',
      scope: 'organizations:write',
      handler: async (c) => {
        const e = c.engine;
        const b = c.body;
        const owner = (b.owner ?? {}) as Obj;
        const instanceWide = b.owner === undefined || b.owner === null || owner.type === 'instance';
        if (!instanceWide && (!OWNER_TYPES.includes(owner.type) || typeof owner.id !== 'string' || !owner.id)) throw bad('owner must be omitted, {type: "instance"}, or {type: "organization" | "user" | "external", id}.', 'owner');
        if (typeof b.provider !== 'string' || !PROVIDER.test(b.provider)) throw bad('provider must be a short lowercase key.', 'provider');
        if (!instanceWide && owner.type === 'organization' && !e.db.organizations.get(owner.id)) throw notFound('Organization');
        if (!instanceWide && owner.type === 'user' && !e.db.users.get(owner.id)) throw notFound('User');
        if (b.environment !== undefined && b.environment !== 'production' && b.environment !== 'sandbox') throw bad('environment must be production or sandbox.', 'environment');
        const environment = b.environment ?? 'production';
        const method = b.token_endpoint_auth_method ?? 'client_secret_basic';
        if (!DCR_METHODS.includes(method)) throw bad(`token_endpoint_auth_method must be one of ${DCR_METHODS.join(', ')}.`, 'token_endpoint_auth_method');
        if (b.initial_access_token !== undefined && (typeof b.initial_access_token !== 'string' || !b.initial_access_token || b.initial_access_token.length > 4096)) throw bad('initial_access_token must be a token string.', 'initial_access_token');
        if (b.client_name !== undefined && (typeof b.client_name !== 'string' || !b.client_name.trim() || b.client_name.length > 200)) throw bad('client_name must be 1 to 200 characters.', 'client_name');
        if (b.scopes !== undefined && (!Array.isArray(b.scopes) || b.scopes.length > 50 || b.scopes.some((s: unknown) => typeof s !== 'string' || !s || /\s/.test(s)))) throw bad('scopes must be up to 50 scope strings.', 'scopes');
        let endpoint: URL;
        try {
          if (typeof b.registration_endpoint !== 'string' || b.registration_endpoint.length > 2048) throw new Error('x');
          endpoint = new URL(b.registration_endpoint);
          if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.hash) throw new Error('x');
        } catch {
          throw bad('registration_endpoint must be an https URL without credentials or a fragment.', 'registration_endpoint');
        }
        const ownerType = instanceWide ? 'instance' : owner.type;
        const ownerId = instanceWide ? 'instance' : owner.id;
        const clients = clientsTable(e);
        // An existing client is never silently replaced: its connections would lose the client that issued their tokens.
        if (clients.find((r) => r.owner_type === ownerType && r.owner_id === ownerId && r.provider === b.provider && r.environment === environment)) {
          throw new EmulatorError('CONFLICT', 'That owner already has a client for this provider and environment. Delete it first to register a new one.');
        }
        const redirectUri = typeof b.redirect_uri === 'string' ? b.redirect_uri : `${e.issuer}/v1/oauth/callback/${b.provider}`;
        const metadata: Obj = { client_name: b.client_name?.trim() ?? `Atlas (${b.provider})`, redirect_uris: [redirectUri], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], application_type: 'web', token_endpoint_auth_method: method, ...(b.scopes?.length ? { scope: b.scopes.join(' ') } : {}) };
        let publicJwk: Obj | null = null;
        if (method === 'private_key_jwt') {
          const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
          const jwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as Obj;
          const kid = bytesToB64url(crypto.getRandomValues(new Uint8Array(9)));
          publicJwk = { ...jwk, kid, alg: 'ES256', use: 'sig' };
          // The private half is never kept: the emulator holds only the public key it publishes.
          metadata.token_endpoint_auth_signing_alg = 'ES256';
          metadata.jwks = { keys: [publicJwk] };
        }
        const url = endpoint.toString();
        const init = { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', ...(b.initial_access_token ? { authorization: `Bearer ${b.initial_access_token}` } : {}) }, body: JSON.stringify(metadata), redirect: 'manual' as const };
        let res: Response;
        try {
          const stub = matchProviderStub(e, url, 'POST');
          if (!stub && !e.options.fetch) throw new Error('no fetch');
          res = stub ?? (await e.options.fetch!(url, init));
        } catch {
          throw bad('The registration endpoint could not be reached.', 'registration_endpoint');
        }
        let reply: Obj = {};
        try {
          reply = (await res.json()) as Obj;
        } catch {
          /* not JSON */
        }
        const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
        if (res.status !== 201 && res.status !== 200) throw bad(`The provider refused the registration: ${(str(reply.error_description) ?? str(reply.error) ?? `HTTP ${res.status}`).slice(0, 300)}`, 'registration_endpoint');
        const clientId = str(reply.client_id);
        if (!clientId || clientId.length > 512) throw bad('The provider did not return a client_id.', 'registration_endpoint');
        if (method !== 'private_key_jwt' && !str(reply.client_secret)) throw bad('The provider did not return a client_secret for a secret-based client.', 'registration_endpoint');
        const uri = str(reply.registration_client_uri);
        const expires = typeof reply.client_secret_expires_at === 'number' && reply.client_secret_expires_at > 0 ? reply.client_secret_expires_at : null;
        const now = e.clock.now();
        const row = clients.insert({ owner_type: ownerType, owner_id: ownerId, provider: b.provider, environment, client_id: clientId, auth_method: publicJwk ? 'private_key_jwt' : 'client_secret', key_alg: publicJwk ? 'ES256' : null, public_jwk: publicJwk, key_id: publicJwk?.kid ?? null, scopes: b.scopes ?? [], registration_client_uri: uri && /^https:\/\//.test(uri) ? uri : null, redirect_uri: typeof b.redirect_uri === 'string' ? b.redirect_uri : null, registered_via: 'dcr', enabled: true, created_at: now, updated_at: now });
        // The secret, the registration token and the initial access token are never stored in the row, the audit log or the answer.
        audit(e, 'oauth_client_registered', 'connection', row.id, { provider: row.provider, owner_type: ownerType, owner_id: ownerId, environment, auth_method: row.auth_method });
        return {
          status: 201,
          body: {
            object: 'connection_oauth_client', id: row.id, owner: instanceWide ? { type: 'instance' } : { type: ownerType, id: ownerId }, provider: row.provider, environment, client_id: clientId, has_secret: true, auth_method: row.auth_method, key_id: row.key_id, key_alg: row.key_alg, public_jwk: publicJwk, jwks_url: publicJwk ? `${e.issuer}/v1/connection_client_jwks/${e.instanceId}/${row.id}` : null, mtls_cert: null, registered_via: 'dcr', registration_client_uri: row.registration_client_uri, scopes: row.scopes, host_params: {}, enabled: true, redirect_uri: row.redirect_uri, callback_url: row.redirect_uri ?? `${e.issuer}/v1/oauth/callback/${b.provider}`, forward_url: `${e.issuer}/v1/oauth/callback/${b.provider}`, created_at: now, updated_at: now, secret_expires_at: expires ? expires * 1000 : null,
          },
        };
      },
    },
    {
      // The public key of a private_key_jwt client; unknown, disabled and wrong-method clients all answer 404.
      method: 'GET',
      pattern: '/v1/connection_client_jwks/:instanceId/:clientId',
      public: true,
      handler: (c) => {
        const row = c.params.instanceId === c.engine.instanceId ? clientsTable(c.engine).get(c.params.clientId) : undefined;
        if (!row || row.enabled === false || row.auth_method !== 'private_key_jwt' || !row.public_jwk) throw notFound('Client');
        return { headers: { 'cache-control': 'public, max-age=300' }, body: { keys: [row.public_jwk] } };
      },
    },
  ];
}
