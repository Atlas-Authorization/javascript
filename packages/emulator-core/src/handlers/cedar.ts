/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * A small Cedar-subset evaluator for the emulator's ABAC layer.
 *
 * shortcut: supports permit/forbid; `@annotations` (ignored); scope constraints `==`, `in` (entity or list) and `is`
 * on principal, action and resource; `when` / `unless` clauses; `&& || !`, `== != < <= > >=`, `in`, `has`, `like`
 * (`*` wildcard), `is`, `+ - *`, `if/then/else`, `.attr` and `["attr"]` access, set and record literals and the
 * `contains` / `containsAll` / `containsAny` methods, policy templates (`?principal` / `?resource` slots, linked with
 * `linkCedarTemplate`) and the `decimal()` / `ip()` extension types with their methods. No `fga.check(...)`: a policy that
 * uses it does not parse and is skipped, like any unparseable policy. No schema validation.
 * Upgrade by running the real engine if you need the full language.
 */
import { AbacDecimal, AbacExtError, AbacIp, EXT_METHODS, extConstructor, extEqual, extMethod } from './cedar-ext';

export class CedarParseError extends Error {
  constructor(
    message: string,
    readonly position: number,
  ) {
    super(message);
  }
}
class EvalError extends Error {}

export interface EntityRef {
  type: string;
  id: string;
}
type Slot = '?principal' | '?resource';
type Scope = { op: 'any' } | { op: '=='; e: EntityRef } | { op: 'in'; es: EntityRef[] } | { op: 'is'; type: string; in?: EntityRef } | { op: 'slot=='; slot: Slot } | { op: 'slot_in'; slot: Slot } | { op: 'is_slot_in'; type: string; slot: Slot };
type Expr =
  | { k: 'lit'; v: any }
  | { k: 'ent'; e: EntityRef }
  | { k: 'var'; name: string }
  | { k: 'attr'; of: Expr; name: string }
  | { k: 'has'; of: Expr; name: string }
  | { k: 'not'; e: Expr }
  | { k: 'neg'; e: Expr }
  | { k: 'bin'; op: string; l: Expr; r: Expr }
  | { k: 'like'; e: Expr; pattern: string }
  | { k: 'is'; e: Expr; type: string; in?: Expr }
  | { k: 'if'; c: Expr; t: Expr; f: Expr }
  | { k: 'set'; items: Expr[] }
  | { k: 'record'; fields: Array<[string, Expr]> }
  | { k: 'call'; of: Expr; name: string; args: Expr[] }
  | { k: 'ext'; name: string; arg: string };
export interface CedarPolicy {
  effect: 'permit' | 'forbid';
  principal: Scope;
  action: Scope;
  resource: Scope;
  /** `when` clauses as written; an `unless` clause is stored negated. */
  conditions: Expr[];
}
export interface CedarEntity {
  type: string;
  id: string;
  attributes?: Record<string, unknown>;
  parents?: string[];
}
export interface CedarRequest {
  principal: CedarEntity;
  action: { id: string; type?: string };
  resource: CedarEntity;
  context?: Record<string, unknown>;
  entities?: CedarEntity[];
}
export interface CedarOutcome {
  index: number;
  effect: 'permit' | 'forbid';
  matched: boolean;
  scoped: boolean;
  error?: string;
}

// ── tokens ──
interface Tok {
  t: 'id' | 'str' | 'int' | 'p' | 'eof';
  v: string;
  pos: number;
}
function lex(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) i++;
    else if (c === '/' && src[i + 1] === '/') while (i < src.length && src[i] !== '\n') i++;
    else if (c === '"') {
      let j = i + 1;
      let v = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\') {
          const n = src[j + 1];
          v += n === 'n' ? '\n' : n === 't' ? '\t' : n === '0' ? '\0' : n === '*' ? '\\*' : (n ?? '');
          j += 2;
        } else v += src[j++];
      }
      if (j >= src.length) throw new CedarParseError('Unterminated string.', i);
      out.push({ t: 'str', v, pos: i });
      i = j + 1;
    } else if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j]!)) j++;
      out.push({ t: 'id', v: src.slice(i, j), pos: i });
      i = j;
    } else if (/[0-9]/.test(c)) {
      let j = i;
      while (j < src.length && /[0-9]/.test(src[j]!)) j++;
      out.push({ t: 'int', v: src.slice(i, j), pos: i });
      i = j;
    } else {
      const two = src.slice(i, i + 2);
      if (['::', '==', '!=', '<=', '>=', '&&', '||'].includes(two)) {
        out.push({ t: 'p', v: two, pos: i });
        i += 2;
      } else if ('(){}[],;.<>!@:+-*?'.includes(c)) {
        out.push({ t: 'p', v: c, pos: i });
        i++;
      } else throw new CedarParseError(`Unexpected character "${c}".`, i);
    }
  }
  out.push({ t: 'eof', v: '', pos: src.length });
  return out;
}

class Parser {
  private i = 0;
  constructor(
    private readonly toks: Tok[],
    private readonly templates = false,
  ) {}
  private get cur(): Tok {
    return this.toks[this.i]!;
  }
  private is(v: string): boolean {
    return this.cur.t !== 'str' && this.cur.v === v && this.cur.t !== 'eof';
  }
  // Read the current token fresh: `cur` is a getter, so TS would otherwise keep an earlier narrowing after tokens are consumed.
  private isId(v: string): boolean {
    const c = this.cur;
    return c.t === 'id' && c.v === v;
  }
  private isStr(): boolean {
    return this.cur.t === 'str';
  }
  private eat(v: string): boolean {
    if (!this.is(v)) return false;
    this.i++;
    return true;
  }
  private need(v: string): void {
    if (!this.eat(v)) throw new CedarParseError(`Expected "${v}".`, this.cur.pos);
  }
  private ident(): string {
    if (this.cur.t !== 'id') throw new CedarParseError('Expected a name.', this.cur.pos);
    return this.toks[this.i++]!.v;
  }
  private str(): string {
    if (this.cur.t !== 'str') throw new CedarParseError('Expected a string.', this.cur.pos);
    return this.toks[this.i++]!.v;
  }

  policies(): CedarPolicy[] {
    const out: CedarPolicy[] = [];
    while (this.cur.t !== 'eof') out.push(this.policy());
    return out;
  }
  private policy(): CedarPolicy {
    while (this.eat('@')) {
      this.ident();
      if (this.eat('(')) {
        this.str();
        this.need(')');
      }
    }
    const effect = this.ident();
    if (effect !== 'permit' && effect !== 'forbid') throw new CedarParseError('A policy starts with permit or forbid.', this.toks[this.i - 1]!.pos);
    this.need('(');
    const principal = this.scope('principal');
    this.need(',');
    const action = this.scope('action');
    this.need(',');
    const resource = this.scope('resource');
    this.need(')');
    const conditions: Expr[] = [];
    while (this.cur.t === 'id' && (this.cur.v === 'when' || this.cur.v === 'unless')) {
      const unless = this.ident() === 'unless';
      this.need('{');
      const e = this.expr();
      this.need('}');
      conditions.push(unless ? { k: 'not', e } : e);
    }
    this.need(';');
    return { effect, principal, action, resource, conditions };
  }
  private entity(): EntityRef {
    const parts = [this.ident()];
    this.need('::');
    while (this.cur.t === 'id') {
      parts.push(this.ident());
      this.need('::');
    }
    return { type: parts.join('::'), id: this.str() };
  }
  private slot(name: string): Slot | null {
    if (!this.is('?')) return null;
    const pos = this.cur.pos;
    this.i++;
    if (!this.templates) throw new CedarParseError('A slot is only allowed in a policy template.', pos);
    if (this.ident() !== name) throw new CedarParseError(`The ${name} scope takes ?${name}.`, pos);
    return `?${name}` as Slot;
  }
  private scope(name: string): Scope {
    if (this.ident() !== name) throw new CedarParseError(`Expected ${name}.`, this.toks[this.i - 1]!.pos);
    const slotName = name === 'principal' || name === 'resource' ? name : null;
    if (this.eat('==')) {
      const sl = slotName && this.slot(slotName);
      return sl ? { op: 'slot==', slot: sl } : { op: '==', e: this.entity() };
    }
    if (this.cur.t === 'id' && this.cur.v === 'in') {
      this.i++;
      const sl = slotName && this.slot(slotName);
      if (sl) return { op: 'slot_in', slot: sl };
      if (this.eat('[')) {
        const es: EntityRef[] = [];
        while (!this.is(']')) {
          es.push(this.entity());
          if (!this.eat(',')) break;
        }
        this.need(']');
        return { op: 'in', es };
      }
      return { op: 'in', es: [this.entity()] };
    }
    if (this.cur.t === 'id' && this.cur.v === 'is') {
      this.i++;
      const parts = [this.ident()];
      while (this.eat('::')) parts.push(this.ident());
      const type = parts.join('::');
      if (this.isId('in')) {
        this.i++;
        const sl = slotName && this.slot(slotName);
        return sl ? { op: 'is_slot_in', type, slot: sl } : { op: 'is', type, in: this.entity() };
      }
      return { op: 'is', type };
    }
    return { op: 'any' };
  }

  expr(): Expr {
    if (this.cur.t === 'id' && this.cur.v === 'if') {
      this.i++;
      const c = this.expr();
      if (this.ident() !== 'then') throw new CedarParseError('Expected then.', this.cur.pos);
      const t = this.expr();
      if (this.ident() !== 'else') throw new CedarParseError('Expected else.', this.cur.pos);
      return { k: 'if', c, t, f: this.expr() };
    }
    return this.or();
  }
  private or(): Expr {
    let l = this.and();
    while (this.eat('||')) l = { k: 'bin', op: '||', l, r: this.and() };
    return l;
  }
  private and(): Expr {
    let l = this.rel();
    while (this.eat('&&')) l = { k: 'bin', op: '&&', l, r: this.rel() };
    return l;
  }
  private rel(): Expr {
    const l = this.add();
    for (const op of ['==', '!=', '<=', '>=', '<', '>']) if (this.eat(op)) return { k: 'bin', op, l, r: this.add() };
    if (this.cur.t === 'id') {
      const w = this.cur.v;
      if (w === 'in') {
        this.i++;
        return { k: 'bin', op: 'in', l, r: this.add() };
      }
      if (w === 'has') {
        this.i++;
        return { k: 'has', of: l, name: this.isStr() ? this.str() : this.ident() };
      }
      if (w === 'like') {
        this.i++;
        return { k: 'like', e: l, pattern: this.str() };
      }
      if (w === 'is') {
        this.i++;
        const parts = [this.ident()];
        while (this.eat('::')) parts.push(this.ident());
        if (this.cur.t === 'id' && this.cur.v === 'in') {
          this.i++;
          return { k: 'is', e: l, type: parts.join('::'), in: this.add() };
        }
        return { k: 'is', e: l, type: parts.join('::') };
      }
    }
    return l;
  }
  private add(): Expr {
    let l = this.mul();
    for (;;) {
      if (this.eat('+')) l = { k: 'bin', op: '+', l, r: this.mul() };
      else if (this.eat('-')) l = { k: 'bin', op: '-', l, r: this.mul() };
      else return l;
    }
  }
  private mul(): Expr {
    let l = this.unary();
    while (this.eat('*')) l = { k: 'bin', op: '*', l, r: this.unary() };
    return l;
  }
  private unary(): Expr {
    if (this.eat('!')) return { k: 'not', e: this.unary() };
    if (this.eat('-')) return { k: 'neg', e: this.unary() };
    return this.postfix();
  }
  private postfix(): Expr {
    let e = this.primary();
    for (;;) {
      if (this.eat('.')) {
        const name = this.ident();
        if (this.eat('(')) {
          const args: Expr[] = [];
          while (!this.is(')')) {
            args.push(this.expr());
            if (!this.eat(',')) break;
          }
          this.need(')');
          if (!(['contains', 'containsAll', 'containsAny', ...EXT_METHODS] as string[]).includes(name)) throw new CedarParseError(`Unsupported method "${name}".`, this.toks[this.i - 1]!.pos);
          e = { k: 'call', of: e, name, args };
        } else e = { k: 'attr', of: e, name };
      } else if (this.is('[')) {
        this.i++;
        const name = this.str();
        this.need(']');
        e = { k: 'attr', of: e, name };
      } else return e;
    }
  }
  private primary(): Expr {
    const t = this.cur;
    if (t.t === 'int') {
      this.i++;
      return { k: 'lit', v: Number(t.v) };
    }
    if (t.t === 'str') {
      this.i++;
      return { k: 'lit', v: t.v };
    }
    if (this.eat('(')) {
      const e = this.expr();
      this.need(')');
      return e;
    }
    if (this.eat('[')) {
      const items: Expr[] = [];
      while (!this.is(']')) {
        items.push(this.expr());
        if (!this.eat(',')) break;
      }
      this.need(']');
      return { k: 'set', items };
    }
    if (this.eat('{')) {
      const fields: Array<[string, Expr]> = [];
      while (!this.is('}')) {
        const key = this.cur.t === 'str' ? this.str() : this.ident();
        this.need(':');
        fields.push([key, this.expr()]);
        if (!this.eat(',')) break;
      }
      this.need('}');
      return { k: 'record', fields };
    }
    if (t.t === 'id') {
      if (t.v === 'true' || t.v === 'false') {
        this.i++;
        return { k: 'lit', v: t.v === 'true' };
      }
      if (['principal', 'action', 'resource', 'context'].includes(t.v)) {
        this.i++;
        return { k: 'var', name: t.v };
      }
      if ((t.v === 'ip' || t.v === 'decimal') && this.toks[this.i + 1]?.v === '(') {
        this.i += 2;
        const arg = this.str();
        this.need(')');
        try {
          extConstructor(t.v, arg);
        } catch (err) {
          throw new CedarParseError(err instanceof AbacExtError ? err.message : 'Invalid extension value.', t.pos);
        }
        return { k: 'ext', name: t.v, arg };
      }
      if (this.toks[this.i + 1]?.v === '::') return { k: 'ent', e: this.entity() };
    }
    throw new CedarParseError(`Unexpected "${t.v || 'end of input'}".`, t.pos);
  }
}

/** Parse a policy set; throws CedarParseError with the character position. */
export function parseCedar(source: string): CedarPolicy[] {
  return new Parser(lex(source)).policies();
}

/** Parse policy templates: like a policy set, but the principal and resource scopes may hold `?principal` / `?resource`. */
export function parseCedarTemplate(source: string): CedarPolicy[] {
  return new Parser(lex(source), true).policies();
}
export class CedarLinkError extends Error {}
const SLOTS = (p: CedarPolicy): Slot[] => [p.principal, p.resource].flatMap((s) => (s.op === 'slot==' || s.op === 'slot_in' || s.op === 'is_slot_in' ? [s.slot] : []));
/** The slots a template uses, sorted. */
export const cedarTemplateSlots = (policies: readonly CedarPolicy[]): Slot[] => [...new Set(policies.flatMap(SLOTS))].sort();
/** Fill a template's slots with entities, giving ordinary policies. A slot without an entity is an error. */
export function linkCedarTemplate(policies: readonly CedarPolicy[], values: { principal?: EntityRef; resource?: EntityRef }): CedarPolicy[] {
  const need = (slot: Slot): EntityRef => {
    const v = slot === '?principal' ? values.principal : values.resource;
    if (!v) throw new CedarLinkError(`The template uses ${slot}; give it a ${slot.slice(1)} entity.`);
    return v;
  };
  const fill = (c: Scope): Scope => (c.op === 'slot==' ? { op: '==', e: need(c.slot) } : c.op === 'slot_in' ? { op: 'in', es: [need(c.slot)] } : c.op === 'is_slot_in' ? { op: 'is', type: c.type, in: need(c.slot) } : c);
  return policies.map((p) => ({ ...p, principal: fill(p.principal), resource: fill(p.resource) }));
}

// ── evaluation ──
class Ent {
  constructor(
    readonly type: string,
    readonly id: string,
  ) {}
  get uid(): string {
    return `${this.type}::${this.id}`;
  }
}
const uid = (e: EntityRef) => `${e.type}::${e.id}`;

function like(s: string, pattern: string): boolean {
  const re = pattern
    .split(/(\\\*|\*)/)
    .map((p) => (p === '*' ? '.*' : p === '\\*' ? '\\*' : p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('');
  return new RegExp(`^${re}$`, 's').test(s);
}

class Evaluator {
  private readonly byUid = new Map<string, CedarEntity>();
  constructor(private readonly req: CedarRequest) {
    for (const e of req.entities ?? []) this.byUid.set(uid(e), e);
    this.byUid.set(uid(req.principal), req.principal);
    this.byUid.set(uid(req.resource), req.resource);
  }
  private ancestors(u: string): Set<string> {
    const seen = new Set<string>();
    const stack = [u];
    while (stack.length) for (const p of this.byUid.get(stack.pop()!)?.parents ?? []) if (!seen.has(p)) (seen.add(p), stack.push(p));
    return seen;
  }
  private isIn(a: Ent, b: Ent): boolean {
    return a.uid === b.uid || this.ancestors(a.uid).has(b.uid);
  }
  private conv(raw: unknown): any {
    if (Array.isArray(raw)) return raw.map((x) => this.conv(x));
    if (raw && typeof raw === 'object') {
      const o = raw as Record<string, unknown>;
      const extn = o.__extn as { fn?: string; arg?: unknown } | undefined;
      if (extn && typeof extn === 'object') {
        try {
          return extConstructor(String(extn.fn), extn.arg);
        } catch (err) {
          throw new EvalError(err instanceof Error ? err.message : 'Invalid extension value.');
        }
      }
      const ent = (o.__entity ?? (typeof o.type === 'string' && typeof o.id === 'string' && Object.keys(o).length === 2 ? o : null)) as EntityRef | null;
      if (ent) return new Ent(ent.type, ent.id);
      return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, this.conv(v)]));
    }
    if (typeof raw === 'number' && !Number.isInteger(raw)) throw new EvalError('Decimals are not supported.');
    if (raw === null || raw === undefined) throw new EvalError('Null is not a Cedar value.');
    return raw;
  }
  private subject(s: Scope, v: Ent): boolean {
    if (s.op === 'any') return true;
    if (s.op === 'slot==' || s.op === 'slot_in' || s.op === 'is_slot_in') return false; // an unlinked template never applies
    if (s.op === '==') return v.uid === uid(s.e);
    if (s.op === 'in') return s.es.some((e) => this.isIn(v, new Ent(e.type, e.id)));
    return v.type === s.type && (!s.in || this.isIn(v, new Ent(s.in.type, s.in.id)));
  }
  scoped(p: CedarPolicy): boolean {
    const r = this.req;
    return this.subject(p.principal, new Ent(r.principal.type, r.principal.id)) && this.subject(p.action, new Ent(r.action.type ?? 'Action', r.action.id)) && this.subject(p.resource, new Ent(r.resource.type, r.resource.id));
  }
  private eq(a: any, b: any): boolean {
    if (a instanceof AbacDecimal || a instanceof AbacIp || b instanceof AbacDecimal || b instanceof AbacIp) return (a instanceof AbacDecimal || a instanceof AbacIp) && (b instanceof AbacDecimal || b instanceof AbacIp) && extEqual(a, b);
    if (a instanceof Ent || b instanceof Ent) return a instanceof Ent && b instanceof Ent && a.uid === b.uid;
    if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x) => b.some((y) => this.eq(x, y)));
    if (a && b && typeof a === 'object' && typeof b === 'object') {
      const ka = Object.keys(a);
      return ka.length === Object.keys(b).length && ka.every((k) => k in b && this.eq(a[k], b[k]));
    }
    return a === b;
  }
  private bool(v: any): boolean {
    if (typeof v !== 'boolean') throw new EvalError('Expected a boolean.');
    return v;
  }
  private num(v: any): number {
    if (typeof v !== 'number') throw new EvalError('Expected a number.');
    return v;
  }
  private attrOf(of: any, name: string): any {
    if (of instanceof Ent) {
      const a = this.byUid.get(of.uid)?.attributes;
      if (!a || !(name in a) || a[name] === undefined) throw new EvalError(`${of.uid} has no attribute "${name}".`);
      return this.conv(a[name]);
    }
    if (of && typeof of === 'object' && !Array.isArray(of)) {
      if (!(name in of)) throw new EvalError(`No attribute "${name}".`);
      return of[name];
    }
    throw new EvalError(`Cannot read "${name}" of a non-record.`);
  }
  ev(x: Expr): any {
    const r = this.req;
    switch (x.k) {
      case 'lit':
        return x.v;
      case 'ent':
        return new Ent(x.e.type, x.e.id);
      case 'var':
        return x.name === 'principal' ? new Ent(r.principal.type, r.principal.id) : x.name === 'action' ? new Ent(r.action.type ?? 'Action', r.action.id) : x.name === 'resource' ? new Ent(r.resource.type, r.resource.id) : this.conv(r.context ?? {});
      case 'attr':
        return this.attrOf(this.ev(x.of), x.name);
      case 'has': {
        const of = this.ev(x.of);
        if (of instanceof Ent) {
          const a = this.byUid.get(of.uid)?.attributes;
          return !!a && x.name in a && a[x.name] !== undefined && a[x.name] !== null;
        }
        if (of && typeof of === 'object' && !Array.isArray(of)) return x.name in of;
        throw new EvalError('has needs a record or entity.');
      }
      case 'not':
        return !this.bool(this.ev(x.e));
      case 'neg':
        return -this.num(this.ev(x.e));
      case 'like': {
        const v = this.ev(x.e);
        if (typeof v !== 'string') throw new EvalError('like needs a string.');
        return like(v, x.pattern);
      }
      case 'is': {
        const v = this.ev(x.e);
        if (!(v instanceof Ent)) throw new EvalError('is needs an entity.');
        return v.type === x.type && (!x.in || this.isInAny(v, this.ev(x.in)));
      }
      case 'if':
        return this.bool(this.ev(x.c)) ? this.ev(x.t) : this.ev(x.f);
      case 'set':
        return x.items.map((i) => this.ev(i));
      case 'record':
        return Object.fromEntries(x.fields.map(([k, v]) => [k, this.ev(v)]));
      case 'ext':
        return extConstructor(x.name, x.arg);
      case 'call': {
        const of = this.ev(x.of);
        if (of instanceof AbacDecimal || of instanceof AbacIp) {
          try {
            return extMethod(x.name, of, x.args.map((a) => this.ev(a)));
          } catch (err) {
            throw new EvalError(err instanceof Error ? err.message : 'Invalid extension call.');
          }
        }
        if (!Array.isArray(of)) throw new EvalError(`${x.name} needs a set.`);
        const arg = this.ev(x.args[0]!);
        if (x.name === 'contains') return of.some((i) => this.eq(i, arg));
        if (!Array.isArray(arg)) throw new EvalError(`${x.name} needs a set.`);
        return x.name === 'containsAll' ? arg.every((a) => of.some((i) => this.eq(i, a))) : arg.some((a) => of.some((i) => this.eq(i, a)));
      }
      case 'bin': {
        if (x.op === '&&') return this.bool(this.ev(x.l)) && this.bool(this.ev(x.r));
        if (x.op === '||') return this.bool(this.ev(x.l)) || this.bool(this.ev(x.r));
        const l = this.ev(x.l);
        const rr = this.ev(x.r);
        switch (x.op) {
          case '==':
            return this.eq(l, rr);
          case '!=':
            return !this.eq(l, rr);
          case '<':
            return this.num(l) < this.num(rr);
          case '<=':
            return this.num(l) <= this.num(rr);
          case '>':
            return this.num(l) > this.num(rr);
          case '>=':
            return this.num(l) >= this.num(rr);
          case '+':
            return this.num(l) + this.num(rr);
          case '-':
            return this.num(l) - this.num(rr);
          case '*':
            return this.num(l) * this.num(rr);
          default:
            if (!(l instanceof Ent)) throw new EvalError('in needs an entity on the left.');
            return this.isInAny(l, rr);
        }
      }
    }
  }
  private isInAny(l: Ent, r: any): boolean {
    if (r instanceof Ent) return this.isIn(l, r);
    if (Array.isArray(r) && r.every((x) => x instanceof Ent)) return r.some((x: Ent) => this.isIn(l, x));
    throw new EvalError('in needs an entity or a set of entities on the right.');
  }
}

/** Every policy's outcome for a request. A policy that errors is reported with `error` and never matches. */
export function traceCedar(policies: readonly CedarPolicy[], req: CedarRequest): CedarOutcome[] {
  const ev = new Evaluator(req);
  return policies.map((p, index) => {
    const scoped = ev.scoped(p);
    if (!scoped) return { index, effect: p.effect, matched: false, scoped };
    try {
      let ok = true;
      for (const c of p.conditions) {
        const v = ev.ev(c);
        if (typeof v !== 'boolean') throw new EvalError('A condition must be a boolean.');
        if (!v) {
          ok = false;
          break;
        }
      }
      return { index, effect: p.effect, matched: ok, scoped };
    } catch (e) {
      return { index, effect: p.effect, matched: false, scoped, error: e instanceof Error ? e.message : 'Evaluation failed.' };
    }
  });
}

/** Cedar's rule: a matching forbid denies, otherwise a matching permit allows, otherwise deny. `determining` are the policy indexes that decided. */
export function decideCedar(outcomes: readonly CedarOutcome[]): { decision: 'allow' | 'deny'; determining: number[]; errors: Array<{ index: number; message: string }> } {
  const hit = (eff: string) => outcomes.filter((o) => o.matched && o.effect === eff).map((o) => o.index);
  const errors = outcomes.filter((o) => o.error).map((o) => ({ index: o.index, message: o.error! }));
  const forbids = hit('forbid');
  if (forbids.length) return { decision: 'deny', determining: forbids, errors };
  const permits = hit('permit');
  return { decision: permits.length ? 'allow' : 'deny', determining: permits, errors };
}
