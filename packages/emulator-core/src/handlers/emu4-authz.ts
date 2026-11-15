/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Engine, RouteContext, RouteDef } from '../engine';
import { EmulatorError } from '../errors';
import type { Obj } from '../openapi';
import type { Row } from '../store';
import { type Signals, firstOf, headerSignals, ipFacts, noFacts, readSignals, resolveSignals, signalState } from './access-signals';
import { type EntityRef, CedarLinkError, CedarParseError, cedarTemplateSlots, linkCedarTemplate, parseCedarTemplate } from './cedar';
import { type AccessCtx, evalSet, latestModel, logDecision, zoneMatches } from './authz-layers';
import { genericTable, pushEvent, st as authzState, storeExists, storeTuples } from './authz-state';
import { auditAuthz, emu4TrustAuthzHandlers } from './emu4-authz-trust';
import { type Compiled, type FgaTuple, ModelError, Resolver, TupleError, compileModel, compileStored, dslToModel, parseObject, parseUser } from './fga-engine';

/**
 * Round-four authorization routes: FGA models with rewrites and the batch-check, list-objects, list-users and expand queries
 * over the stored tuples; Cedar policy templates and the links that instantiate them; access-policy simulation and network
 * zone checks that read geography, risk and device signals; and the agent delegation graph (see emu4-authz-trust.ts).
 */
const bad = (message: string, param?: string) => new EmulatorError('VALIDATION_FAILED', message, param);
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {});

// ── FGA ──

const modelTable = (e: Engine) => genericTable(e, 'fga/stores/authorization-models', 'fgm');
const modelView = (m: Row, withModel: boolean): Obj => ({ object: 'fga.authorization_model', id: m.id, store_id: m._parent ?? m.store_id, schema_version: m.schema_version ?? '1.1', ...(withModel ? { model: m.model } : {}), created_at: m.created_at });
const storeOf = (e: Engine, id: string | undefined): string => {
  if (!id || !storeExists(e, id)) throw new EmulatorError('NOT_FOUND', 'Unknown FGA store.');
  return id;
};

/** The model a query runs against: the one named, or the store's newest. A store with no model has no rules to resolve against. */
function resolveModel(e: Engine, storeId: string, modelId: unknown): { row: Row; compiled: Compiled } {
  let row: Row | undefined;
  if (typeof modelId === 'string' && modelId) {
    row = modelTable(e).find((m) => m._parent === storeId && m.id === modelId);
    if (!row) throw new EmulatorError('NOT_FOUND', 'Unknown authorization model for this store.');
  } else row = latestModel(e, storeId);
  if (!row) throw bad('This store has no authorization model yet; write one before running a query.', 'authorization_model_id');
  try {
    const compiled = compileStored(row.model) ?? (typeof row.model === 'string' ? compileModel(dslToModel(row.model)) : null);
    if (!compiled) throw new ModelError(['The model could not be read.']);
    return { row, compiled };
  } catch (err) {
    throw bad(err instanceof ModelError ? err.errors.join(' ') : 'The authorization model could not be read.', 'authorization_model_id');
  }
}

/** Contextual tuples: a list of tuple keys, or `{ tuple_keys: [...] }`. */
function contextualOf(raw: unknown, field: string): FgaTuple[] {
  const list = raw && typeof raw === 'object' && !Array.isArray(raw) && 'tuple_keys' in (raw as Obj) ? (raw as Obj).tuple_keys : raw;
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) throw bad(`${field} must be an array of tuple keys.`, field);
  if (list.length > 20) throw bad(`${field} accepts at most 20 tuples.`, field);
  return list.map((t: any, i: number) => {
    if (!t || typeof t.user !== 'string' || typeof t.relation !== 'string' || typeof t.object !== 'string') throw bad(`${field}[${i}] needs string user, relation and object.`, field);
    try {
      parseUser(t.user);
      parseObject(t.object);
    } catch (err) {
      throw bad(err instanceof Error ? err.message : 'Malformed tuple.', field);
    }
    const c = obj(t.condition);
    return { user: t.user, relation: t.relation, object: t.object, ...(typeof c.name === 'string' ? { condition: { name: c.name, context: obj(c.context) } } : {}) };
  });
}

const tupleList = (e: Engine, storeId: string, extra: FgaTuple[]): FgaTuple[] => [...storeTuples(e, storeId).map((t) => ({ user: t.user, relation: t.relation, object: t.object, ...(t.condition ? { condition: t.condition } : {}) })), ...extra];
const resolver = (e: Engine, storeId: string, compiled: Compiled, extra: FgaTuple[], context: unknown): Resolver => {
  try {
    return new Resolver(compiled, tupleList(e, storeId, extra), context && typeof context === 'object' && !Array.isArray(context) ? (context as Obj) : undefined);
  } catch (err) {
    if (err instanceof TupleError) throw bad(err.message);
    throw err;
  }
};
const token = (e: Engine, storeId: string) => `${storeId}:${authzState(e).revisions.get(storeId) ?? 0}`;

const strings = (b: Obj, fields: string[], what: string): void => {
  for (const f of fields) if (typeof b[f] !== 'string' || !b[f]) throw bad(`${what} requires string ${fields.join(', ')}.`, fields[fields.length - 1] === 'type' ? 'type' : f);
};
function logCheck(e: Engine, storeId: string, modelId: string, r: { user: string; relation: string; object: string; contextual: FgaTuple[]; context: unknown; allowed: boolean }): void {
  logDecision(e, { source: 'fga', decision: r.allowed ? 'allow' : 'deny', principal: r.user, action: r.relation, resource: r.object, input: { user: r.user, relation: r.relation, object: r.object, contextual_tuples: r.contextual, context: r.context ?? null }, result: { authorization_model_id: modelId }, policyVersion: { store_id: storeId, authorization_model_id: modelId } });
}
const checkOne = (rs: Resolver, user: string, relation: string, object: string): boolean => {
  try {
    return rs.check(parseUser(user), object, relation);
  } catch (err) {
    if (err instanceof TupleError) throw bad(err.message, 'user');
    throw err;
  }
};
const pageAfter = (items: string[], after: unknown, limit: number) => {
  const sorted = [...items].sort();
  const start = typeof after === 'string' && after ? sorted.findIndex((t) => t > after) : 0;
  const slice = start < 0 ? [] : sorted.slice(start, start + limit);
  const more = start >= 0 && start + limit < sorted.length;
  return { data: slice, has_more: more, next_cursor: more && slice.length ? slice[slice.length - 1]! : null };
};

function fgaHandlers(): RouteDef[] {
  const base = '/v1/fga/stores/:id';
  return [
    {
      method: 'GET',
      pattern: `${base}/authorization-models`,
      scope: 'fga:read',
      handler: (c) => {
        const storeId = storeOf(c.engine, c.params.id);
        return { body: { object: 'list', data: modelTable(c.engine).filter((m) => m._parent === storeId).map((m) => modelView(m, false)), has_more: false } };
      },
    },
    {
      method: 'POST',
      pattern: `${base}/authorization-models`,
      scope: 'fga:write',
      handler: (c) => {
        const e = c.engine;
        const storeId = storeOf(e, c.params.id);
        const b = c.body;
        if (Array.isArray(b.modules) && b.modules.length) throw bad('Modular models are not supported by the emulator: send one model as `dsl` or `type_definitions`.', 'modules');
        let model: Obj;
        if (typeof b.dsl === 'string' && b.dsl.trim()) {
          try {
            model = dslToModel(b.dsl);
          } catch (err) {
            throw bad(`Could not parse the FGA DSL: ${err instanceof Error ? err.message : 'invalid model'}`, 'dsl');
          }
        } else model = { type_definitions: b.type_definitions, schema_version: typeof b.schema_version === 'string' && b.schema_version ? b.schema_version : '1.1', ...(b.conditions ? { conditions: b.conditions } : {}) };
        try {
          compileModel(model);
        } catch (err) {
          if (err instanceof ModelError) throw bad(err.errors.join(' '), 'type_definitions');
          throw err;
        }
        const row = modelTable(e).insert({ object: 'fga.authorization_model', store_id: storeId, schema_version: String(model.schema_version ?? '1.1'), model, created_at: e.clock.now(), _parent: storeId } as any);
        pushEvent(e, 'model_written', storeId, 'api', { authorization_model_id: row.id });
        auditAuthz(e, 'fga_authorization_model.created', 'fga_authorization_model', row.id, { store_id: storeId, schema_version: row.schema_version });
        return { status: 201, body: modelView(row, true) };
      },
    },
    {
      method: 'GET',
      pattern: `${base}/authorization-models/:mid`,
      scope: 'fga:read',
      handler: (c) => {
        const storeId = storeOf(c.engine, c.params.id);
        const row = modelTable(c.engine).find((m) => m._parent === storeId && m.id === c.params.mid);
        if (!row) throw new EmulatorError('NOT_FOUND', 'Unknown authorization model.');
        return { body: modelView(row, true) };
      },
    },
    {
      method: 'POST',
      pattern: `${base}/batch-check`,
      scope: 'fga:read',
      handler: (c) => {
        const e = c.engine;
        const storeId = storeOf(e, c.params.id);
        const b = c.body;
        if (!Array.isArray(b.checks) || !b.checks.length) throw bad('Provide a non-empty checks array.', 'checks');
        if (b.checks.length > 100) throw bad('A batch-check accepts at most 100 checks.', 'checks');
        const items = b.checks.map((raw: unknown, i: number) => {
          const k = obj(raw);
          if (typeof k.user !== 'string' || typeof k.relation !== 'string' || typeof k.object !== 'string') throw bad(`check ${i} requires string user, relation and object.`, 'checks');
          return { correlation_id: typeof k.correlation_id === 'string' ? k.correlation_id : String(i), user: k.user, relation: k.relation, object: k.object, contextual: contextualOf(k.contextual_tuples, 'checks'), context: k.context };
        });
        const { row, compiled } = resolveModel(e, storeId, b.authorization_model_id);
        const result = items.map((it: any) => {
          const allowed = checkOne(resolver(e, storeId, compiled, it.contextual, it.context), it.user, it.relation, it.object);
          logCheck(e, storeId, row.id, { ...it, allowed });
          return { correlation_id: it.correlation_id, allowed };
        });
        return { body: { object: 'fga.batch_check', authorization_model_id: row.id, consistency_token: token(e, storeId), result } };
      },
    },
    {
      method: 'POST',
      pattern: `${base}/list-objects`,
      scope: 'fga:read',
      handler: (c) => {
        const e = c.engine;
        const storeId = storeOf(e, c.params.id);
        const b = c.body;
        if (typeof b.user !== 'string' || typeof b.relation !== 'string' || typeof b.type !== 'string') throw bad('list-objects requires string user, relation and type.', 'type');
        const { row, compiled } = resolveModel(e, storeId, b.authorization_model_id);
        let ids: string[];
        try {
          ids = resolver(e, storeId, compiled, contextualOf(b.contextual_tuples, 'contextual_tuples'), b.context).listObjects(parseUser(b.user), b.relation, b.type);
        } catch (err) {
          if (err instanceof TupleError) throw bad(err.message, 'user');
          throw err;
        }
        const all = ids.map((id) => `${b.type}:${id}`);
        // Without a limit every object comes back; with one the list is sorted and paged.
        const limit = Math.min(Math.max(Number.isInteger(b.limit) ? (b.limit as number) : 100, 1), 1000);
        const page = b.limit === undefined ? { data: all, has_more: false, next_cursor: null } : pageAfter(all, b.starting_after, limit);
        return { body: { object: 'fga.list_objects', objects: page.data, has_more: page.has_more, next_cursor: page.next_cursor, authorization_model_id: row.id, consistency_token: token(e, storeId) } };
      },
    },
    {
      method: 'POST',
      pattern: `${base}/expand`,
      scope: 'fga:read',
      handler: (c) => {
        const e = c.engine;
        const storeId = storeOf(e, c.params.id);
        strings(c.body, ['object', 'relation'], 'expand');
        const { row, compiled } = resolveModel(e, storeId, c.body.authorization_model_id);
        try {
          return { body: { object: 'fga.expand', tree: resolver(e, storeId, compiled, [], undefined).expand(c.body.object, c.body.relation), authorization_model_id: row.id } };
        } catch (err) {
          if (err instanceof TupleError) throw bad(err.message, 'object');
          throw err;
        }
      },
    },
    {
      method: 'POST',
      pattern: `${base}/list-users`,
      scope: 'fga:read',
      handler: (c) => {
        const e = c.engine;
        const storeId = storeOf(e, c.params.id);
        const b = c.body;
        if (typeof b.relation !== 'string' || !b.relation) throw bad('list-users requires a relation.', 'relation');
        const o = typeof b.object === 'string' ? b.object : obj(b.object).type && obj(b.object).id ? `${obj(b.object).type}:${obj(b.object).id}` : '';
        if (!o) throw bad('list-users requires an object.', 'object');
        const filters = Array.isArray(b.user_filters) ? b.user_filters : [];
        if (!filters.length || filters.some((f: any) => typeof f?.type !== 'string')) throw bad('user_filters needs at least one { type }.', 'user_filters');
        if (filters.some((f: any) => f.relation)) throw bad('The emulator lists concrete users only: a user filter with a relation is not supported.', 'user_filters');
        const { row, compiled } = resolveModel(e, storeId, b.authorization_model_id);
        let users: string[];
        try {
          const rs = resolver(e, storeId, compiled, contextualOf(b.contextual_tuples, 'contextual_tuples'), b.context);
          users = [...new Set(filters.flatMap((f: any) => rs.listUsers(o, b.relation, f.type).map((id) => `${f.type}:${id}`)))];
        } catch (err) {
          if (err instanceof TupleError) throw bad(err.message, 'object');
          throw err;
        }
        const size = Math.min(Math.max(Number.isInteger(b.page_size) ? (b.page_size as number) : 1000, 1), 1000);
        const offset = Math.max(Number(b.continuation_token) || 0, 0);
        return { body: { object: 'fga.list_users', users: users.slice(offset, offset + size), excluded_users: [], continuation_token: offset + size < users.length ? String(offset + size) : null, authorization_model_id: row.id, consistency_token: token(e, storeId) } };
      },
    },
  ];
}

// ── Cedar templates and links ──

/** Replace the slots in template source (outside string literals) with entity literals. */
function substituteSlots(source: string, values: { principal?: Obj | null; resource?: Obj | null }): string {
  const lit = (x?: Obj | null) => (x ? `${x.type}::"${String(x.id).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : null);
  let out = '';
  for (let i = 0; i < source.length; ) {
    const ch = source[i]!;
    if (ch === '"') {
      let j = i + 1;
      while (j < source.length && source[j] !== '"') j += source[j] === '\\' ? 2 : 1;
      out += source.slice(i, j + 1);
      i = j + 1;
    } else if (ch === '/' && source[i + 1] === '/') {
      const j = source.indexOf('\n', i);
      const end = j < 0 ? source.length : j;
      out += source.slice(i, end);
      i = end;
    } else if (ch === '?' && /^\?(principal|resource)\b/.test(source.slice(i))) {
      const name = source.slice(i + 1).startsWith('principal') ? 'principal' : 'resource';
      out += lit(values[name]) ?? `?${name}`;
      i += 1 + name.length;
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

const templates = (e: Engine) => genericTable(e, 'abac_templates', 'abt');
const links = (e: Engine) => genericTable(e, 'abac_policy_links', 'abl');
const nameOf = (v: unknown): string => {
  if (typeof v !== 'string' || !v.trim() || v.length > 100) throw bad('name is required (1-100 characters).', 'name');
  return v.trim();
};
function parseTemplate(source: unknown): ReturnType<typeof parseCedarTemplate> {
  if (typeof source !== 'string' || !source.trim()) throw bad('source is required.', 'source');
  if (source.length > 100_000) throw bad('source is too large (100,000 characters at most).', 'source');
  try {
    const parsed = parseCedarTemplate(source);
    if (!parsed.length) throw bad('A template needs at least one policy.', 'source');
    return parsed;
  } catch (err) {
    if (err instanceof CedarParseError) throw bad(`${err.message} (at character ${err.position})`, 'source');
    throw err;
  }
}
const entityRef = (raw: unknown, field: string): Obj | null | undefined => {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  const o = obj(raw);
  if (typeof o.type !== 'string' || !o.type || typeof o.id !== 'string' || !o.id) throw bad(`${field} needs a type and an id.`, field);
  return { type: o.type, id: o.id };
};
/** Fill a template for one link; a missing or surplus slot value is a 400 naming it. */
function instantiate(source: string, principal: Obj | null, resource: Obj | null) {
  const parsed = parseCedarTemplate(source);
  const slots = cedarTemplateSlots(parsed);
  for (const [name, v] of [['principal', principal], ['resource', resource]] as const) if (v && !slots.includes(`?${name}` as '?principal')) throw bad(`The template has no ?${name} slot, so a ${name} cannot be set.`, name);
  try {
    return linkCedarTemplate(parsed, { principal: (principal ?? undefined) as EntityRef | undefined, resource: (resource ?? undefined) as EntityRef | undefined });
  } catch (err) {
    if (err instanceof CedarLinkError) throw bad(err.message, slots.includes('?principal') && !principal ? 'principal' : 'resource');
    throw err;
  }
}
const parseStore = (e: Engine, v: unknown): string | null | undefined => {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== 'string' || !storeExists(e, v)) throw bad('Unknown FGA store.', 'fga_store_id');
  return v;
};
const templateView = (e: Engine, t: Row): Obj => ({
  object: 'abac_policy_template',
  id: t.id,
  name: t.name,
  description: t.description ?? null,
  source: t.source,
  version: t.version,
  slots: cedarTemplateSlots(parseCedarTemplate(t.source)),
  fga_store_id: t.fga_store_id ?? null,
  link_count: links(e).filter((l) => l.template_id === t.id).length,
  created_at: t.created_at,
  updated_at: t.updated_at,
});
const linkView = (e: Engine, l: Row): Obj => {
  const t = templates(e).get(l.template_id);
  return { object: 'abac_policy_link', id: l.id, name: l.name, template_id: l.template_id, template_name: t?.name ?? null, template_version: t?.version ?? null, principal: l.principal ?? null, resource: l.resource ?? null, enabled: l.enabled, source: t ? substituteSlots(t.source, { principal: l.principal, resource: l.resource }) : '', created_at: l.created_at, updated_at: l.updated_at };
};
const needTemplate = (e: Engine, id: string | undefined): Row => {
  const t = templates(e).get(id);
  if (!t) throw new EmulatorError('NOT_FOUND', 'Unknown ABAC policy template.');
  return t;
};
const needLink = (e: Engine, id: string | undefined): Row => {
  const l = links(e).get(id);
  if (!l) throw new EmulatorError('NOT_FOUND', 'Unknown ABAC policy link.');
  return l;
};

function templateHandlers(): RouteDef[] {
  return [
    { method: 'GET', pattern: '/v1/abac_templates', scope: 'abac:read', handler: (c) => ({ body: { object: 'list', data: templates(c.engine).all().map((t) => templateView(c.engine, t)), has_more: false } }) },
    {
      method: 'POST',
      pattern: '/v1/abac_templates',
      scope: 'abac:write',
      handler: (c) => {
        const e = c.engine;
        const name = nameOf(c.body.name);
        if (templates(e).find((t) => t.name === name)) throw bad(`An ABAC policy template named "${name}" already exists.`, 'name');
        parseTemplate(c.body.source);
        const now = e.clock.now();
        const row = templates(e).insert({ object: 'abac_policy_template', name, description: typeof c.body.description === 'string' ? c.body.description : null, source: c.body.source, version: 1, fga_store_id: parseStore(e, c.body.fga_store_id) ?? null, created_at: now, updated_at: now } as any);
        auditAuthz(e, 'abac_template.created', 'abac_template', row.id, { name });
        return { status: 201, body: templateView(e, row) };
      },
    },
    { method: 'GET', pattern: '/v1/abac_templates/:id', scope: 'abac:read', handler: (c) => ({ body: templateView(c.engine, needTemplate(c.engine, c.params.id)) }) },
    {
      method: 'PATCH',
      pattern: '/v1/abac_templates/:id',
      scope: 'abac:write',
      handler: (c) => {
        const e = c.engine;
        const t = needTemplate(e, c.params.id);
        const b = c.body;
        const patch: Obj = { updated_at: e.clock.now() };
        if (b.name !== undefined) {
          const name = nameOf(b.name);
          const clash = templates(e).find((x) => x.name === name);
          if (clash && clash.id !== t.id) throw bad(`An ABAC policy template named "${name}" already exists.`, 'name');
          patch.name = name;
        }
        if (b.description !== undefined) patch.description = typeof b.description === 'string' ? b.description : null;
        const store = parseStore(e, b.fga_store_id);
        if (store !== undefined) patch.fga_store_id = store;
        let affected = 0;
        if (b.source !== undefined) {
          parseTemplate(b.source);
          // A new source becomes the source of every link at once; refused if a link could no longer be filled in.
          const problems: string[] = [];
          for (const l of links(e).filter((x) => x.template_id === t.id)) {
            try {
              instantiate(b.source, l.principal ?? null, l.resource ?? null);
            } catch (err) {
              problems.push(`link "${l.name}": ${err instanceof Error ? err.message : String(err)}`);
            }
          }
          if (problems.length) throw bad(problems.join(' '), 'source');
          affected = links(e).filter((x) => x.template_id === t.id).length;
          if (b.source !== t.source) patch.version = (t.version ?? 1) + 1;
          patch.source = b.source;
        }
        const row = templates(e).update(t.id, patch as any)!;
        auditAuthz(e, 'abac_template.updated', 'abac_template', row.id, { name: row.name, version: row.version, links_updated: affected });
        return { body: { ...templateView(e, row), links_updated: affected } };
      },
    },
    {
      method: 'DELETE',
      pattern: '/v1/abac_templates/:id',
      scope: 'abac:write',
      handler: (c) => {
        const e = c.engine;
        const t = needTemplate(e, c.params.id);
        const mine = links(e).filter((l) => l.template_id === t.id);
        if (mine.length && c.query.get('force') !== 'true') throw new EmulatorError('CONFLICT', `The template has ${mine.length} link${mine.length === 1 ? '' : 's'}; deleting it deletes them too. Pass force=true to delete both.`, undefined, { meta: { link_count: mine.length } });
        for (const l of mine) links(e).delete(l.id);
        templates(e).delete(t.id);
        auditAuthz(e, 'abac_template.deleted', 'abac_template', t.id, { name: t.name, links: mine.length });
        return { body: { object: 'abac_policy_template', id: t.id, deleted: true, links_deleted: mine.length } };
      },
    },
    {
      method: 'GET',
      pattern: '/v1/abac_policy_links',
      scope: 'abac:read',
      handler: (c) => ({ body: { object: 'list', data: links(c.engine).all().filter((l) => !c.query.get('template_id') || l.template_id === c.query.get('template_id')).map((l) => linkView(c.engine, l)), has_more: false } }),
    },
    {
      method: 'POST',
      pattern: '/v1/abac_policy_links',
      scope: 'abac:write',
      handler: (c) => {
        const e = c.engine;
        const b = c.body;
        if (typeof b.template_id !== 'string') throw bad('template_id is required.', 'template_id');
        const t = templates(e).get(b.template_id);
        if (!t) throw bad('Unknown ABAC policy template.', 'template_id');
        const name = nameOf(b.name);
        if (links(e).find((l) => l.name === name)) throw bad(`An ABAC policy link named "${name}" already exists.`, 'name');
        const principal = entityRef(b.principal, 'principal') ?? null;
        const resource = entityRef(b.resource, 'resource') ?? null;
        instantiate(t.source, principal, resource);
        const now = e.clock.now();
        const row = links(e).insert({ object: 'abac_policy_link', template_id: t.id, name, principal, resource, enabled: b.enabled === undefined ? true : Boolean(b.enabled), created_at: now, updated_at: now } as any);
        auditAuthz(e, 'abac_link.created', 'abac_link', row.id, { name, template: t.name });
        return { status: 201, body: linkView(e, row) };
      },
    },
    { method: 'GET', pattern: '/v1/abac_policy_links/:id', scope: 'abac:read', handler: (c) => ({ body: linkView(c.engine, needLink(c.engine, c.params.id)) }) },
    {
      method: 'PATCH',
      pattern: '/v1/abac_policy_links/:id',
      scope: 'abac:write',
      handler: (c) => {
        const e = c.engine;
        const l = needLink(e, c.params.id);
        const t = templates(e).get(l.template_id);
        if (!t) throw new EmulatorError('NOT_FOUND', "The link's template is gone.");
        const b = c.body;
        const patch: Obj = { updated_at: e.clock.now() };
        if (b.name !== undefined) {
          const name = nameOf(b.name);
          const clash = links(e).find((x) => x.name === name);
          if (clash && clash.id !== l.id) throw bad(`An ABAC policy link named "${name}" already exists.`, 'name');
          patch.name = name;
        }
        const pIn = entityRef(b.principal, 'principal');
        const rIn = entityRef(b.resource, 'resource');
        if (pIn !== undefined) patch.principal = pIn;
        if (rIn !== undefined) patch.resource = rIn;
        instantiate(t.source, pIn === undefined ? (l.principal ?? null) : pIn, rIn === undefined ? (l.resource ?? null) : rIn);
        if (b.enabled !== undefined) patch.enabled = Boolean(b.enabled);
        const row = links(e).update(l.id, patch as any)!;
        auditAuthz(e, 'abac_link.updated', 'abac_link', row.id, { name: row.name });
        return { body: linkView(e, row) };
      },
    },
    {
      method: 'DELETE',
      pattern: '/v1/abac_policy_links/:id',
      scope: 'abac:write',
      handler: (c) => {
        const l = needLink(c.engine, c.params.id);
        links(c.engine).delete(l.id);
        auditAuthz(c.engine, 'abac_link.deleted', 'abac_link', l.id, { name: l.name });
        return { body: { object: 'abac_policy_link', id: l.id, deleted: true } };
      },
    },
  ];
}

// ── access policies: signals, simulation, zone checks ──

const STAGES = ['sign_in', 'authorize', 'token'];
const TARGETS = ['user', 'machine', 'agent'];
const RANK: Record<string, number> = { mfa: 1, passwordless: 2, phishing_resistant: 3 };
const PHISHING_RESISTANT = new Set(['passkey', 'webauthn', 'security_key', 'piv', 'certificate', 'x509', 'device_key']);
const PASSWORDLESS = new Set([...PHISHING_RESISTANT, 'email_link', 'email_code', 'phone_code', 'magic_link', 'otp']);
const strength = (methods: string[], mfa: boolean): string | null => {
  const m = methods.map((x) => x.toLowerCase());
  if (m.some((x) => PHISHING_RESISTANT.has(x))) return 'phishing_resistant';
  if (m.length && !m.includes('password') && m.every((x) => PASSWORDLESS.has(x) || x.startsWith('oauth:')) && mfa) return 'passwordless';
  return mfa ? 'mfa' : null;
};

function simulate(c: RouteContext): Obj {
  const e = c.engine;
  const b = c.body;
  const stage = b.stage === undefined ? 'sign_in' : b.stage;
  if (typeof stage !== 'string' || !STAGES.includes(stage)) throw bad('stage must be sign_in, authorize or token.', 'stage');
  const strs = (k: string): string[] | undefined => {
    const v = b[k];
    if (v === undefined) return undefined;
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw bad(`${k} must be an array of strings.`, k);
    return v as string[];
  };
  const table = e.generic.get('access_policies');
  let rows: Obj[];
  if (typeof b.policy_id === 'string') {
    const row = table?.get(b.policy_id);
    if (!row) throw new EmulatorError('NOT_FOUND', 'Unknown access policy.');
    rows = [{ ...row, enabled: true, mode: 'enforce' }];
  } else rows = (table?.all() ?? []).filter((r) => r.enabled !== false);
  const ip = typeof b.ip === 'string' ? b.ip : undefined;
  const userId = typeof b.user_id === 'string' ? b.user_id : null;
  const sig = resolveSignals(e, { userId, ip, explicit: firstOf(readSignals(b, (m, p) => { throw bad(m, p); }), headerSignals(c.request.headers)) });
  const user = userId ? e.db.users.get(userId) : undefined;
  const target = TARGETS.includes(b.target_type as string) ? (b.target_type as string) : 'user';
  const ctx: AccessCtx = {
    stage,
    applicationId: typeof b.application_id === 'string' ? b.application_id : null,
    userId,
    groupIds: strs('groups') ?? [],
    orgIds: strs('orgs') ?? [],
    roles: strs('roles') ?? [],
    zoneIds: strs('zone_ids') ?? (e.generic.get('network_zones')?.all() ?? []).filter((z) => zoneMatches(e, z, ip)).map((z) => z.id),
    hasIp: !!ip,
    country: sig.country ?? null,
    riskLevel: sig.riskLevel ?? null,
    deviceTrust: sig.deviceTrust ?? null,
    authMethods: sig.authMethods ?? [],
    devicePlatform: sig.devicePlatform ?? null,
    osVersion: sig.osVersion ?? null,
    clientType: sig.clientType ?? null,
    userRiskLevel: sig.userRiskLevel ?? null,
    principalId: typeof b.principal_id === 'string' ? b.principal_id : null,
    userAttributes: b.user_attributes && typeof b.user_attributes === 'object' && !Array.isArray(b.user_attributes) ? (b.user_attributes as Obj) : (user?.public_metadata ?? {}),
    now: new Date(typeof b.now === 'number' ? b.now : e.clock.now()),
  };
  const live = rows.filter((p) => (!p.stages?.length || p.stages.includes(stage)) && (p.targets?.length ? p.targets : ['user']).includes(target)).sort((a, z) => (a.priority ?? 100) - (z.priority ?? 100));
  const enforced = live.filter((p) => p.mode !== 'report_only');
  const report = live.filter((p) => p.mode === 'report_only');
  const dec = evalSet(enforced, ctx);
  const would = report.length ? evalSet(live, ctx) : null;
  // What the matched policies ask of the request.
  const req = { mfa: false, acr: [] as string[], policy_acceptance: [] as string[], actions: [] as string[], auth_strength: null as string | null, sign_in_frequency_seconds: null as number | null, max_session_age_seconds: null as number | null, persistent_session: true, device_bound_session: false };
  const add = (xs: string[], v: string | undefined) => void (v && !xs.includes(v) && xs.push(v));
  for (const p of enforced.filter((x) => dec.matched.includes(x.id))) {
    for (const g of p.grants ?? []) {
      if (g.type === 'require_mfa') req.mfa = true;
      else if (g.type === 'require_acr') add(req.acr, g.value);
      else if (g.type === 'require_policy_acceptance') add(req.policy_acceptance, g.value);
      else if (g.type === 'require_action') add(req.actions, g.value);
      else if (g.type === 'require_password_change') add(req.actions, 'password_change');
      else if (g.type === 'require_auth_strength') req.auth_strength = !req.auth_strength || (RANK[g.value] ?? 0) > (RANK[req.auth_strength] ?? 0) ? g.value : req.auth_strength;
      else if (g.type === 'sign_in_frequency' && typeof g.seconds === 'number') req.sign_in_frequency_seconds = Math.min(req.sign_in_frequency_seconds ?? Infinity, g.seconds);
      else if (g.type === 'max_session_age' && typeof g.seconds === 'number') req.max_session_age_seconds = Math.min(req.max_session_age_seconds ?? Infinity, g.seconds);
      else if (g.type === 'persistent_session' && g.allow === false) req.persistent_session = false;
      else if (g.type === 'require_device_bound_session') req.device_bound_session = true;
    }
  }
  const stepUp = req.mfa || req.acr.length || req.policy_acceptance.length || req.actions.length || req.auth_strength || req.sign_in_frequency_seconds !== null || req.max_session_age_seconds !== null || req.device_bound_session;
  const decision = dec.blockedBy ? 'block' : stepUp ? 'step_up' : 'allow';
  const mfaVerified = b.mfa_verified === true;
  const acr = strs('acr') ?? [];
  const unmet: string[] = [];
  if (req.mfa && !mfaVerified) unmet.push('mfa');
  for (const a of req.acr) if (!acr.includes(a)) unmet.push(`acr:${a}`);
  for (const p of req.policy_acceptance) if (!(strs('accepted_policies') ?? []).includes(p)) unmet.push(`policy_acceptance:${p}`);
  for (const a of req.actions) if (a === 'password_change' ? !b.password_changed && !(strs('completed_actions') ?? []).includes(a) : !(strs('completed_actions') ?? []).includes(a)) unmet.push(`action:${a}`);
  if (req.auth_strength) {
    const have = strength(ctx.authMethods, mfaVerified);
    if (!have || RANK[have]! < RANK[req.auth_strength]!) unmet.push(`auth_strength:${req.auth_strength}`);
  }
  if (req.sign_in_frequency_seconds !== null && !((typeof b.last_auth_age_seconds === 'number' ? b.last_auth_age_seconds : Infinity) <= req.sign_in_frequency_seconds)) unmet.push('sign_in_frequency');
  if (req.max_session_age_seconds !== null && !((typeof b.session_age_seconds === 'number' ? b.session_age_seconds : 0) <= req.max_session_age_seconds)) unmet.push('max_session_age');
  if (req.device_bound_session && b.device_bound_session !== true) unmet.push('device_bound_session');
  const wouldReport = would && would.matched.some((id) => report.some((r) => r.id === id)) ? would : null;
  return { object: 'access_policy_simulation', decision, matched: dec.matched, blocked_by: dec.blockedBy ?? null, requirements: req, unmet, report_only: wouldReport ? { decision: wouldReport.decision, matched: wouldReport.matched, blocked_by: wouldReport.blockedBy ?? null } : null };
}

const signalWire = (s: Signals): Obj => ({ ...(s.country ? { country: s.country } : {}), ...(s.riskLevel ? { risk_level: s.riskLevel } : {}), ...(s.userRiskLevel ? { user_risk_level: s.userRiskLevel } : {}), ...(s.deviceTrust ? { device_trust: s.deviceTrust } : {}), ...(s.authMethods ? { auth_methods: s.authMethods } : {}), ...(s.clientType ? { client_type: s.clientType } : {}), ...(s.devicePlatform ? { device_platform: s.devicePlatform } : {}), ...(s.osVersion ? { os_version: s.osVersion } : {}) });
const signalDump = (e: Engine): Obj => {
  const s = signalState(e);
  return { defaults: signalWire(s.defaults), users: Object.fromEntries([...s.users].map(([k, v]) => [k, signalWire(v)])), ips: Object.fromEntries(s.ips) };
};

function accessHandlers(): RouteDef[] {
  return [
    { method: 'POST', pattern: '/v1/access_policies/simulate', scope: 'access_policies:read', handler: (c) => ({ body: simulate(c) }) },
    {
      method: 'POST',
      pattern: '/v1/network_zones/:id/check',
      scope: 'network_acls:read',
      handler: (c) => {
        const e = c.engine;
        const z = e.generic.get('network_zones')?.get(c.params.id);
        if (!z) throw new EmulatorError('NOT_FOUND', 'Unknown network zone.');
        const ip = c.body.ip;
        if (typeof ip !== 'string' || !ip.trim()) throw bad('ip is required.', 'ip');
        const f = ipFacts(e, ip.trim());
        // shortcut: the zone's enabled flag is not consulted (the generic zone row defaults it to false).
        return { body: { object: 'network_zone_check', zone_id: z.id, ip: ip.trim(), matches: zoneMatches(e, z, ip.trim()), facts: { country: f.country, asn: f.asn, tor: f.tor, datacenter: f.datacenter } } };
      },
    },
    // ── emulator control: where an address is, and the risk and device signals ──
    { method: 'GET', pattern: '/__emulator/access/signals', public: true, handler: (c) => ({ body: signalDump(c.engine) }) },
    {
      // Instance-wide default signals, or one user's with `user_id`. A PUT replaces that set.
      method: 'PUT',
      pattern: '/__emulator/access/signals',
      public: true,
      handler: (c) => {
        const s = signalState(c.engine);
        const sig = readSignals(c.body, (m, p) => { throw bad(m, p); });
        if (c.body.user_id !== undefined) {
          if (typeof c.body.user_id !== 'string' || !c.body.user_id) throw bad('user_id must be a user id.', 'user_id');
          s.users.set(c.body.user_id, sig);
        } else s.defaults = sig;
        return { body: signalDump(c.engine) };
      },
    },
    {
      // Facts for addresses: `{ ips: { "203.0.113.5": { country, asn, tor, datacenter } } }` (merged by address).
      method: 'PUT',
      pattern: '/__emulator/access/ip_facts',
      public: true,
      handler: (c) => {
        const s = signalState(c.engine);
        const ips = obj(c.body.ips);
        for (const [ip, raw] of Object.entries(ips)) {
          const f = obj(raw);
          if (f.country !== undefined && f.country !== null && !(typeof f.country === 'string' && /^[A-Za-z]{2}$/.test(f.country))) throw bad('country is a two-letter code.', `ips.${ip}.country`);
          if (f.asn !== undefined && f.asn !== null && !Number.isInteger(f.asn)) throw bad('asn is an integer.', `ips.${ip}.asn`);
          s.ips.set(ip, { ...noFacts(), country: typeof f.country === 'string' ? f.country.toUpperCase() : null, asn: typeof f.asn === 'number' ? f.asn : null, tor: typeof f.tor === 'boolean' ? f.tor : null, datacenter: typeof f.datacenter === 'boolean' ? f.datacenter : null });
        }
        return { body: signalDump(c.engine) };
      },
    },
    { method: 'DELETE', pattern: '/__emulator/access/signals', public: true, handler: (c) => ((signalState(c.engine).ips.clear(), signalState(c.engine).users.clear(), (signalState(c.engine).defaults = {})), { body: { ok: true } }) },
  ];
}

export function emu4AuthzHandlers(): RouteDef[] {
  return [...fgaHandlers(), ...templateHandlers(), ...accessHandlers(), ...emu4TrustAuthzHandlers()];
}
