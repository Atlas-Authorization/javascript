/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * The relationship-model engine behind the FGA routes: an OpenFGA-style authorization model (JSON `type_definitions` or DSL
 * text) with the six rewrite operators (direct, computed, tuple-to-userset, union, intersection, exclusion), tuple
 * conditions over a small CEL subset, and check / list-objects / list-users / expand over a set of tuples.
 *
 * shortcut: conditions support comparisons, boolean and arithmetic operators, `in`, field and index access, list literals
 * and the string functions startsWith, endsWith, contains, matches, size; no ipaddress, duration or map-typed parameters.
 * Upgrade by running the real engine if a model depends on those.
 */

export class ModelError extends Error {
  constructor(readonly errors: string[]) {
    super(errors.join(' '));
  }
}
export class TupleError extends Error {}

type Us = any;
export interface Ref {
  type: string;
  relation?: string;
  wildcard?: Record<string, never>;
  condition?: string;
}
export interface Compiled {
  types: Map<string, Map<string, Us>>;
  refs: Map<string, Map<string, Ref[]>>;
  conds: Map<string, { params: Map<string, string>; ast: Cel }>;
}
export interface FgaTuple {
  user: string;
  relation: string;
  object: string;
  condition?: { name: string; context?: Record<string, unknown> };
}

// ── DSL ──

const IDENT = /^[A-Za-z0-9_][A-Za-z0-9_-]*$/;
const isIdent = (s: string | undefined): s is string => !!s && IDENT.test(s);

function parseRefs(body: string): Ref[] {
  return body.split(',').map((raw) => {
    const m = /^\s*([A-Za-z0-9_-]+)(?::(\*)|#([A-Za-z0-9_-]+))?(?:\s+with\s+([A-Za-z0-9_-]+))?\s*$/.exec(raw);
    if (!m) throw new ModelError([`Cannot read the type restriction "${raw.trim()}".`]);
    return { type: m[1]!, ...(m[3] ? { relation: m[3] } : {}), ...(m[2] ? { wildcard: {} as Record<string, never> } : {}), ...(m[4] ? { condition: m[4] } : {}) };
  });
}

/** Parse one `define` expression into a rewrite and the direct type restrictions it names. */
function parseExpr(src: string, refs: Ref[]): Us {
  const toks = src.match(/\[[^\]]*\]|\(|\)|[A-Za-z0-9_-]+|\S/g) ?? [];
  let i = 0;
  const primary = (): Us => {
    const t = toks[i++];
    if (t === undefined) throw new ModelError(['The relation definition ends too early.']);
    if (t === '(') {
      const e = expr();
      if (toks[i++] !== ')') throw new ModelError(['Missing ")" in a relation definition.']);
      return e;
    }
    if (t.startsWith('[')) {
      refs.push(...parseRefs(t.slice(1, -1)));
      return { this: {} };
    }
    if (!isIdent(t) || t === 'or' || t === 'and' || t === 'but') throw new ModelError([`Unexpected "${t}" in a relation definition.`]);
    if (toks[i] === 'from') {
      const ts = toks[i + 1];
      if (!isIdent(ts)) throw new ModelError([`"${t} from" needs a relation name.`]);
      i += 2;
      return { tupleToUserset: { tupleset: { relation: ts }, computedUserset: { relation: t } } };
    }
    return { computedUserset: { relation: t } };
  };
  const expr = (): Us => {
    const first = primary();
    const op = toks[i];
    if (op === 'or' || op === 'and') {
      const child = [first];
      while (toks[i] === op) {
        i++;
        child.push(primary());
      }
      return { [op === 'or' ? 'union' : 'intersection']: { child } };
    }
    if (op === 'but') {
      if (toks[i + 1] !== 'not') throw new ModelError(['Expected "but not".']);
      i += 2;
      return { difference: { base: first, subtract: primary() } };
    }
    return first;
  };
  const out = expr();
  if (i < toks.length && toks[i] !== ')') throw new ModelError([`Unexpected "${toks[i]}" in a relation definition (mix "or", "and" and "but not" with parentheses).`]);
  return out;
}

/** OpenFGA DSL text to the JSON model. */
export function dslToModel(dsl: string): any {
  const defs: any[] = [];
  const conditions: Record<string, any> = {};
  let schema = '1.1';
  const lines = dsl.split(/\r?\n/);
  let cur: any = null;
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n]!.replace(/\s+#.*$/, '').replace(/^\s*#.*$/, '').trim();
    if (!line || line === 'model' || line === 'relations') continue;
    let m: RegExpExecArray | null;
    if ((m = /^schema\s+(\S+)$/.exec(line))) schema = m[1]!;
    else if ((m = /^type\s+([A-Za-z0-9_-]+)$/.exec(line))) defs.push((cur = { type: m[1]!, relations: {}, metadata: { relations: {} } }));
    else if ((m = /^condition\s+([A-Za-z0-9_]+)\s*\(([^)]*)\)\s*\{(.*)$/.exec(line))) {
      let body = m[3]!;
      while (!/\}\s*$/.test(body) && n + 1 < lines.length) body += `\n${lines[++n]!}`;
      const parameters: Record<string, any> = {};
      for (const p of m[2]!.split(',').map((s) => s.trim()).filter(Boolean)) {
        const pm = /^([A-Za-z0-9_]+)\s*:\s*(.+)$/.exec(p);
        if (!pm) throw new ModelError([`Cannot read the condition parameter "${p}".`]);
        parameters[pm[1]!] = { type_name: `TYPE_NAME_${pm[2]!.trim().replace(/<.*$/, '').toUpperCase()}` };
      }
      conditions[m[1]!] = { name: m[1]!, expression: body.replace(/\}\s*$/, '').trim(), parameters };
    } else if ((m = /^define\s+([A-Za-z0-9_-]+)\s*:\s*(.+)$/.exec(line))) {
      if (!cur) throw new ModelError([`"define ${m[1]}" is outside a type.`]);
      const refs: Ref[] = [];
      cur.relations[m[1]!] = parseExpr(m[2]!, refs);
      cur.metadata.relations[m[1]!] = { directly_related_user_types: refs };
    } else throw new ModelError([`Cannot read the model line "${line}".`]);
  }
  return { schema_version: schema, type_definitions: defs, ...(Object.keys(conditions).length ? { conditions } : {}) };
}

// ── validation ──

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);

function checkUs(node: unknown, own: Set<string>, all: Set<string>, path: string, errors: string[]): void {
  if (!isObj(node) || Object.keys(node).length !== 1) return void errors.push(`${path}: a userset must be an object with exactly one operator.`);
  const op = Object.keys(node)[0]!;
  const v = (node as any)[op];
  if (op === 'this') return;
  if (op === 'computedUserset') {
    if (!isObj(v) || typeof v.relation !== 'string') errors.push(`${path}.computedUserset: requires a string relation.`);
    else if (!own.has(v.relation)) errors.push(`${path}.computedUserset: relation '${v.relation}' is not defined on this type.`);
  } else if (op === 'tupleToUserset') {
    const ts = v?.tupleset?.relation;
    const cu = v?.computedUserset?.relation;
    if (typeof ts !== 'string' || typeof cu !== 'string') errors.push(`${path}.tupleToUserset: requires tupleset and computedUserset relations.`);
    else {
      if (!own.has(ts)) errors.push(`${path}.tupleToUserset.tupleset: relation '${ts}' is not defined on this type.`);
      if (!all.has(cu)) errors.push(`${path}.tupleToUserset.computedUserset: relation '${cu}' is not defined on any type.`);
    }
  } else if (op === 'union' || op === 'intersection') {
    if (!isObj(v) || !Array.isArray(v.child) || !v.child.length) errors.push(`${path}.${op}: requires a non-empty child array.`);
    else v.child.forEach((c: unknown, i: number) => checkUs(c, own, all, `${path}.${op}.child[${i}]`, errors));
  } else if (op === 'difference') {
    if (!isObj(v) || !('base' in v) || !('subtract' in v)) errors.push(`${path}.difference: requires base and subtract.`);
    else (checkUs(v.base, own, all, `${path}.difference.base`, errors), checkUs(v.subtract, own, all, `${path}.difference.subtract`, errors));
  } else errors.push(`${path}: unknown userset operator '${op}'.`);
}

/** Validate and compile a JSON model. Throws ModelError with every problem found. */
export function compileModel(model: unknown): Compiled {
  const errors: string[] = [];
  if (!isObj(model) || !Array.isArray(model.type_definitions) || !model.type_definitions.length) throw new ModelError(['type_definitions must be a non-empty array.']);
  const defs: any[] = model.type_definitions;
  const typeNames = new Set<string>();
  for (const d of defs) {
    if (!isObj(d) || typeof d.type !== 'string' || !isIdent(d.type)) errors.push('Every type definition needs a type name.');
    else if (typeNames.has(d.type)) errors.push(`Type '${d.type}' is defined twice.`);
    else typeNames.add(d.type);
  }
  const allRel = new Set(defs.flatMap((d) => Object.keys(isObj(d?.relations) ? d.relations : {})));
  const types = new Map<string, Map<string, Us>>();
  const refs = new Map<string, Map<string, Ref[]>>();
  for (const d of defs) {
    if (!isObj(d) || typeof d.type !== 'string') continue;
    const rels = isObj(d.relations) ? d.relations : {};
    const own = new Set(Object.keys(rels));
    types.set(d.type, new Map(Object.entries(rels)));
    for (const [r, node] of Object.entries(rels)) checkUs(node, own, allRel, `${d.type}#${r}`, errors);
    const meta = new Map<string, Ref[]>();
    for (const [r, m] of Object.entries<any>(isObj(d.metadata?.relations) ? d.metadata.relations : {})) meta.set(r, Array.isArray(m?.directly_related_user_types) ? m.directly_related_user_types : []);
    refs.set(d.type, meta);
  }
  const conds = new Map<string, { params: Map<string, string>; ast: Cel }>();
  for (const [name, c] of Object.entries<any>(isObj(model.conditions) ? model.conditions : {})) {
    try {
      if (typeof c?.expression !== 'string') throw new CelError('expression is required');
      conds.set(name, { params: new Map(Object.entries<any>(c.parameters ?? {}).map(([k, p]) => [k, String(p?.type_name ?? '')])), ast: parseCel(c.expression) });
    } catch (err) {
      errors.push(`condition '${name}': ${err instanceof Error ? err.message : 'invalid expression'}.`);
    }
  }
  for (const [t, m] of refs) {
    for (const [r, list] of m) {
      for (const ref of list) {
        if (!typeNames.has(ref.type)) errors.push(`${t}#${r}: unknown type '${ref.type}' in the type restriction.`);
        else if (ref.relation && !types.get(ref.type)?.has(ref.relation)) errors.push(`${t}#${r}: relation '${ref.relation}' is not defined on type '${ref.type}'.`);
        if (ref.condition && !conds.has(ref.condition)) errors.push(`${t}#${r}: condition '${ref.condition}' is not defined.`);
      }
    }
  }
  if (errors.length) throw new ModelError(errors);
  return { types, refs, conds };
}

/** The compiled form of a stored model row's `model` value, or null for a model the strict engine does not govern (DSL text kept as-is). */
const compiledCache = new WeakMap<object, Compiled | null>();
export function compileStored(model: unknown): Compiled | null {
  if (!isObj(model) || !Array.isArray(model.type_definitions)) return null;
  if (compiledCache.has(model)) return compiledCache.get(model)!;
  let out: Compiled | null = null;
  try {
    out = compileModel(model);
  } catch {
    out = null;
  }
  compiledCache.set(model, out);
  return out;
}

// ── tuples ──

interface PUser {
  type: string;
  id: string;
  rel: string | null;
  wild: boolean;
}
export function parseUser(s: string): PUser {
  const i = s.indexOf(':');
  if (i <= 0 || i === s.length - 1) throw new TupleError(`Malformed user '${s}': expected 'type:id', 'type:id#relation' or 'type:*'.`);
  const rest = s.slice(i + 1);
  const h = rest.indexOf('#');
  if (h < 0) return { type: s.slice(0, i), id: rest, rel: null, wild: rest === '*' };
  if (h === 0 || h === rest.length - 1 || rest.startsWith('*')) throw new TupleError(`Malformed userset '${s}'.`);
  return { type: s.slice(0, i), id: rest.slice(0, h), rel: rest.slice(h + 1), wild: false };
}
export function parseObject(s: string): { type: string; id: string } {
  const i = s.indexOf(':');
  if (i <= 0 || i === s.length - 1 || s.includes('#')) throw new TupleError(`Malformed object '${s}': expected 'type:id'.`);
  return { type: s.slice(0, i), id: s.slice(i + 1) };
}

/** Write-time type validation: the same rules the real store applies against the latest model. Null when allowed. */
export function validateTuple(m: Compiled, t: FgaTuple): string | null {
  const o = parseObject(t.object);
  if (!m.types.has(o.type)) return `unknown object type '${o.type}'.`;
  if (!m.types.get(o.type)!.has(t.relation)) return `relation '${t.relation}' is not defined on type '${o.type}'.`;
  if (t.condition) {
    const c = m.conds.get(t.condition.name);
    if (!c) return `condition '${t.condition.name}' is not defined in the authorization model.`;
    for (const k of Object.keys(t.condition.context ?? {})) if (!c.params.has(k)) return `condition '${t.condition.name}' has no parameter '${k}'.`;
  }
  const allowed = m.refs.get(o.type)?.get(t.relation);
  if (!allowed?.length) return null;
  const u = parseUser(t.user);
  const ok = allowed.some((r) => r.type === u.type && r.condition === t.condition?.name && (u.wild ? !!r.wildcard : u.rel !== null ? r.relation === u.rel : r.relation === undefined && r.wildcard === undefined));
  return ok ? null : `user '${t.user}' is not an allowed type for '${o.type}#${t.relation}'.`;
}

// ── CEL subset ──

class CelError extends Error {}
type Cel = any;
function celTokens(src: string): string[] {
  const out: string[] = [];
  const re = /\s*(?:(\d+\.\d+|\d+)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|([A-Za-z_][A-Za-z0-9_]*)|(==|!=|<=|>=|&&|\|\||[-+*/%<>!?:.,()[\]]))/y;
  let pos = 0;
  while (pos < src.length) {
    re.lastIndex = pos;
    const m = re.exec(src);
    if (!m) {
      if (/^\s*$/.test(src.slice(pos))) break;
      throw new CelError(`unexpected character at ${pos}`);
    }
    out.push(m[0].trim());
    pos = re.lastIndex;
  }
  return out;
}
function parseCel(src: string): Cel {
  const t = celTokens(src);
  let i = 0;
  const eat = (v: string) => (t[i] === v ? (i++, true) : false);
  const need = (v: string) => {
    if (!eat(v)) throw new CelError(`expected "${v}"`);
  };
  const ternary = (): Cel => {
    const c = or();
    if (!eat('?')) return c;
    const a = ternary();
    need(':');
    return ['?', c, a, ternary()];
  };
  const or = (): Cel => {
    let l = and();
    while (eat('||')) l = ['||', l, and()];
    return l;
  };
  const and = (): Cel => {
    let l = rel();
    while (eat('&&')) l = ['&&', l, rel()];
    return l;
  };
  const rel = (): Cel => {
    let l = add();
    for (;;) {
      const op = ['==', '!=', '<=', '>=', '<', '>', 'in'].find((o) => t[i] === o);
      if (!op) return l;
      i++;
      l = [op, l, add()];
    }
  };
  const add = (): Cel => {
    let l = mul();
    while (t[i] === '+' || t[i] === '-') l = [t[i++], l, mul()];
    return l;
  };
  const mul = (): Cel => {
    let l = unary();
    while (t[i] === '*' || t[i] === '/' || t[i] === '%') l = [t[i++], l, unary()];
    return l;
  };
  const unary = (): Cel => (eat('!') ? ['!', unary()] : eat('-') ? ['neg', unary()] : postfix());
  const args = (): Cel[] => {
    const a: Cel[] = [];
    while (t[i] !== ')') {
      a.push(ternary());
      if (!eat(',')) break;
    }
    need(')');
    return a;
  };
  const postfix = (): Cel => {
    let e = primary();
    for (;;) {
      if (eat('.')) {
        const name = t[i++];
        if (!name || !/^[A-Za-z_]/.test(name)) throw new CelError('expected a name after "."');
        e = eat('(') ? ['call', name, e, ...args()] : ['field', e, name];
      } else if (eat('[')) {
        const k = ternary();
        need(']');
        e = ['index', e, k];
      } else return e;
    }
  };
  const primary = (): Cel => {
    const x = t[i++];
    if (x === undefined) throw new CelError('the expression ends too early');
    if (/^\d/.test(x)) return ['lit', Number(x)];
    if (x[0] === '"' || x[0] === "'") return ['lit', JSON.parse(x[0] === "'" ? `"${x.slice(1, -1).replace(/"/g, '\\"')}"` : x)];
    if (x === '(') {
      const e = ternary();
      need(')');
      return e;
    }
    if (x === '[') {
      const items: Cel[] = [];
      while (t[i] !== ']') {
        items.push(ternary());
        if (!eat(',')) break;
      }
      need(']');
      return ['list', ...items];
    }
    if (x === 'true' || x === 'false') return ['lit', x === 'true'];
    if (x === 'null') return ['lit', null];
    if (/^[A-Za-z_]/.test(x)) return eat('(') ? ['fn', x, ...args()] : ['var', x];
    throw new CelError(`unexpected "${x}"`);
  };
  const out = ternary();
  if (i < t.length) throw new CelError(`unexpected "${t[i]}"`);
  return out;
}
function evalCel(n: Cel, vars: Map<string, unknown>): any {
  const ev = (x: Cel) => evalCel(x, vars);
  const need = (cond: boolean, msg: string) => {
    if (!cond) throw new CelError(msg);
  };
  switch (n[0]) {
    case 'lit':
      return n[1];
    case 'var':
      need(vars.has(n[1]), `parameter '${n[1]}' is missing`);
      return vars.get(n[1]);
    case 'list':
      return n.slice(1).map(ev);
    case '!':
      return !ev(n[1]);
    case 'neg':
      return -ev(n[1]);
    case '&&':
      return ev(n[1]) && ev(n[2]);
    case '||':
      return ev(n[1]) || ev(n[2]);
    case '?':
      return ev(n[1]) ? ev(n[2]) : ev(n[3]);
    case 'field': {
      const o = ev(n[1]);
      need(isObj(o) && n[2] in o, `no field '${n[2]}'`);
      return o[n[2]];
    }
    case 'index': {
      const o = ev(n[1]);
      const k = ev(n[2]);
      need((Array.isArray(o) || isObj(o)) && k in (o as object), 'index out of range');
      return (o as any)[k];
    }
    case 'fn': {
      const a = n.slice(2).map(ev);
      if (n[1] === 'size') return Array.isArray(a[0]) || typeof a[0] === 'string' ? a[0].length : (need(false, 'size needs a list or string'), 0);
      if (n[1] === 'int') return Math.trunc(Number(a[0]));
      if (n[1] === 'double') return Number(a[0]);
      if (n[1] === 'string') return String(a[0]);
      throw new CelError(`unknown function '${n[1]}'`);
    }
    case 'call': {
      const recv = ev(n[2]);
      const a = n.slice(3).map(ev);
      need(typeof recv === 'string' && typeof a[0] === 'string', `${n[1]} needs strings`);
      if (n[1] === 'startsWith') return recv.startsWith(a[0]);
      if (n[1] === 'endsWith') return recv.endsWith(a[0]);
      if (n[1] === 'contains') return recv.includes(a[0]);
      if (n[1] === 'matches') return new RegExp(a[0]).test(recv);
      throw new CelError(`unknown method '${n[1]}'`);
    }
    default: {
      const l = ev(n[1]);
      const r = ev(n[2]);
      switch (n[0]) {
        case '==':
          return JSON.stringify(l) === JSON.stringify(r);
        case '!=':
          return JSON.stringify(l) !== JSON.stringify(r);
        case 'in':
          return Array.isArray(r) ? r.some((x) => JSON.stringify(x) === JSON.stringify(l)) : isObj(r) ? l in r : (need(false, 'in needs a list or map'), false);
        case '+':
          return l + r;
        case '-':
          return l - r;
        case '*':
          return l * r;
        case '/':
          need(r !== 0, 'division by zero');
          return l / r;
        case '%':
          need(r !== 0, 'division by zero');
          return l % r;
        default:
          need(typeof l === typeof r, 'comparison of different types');
          return n[0] === '<' ? l < r : n[0] === '<=' ? l <= r : n[0] === '>' ? l > r : l >= r;
      }
    }
  }
}

// ── resolution ──

const MAX_DEPTH = 25;
interface Rec extends FgaTuple {
  u: PUser;
}
export class Resolver {
  private readonly by = new Map<string, Rec[]>();
  private readonly objects = new Map<string, Set<string>>();
  errors = 0;
  constructor(
    readonly model: Compiled,
    tuples: readonly FgaTuple[],
    private readonly context: Record<string, unknown> | undefined,
  ) {
    for (const t of tuples) {
      const key = `${t.object}#${t.relation}`;
      (this.by.get(key) ?? this.by.set(key, []).get(key)!).push({ ...t, u: parseUser(t.user) });
      const o = parseObject(t.object);
      (this.objects.get(o.type) ?? this.objects.set(o.type, new Set()).get(o.type)!).add(o.id);
    }
  }
  private read(object: string, relation: string): Rec[] {
    return this.by.get(`${object}#${relation}`) ?? [];
  }
  private holds(t: FgaTuple): boolean {
    if (!t.condition) return true;
    const c = this.model.conds.get(t.condition.name);
    try {
      if (!c) throw new CelError('unknown condition');
      const merged = { ...(this.context ?? {}), ...(t.condition.context ?? {}) };
      const vars = new Map<string, unknown>();
      for (const k of c.params.keys()) if (k in merged) vars.set(k, c.params.get(k) === 'TYPE_NAME_TIMESTAMP' && typeof merged[k] === 'string' ? Date.parse(merged[k] as string) : merged[k]);
      const out = evalCel(c.ast, vars);
      if (typeof out !== 'boolean') throw new CelError('condition did not evaluate to a bool');
      return out;
    } catch (err) {
      if (err instanceof CelError) {
        this.errors++;
        return false;
      }
      throw err;
    }
  }
  check(user: PUser, object: string, relation: string): boolean {
    const o = parseObject(object);
    return this.relation(user, o.type, o.id, relation, 0, new Set());
  }
  private relation(user: PUser, type: string, id: string, relation: string, depth: number, path: Set<string>): boolean {
    if (depth > MAX_DEPTH) return false;
    const frame = `${type}:${id}#${relation}`;
    if (path.has(frame)) return false;
    const rewrite = this.model.types.get(type)?.get(relation);
    if (!rewrite) return false;
    path.add(frame);
    try {
      return this.node(rewrite, user, type, id, relation, depth + 1, path);
    } finally {
      path.delete(frame);
    }
  }
  private node(n: Us, user: PUser, type: string, id: string, relation: string, depth: number, path: Set<string>): boolean {
    if ('this' in n) {
      for (const r of this.read(`${type}:${id}`, relation)) {
        if (!this.holds(r)) continue;
        if (r.u.wild) {
          if (r.u.type === user.type && !user.wild) return true;
        } else if (r.u.rel !== null) {
          if (this.relation(user, r.u.type, r.u.id, r.u.rel, depth, path)) return true;
        } else if (r.u.type === user.type && r.u.id === user.id && user.rel === null) return true;
      }
      return false;
    }
    if ('computedUserset' in n) return this.relation(user, type, id, n.computedUserset.relation, depth, path);
    if ('tupleToUserset' in n) {
      const cr = n.tupleToUserset.computedUserset.relation;
      for (const r of this.read(`${type}:${id}`, n.tupleToUserset.tupleset.relation)) {
        if (r.u.wild || r.u.rel !== null || !this.holds(r)) continue;
        if (this.model.types.get(r.u.type)?.has(cr) && this.relation(user, r.u.type, r.u.id, cr, depth, path)) return true;
      }
      return false;
    }
    if ('union' in n) return n.union.child.some((c: Us) => this.node(c, user, type, id, relation, depth, path));
    if ('intersection' in n) return n.intersection.child.every((c: Us) => this.node(c, user, type, id, relation, depth, path));
    if (!this.node(n.difference.base, user, type, id, relation, depth, path)) return false;
    const before = this.errors;
    const sub = this.node(n.difference.subtract, user, type, id, relation, depth, path);
    // An exclusion that could not be evaluated denies instead of reading as "not excluded".
    return this.errors > before ? false : !sub;
  }
  /** Ids of `type` objects the user holds `relation` on (candidates are the objects named in any tuple). */
  listObjects(user: PUser, relation: string, type: string): string[] {
    return [...(this.objects.get(type) ?? [])].filter((id) => this.relation(user, type, id, relation, 0, new Set())).sort();
  }
  /** Concrete users of `userType` that hold `relation` on the object. */
  listUsers(object: string, relation: string, userType: string): string[] {
    const o = parseObject(object);
    const ids = new Set<string>();
    for (const list of this.by.values()) for (const r of list) if (r.u.type === userType && !r.u.wild && r.u.rel === null) ids.add(r.u.id);
    return [...ids].filter((id) => this.relation({ type: userType, id, rel: null, wild: false }, o.type, o.id, relation, 0, new Set())).sort();
  }
  /** The userset tree of a relation (the rewrite structure with the direct users at each `this` leaf). */
  expand(object: string, relation: string): any {
    const o = parseObject(object);
    const walk = (n: Us, depth: number): any => {
      if (depth > MAX_DEPTH) return { type: 'leaf', users: [] };
      if ('this' in n) return { type: 'leaf', users: this.read(object, relation).map((r) => r.user) };
      if ('computedUserset' in n) return { type: 'leaf', users: [], computed: n.computedUserset.relation };
      if ('tupleToUserset' in n) return { type: 'leaf', users: [], tupleToUserset: { tupleset: n.tupleToUserset.tupleset.relation, computed: n.tupleToUserset.computedUserset.relation } };
      if ('union' in n) return { type: 'union', nodes: n.union.child.map((c: Us) => walk(c, depth + 1)) };
      if ('intersection' in n) return { type: 'intersection', nodes: n.intersection.child.map((c: Us) => walk(c, depth + 1)) };
      return { type: 'difference', base: walk(n.difference.base, depth + 1), subtract: walk(n.difference.subtract, depth + 1) };
    };
    const rewrite = this.model.types.get(o.type)?.get(relation);
    return rewrite ? walk(rewrite, 0) : { type: 'leaf', users: [] };
  }
}
