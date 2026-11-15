/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Reply, RouteContext } from './engine';
import { EmulatorError, notFound } from './errors';
import type { Obj } from './openapi';
import { synthesize } from './openapi';
import { Table, paginate } from './store';

const singular = (s: string): string => (s.endsWith('ies') ? `${s.slice(0, -3)}y` : s.endsWith('ses') ? s.slice(0, -2) : s.endsWith('s') ? s.slice(0, -1) : s);

/**
 * The CRUD layer for every route without hand-written behaviour. It is driven only by the OpenAPI
 * document: collections create/list/get/update/delete rows shaped like the documented response;
 * other routes answer a minimal valid response (required fields only) and remember a singleton's body.
 * It does NOT model side effects of action routes. Behaviour that matters lives in `handlers/`.
 */
export function genericHandler(c: RouteContext): Reply {
  const { engine, op } = c;
  if (!op) throw new EmulatorError('ROUTE_NOT_FOUND', 'No such route.');
  const segs = op.path.split('/').filter(Boolean);
  const last = segs[segs.length - 1] ?? '';
  const isItem = /^\{.+\}$/.test(last);
  const staticSegs = segs.filter((s) => !s.startsWith('{') && s !== 'v1');
  const collection = staticSegs.join('/');
  const name = singular(staticSegs[staticSegs.length - 1] ?? 'resource');
  // allOf (e.g. an endpoint plus its create-only secret) is read as one object.
  const flat = (s: Obj | undefined): Obj | undefined => {
    const r = engine.index.resolve(s);
    if (!r?.allOf) return r;
    const parts = (r.allOf as Obj[]).map((p) => flat(p) ?? {});
    return { ...r, properties: Object.assign({}, ...parts.map((p) => p.properties)), required: parts.flatMap((p) => (p.required as string[]) ?? []) };
  };
  const resp = flat(op.successSchema);
  const paramNames = Object.keys(c.params);
  // The parent of a nested collection is the first path parameter; the item id is the last one for item routes.
  const itemId = isItem ? c.params[paramNames[paramNames.length - 1] ?? ''] : undefined;
  const parent = paramNames.length > (isItem ? 1 : 0) ? c.params[paramNames[0] ?? ''] : undefined;
  const table = () => {
    let t = engine.generic.get(collection);
    if (!t) {
      t = new Table(collection, engine.clock.now, name.replace(/[^a-z]/gi, '').slice(0, 12) || 'obj');
      engine.generic.set(collection, t);
    }
    return t;
  };
  const props: Obj = resp?.properties ?? {};
  const reqProps: Obj = engine.index.resolve(op.requestSchema)?.properties ?? {};
  const known = (body: Obj): Obj => {
    if (!resp?.properties) return body;
    const out: Obj = {};
    // A field the request documents is stored even when the response schema omits it (a plan's amount, interval, currency).
    for (const [k, v] of Object.entries(body)) if (k in props || k in reqProps) out[k] = v;
    return out;
  };
  const stamp = (key: 'created_at' | 'updated_at'): Obj => {
    const p = engine.index.resolve(props[key]);
    if (!p) return {};
    const types = ([] as string[]).concat(p.type ?? []);
    return { [key]: types.includes('string') ? new Date(engine.clock.now()).toISOString() : engine.clock.now() };
  };
  const base = (): Obj => {
    const s = synthesize(engine.index, resp);
    return s && typeof s === 'object' && !Array.isArray(s) ? s : {};
  };
  const isListShape = resp?.properties?.data && ([] as string[]).concat(engine.index.resolve(resp.properties.data)?.type ?? []).includes('array');

  if (op.method === 'GET' && !isItem) {
    const rows = collection ? table().filter((r) => parent === undefined || r._parent === parent) : [];
    if (isListShape) {
      const filtered = rows.filter((r) => {
        for (const [k, v] of c.query) if (!['limit', 'starting_after', 'offset', 'query', 'cursor', 'order_by'].includes(k) && k in r && String(r[k]) !== v) return false;
        return true;
      });
      const limit = Math.min(Math.max(Number(c.query.get('limit') ?? 20) || 20, 1), 100);
      const page = paginate(filtered, { limit, startingAfter: c.query.get('starting_after') ?? undefined });
      return { body: { ...base(), object: 'list', ...page, data: page.data.map(({ _parent, ...r }) => r) } };
    }
    const kept = engine.singletons.get(op.path);
    return { body: { ...base(), ...(kept ?? {}) } };
  }

  if (op.method === 'GET' && isItem) {
    const row = table().get(itemId);
    if (!row || (parent !== undefined && row._parent !== parent)) throw notFound(name);
    const { _parent, ...out } = row;
    return { body: out };
  }

  // Name-keyed resources (JWT templates) carry `object` and `name` but no `id`; they are stored too.
  if (op.method === 'POST' && !isItem && (props.id || (resp?.required as string[] | undefined)?.includes('id') || (props.object && props.name))) {
    const t = table();
    const seed = base();
    delete seed.id; // the synthesized id is a placeholder; the table assigns the real one
    if (collection === 'workflows') seed.enabled = true; // the real API creates workflows enabled unless told otherwise
    const row = t.insert({ ...seed, ...known(c.body), ...stamp('created_at'), ...stamp('updated_at'), _parent: parent } as any);
    const objectConst = engine.index.resolve(props.object)?.const;
    t.update(row.id, { object: objectConst ?? name } as any);
    const { _parent, ...out } = t.get(row.id) as Obj;
    return { status: op.successStatus, body: out };
  }

  if ((op.method === 'PATCH' || op.method === 'PUT') && isItem) {
    const t = table();
    const row = t.get(itemId);
    if (!row || (parent !== undefined && row._parent !== parent)) throw notFound(name);
    t.update(row.id, { ...known(c.body), ...stamp('updated_at') } as any);
    const { _parent, ...out } = t.get(row.id) as Obj;
    return { body: out };
  }

  if (op.method === 'DELETE' && isItem) {
    const t = table();
    const row = t.get(itemId);
    if (!row || (parent !== undefined && row._parent !== parent)) throw notFound(name);
    t.delete(row.id);
    if (op.successStatus === 204) return { status: 204 };
    return { body: { ...base(), id: row.id, ...(props.deleted ? { deleted: true } : {}) } };
  }

  if ((op.method === 'PUT' || op.method === 'PATCH') && !isItem) {
    const next = { ...(engine.singletons.get(op.path) ?? {}), ...known(c.body) };
    engine.singletons.set(op.path, next);
    return { body: { ...base(), ...next } };
  }

  // An action route (POST .../something): a valid response with the request's matching fields echoed back.
  if (op.successStatus === 204) return { status: 204 };
  return { body: { ...base(), ...known(c.body) } };
}
