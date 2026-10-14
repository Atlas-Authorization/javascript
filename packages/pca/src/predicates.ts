import { canonicalize } from './hash';
import type { Caveat, CaveatEvaluator } from './capability';

/**
 * Deterministic, non-code predicate DSL (spec §5.1 "semantic action-predicates") + the built-in
 * envelope caveat evaluator (§5.1 `caveats[]`, the M0 `CaveatEvaluator` extension point).
 *
 * Predicates are PURE DATA. There is no eval / Function / user-supplied code path. Every function
 * here is total and never throws; anything malformed, unknown or missing FAILS CLOSED (condition
 * false, caveat unsatisfied, predicate not matched).
 */

export type ConditionOp = 'eq' | 'ne' | 'in' | 'nin' | 'lt' | 'lte' | 'gt' | 'gte' | 'prefix' | 'exists';

export interface Condition {
  /** Dotted path rooted at `action`, `subject` or `env` (e.g. `action.params.session.device`). */
  field: string;
  op: ConditionOp;
  /** Literal operand. For `exists`: `false` means "must be absent"; anything else means "present". */
  value?: unknown;
  /** Alternative to `value`: a dotted path whose resolved value is the operand
   *  (e.g. `session.device != current_device` => ref: 'env.current_device'). Missing ref => false. */
  ref?: string;
}

export interface Predicate {
  /** Exact verb, list of verbs, or '*'. */
  verb: string | string[];
  /**
   * Resource matcher (string, pure data): exact; `'*'` any; trailing `*` = prefix
   * (`'/acct/*'`); `'re:<pattern>'` = full-match regular expression (pattern <= 200 chars; it is
   * authored by the principal and signed into the grant, so it is trusted input).
   * Omitted = any resource.
   */
  resource?: string;
  /** ALL conditions must hold. */
  where?: Condition[];
}

export interface ActionContext {
  action: {
    verb: string;
    resource: string;
    params?: Record<string, unknown>;
    /** Optional reversibility class for the `reversibility_max` caveat: reversible|rate_limited|irreversible. */
    reversibility_class?: string;
  };
  subject?: Record<string, unknown>;
  env?: Record<string, unknown>;
}

export interface PredicateResult {
  allowed: boolean;
  matched?: Predicate;
  reason?: string;
}

const ROOTS = new Set(['action', 'subject', 'env']);
const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);
const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

/** Resolve a dotted path into the context. Own properties only; unknown root => not found. */
export function resolvePath(ctx: ActionContext, path: unknown): { found: boolean; value?: unknown } {
  if (typeof path !== 'string' || path.length === 0) return { found: false };
  const segs = path.split('.');
  if (!ROOTS.has(segs[0]!)) return { found: false };
  let cur: unknown = (ctx as unknown as Record<string, unknown>)?.[segs[0]!];
  if (cur === undefined) return { found: false };
  for (let i = 1; i < segs.length; i++) {
    const s = segs[i]!;
    if (FORBIDDEN.has(s) || cur === null || typeof cur !== 'object') return { found: false };
    if (Array.isArray(cur)) {
      if (!/^(0|[1-9]\d*)$/.test(s)) return { found: false };
      const idx = Number(s);
      if (idx >= cur.length) return { found: false };
      cur = cur[idx];
    } else {
      if (!has(cur as object, s)) return { found: false };
      cur = (cur as Record<string, unknown>)[s];
    }
    if (cur === undefined) return { found: false };
  }
  return { found: true, value: cur };
}

function deepEq(a: unknown, b: unknown): boolean {
  try {
    return canonicalize(a) === canonicalize(b);
  } catch {
    return false;
  }
}

function ordered(a: unknown, b: unknown): number | null {
  if (typeof a === 'number' && typeof b === 'number' && Number.isFinite(a) && Number.isFinite(b)) {
    return a < b ? -1 : a > b ? 1 : 0;
  }
  if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0;
  return null;
}

/** Evaluate one condition. Missing field / operand => false (except `exists:false`). Unknown op => false. */
export function evaluateCondition(c: Condition, ctx: ActionContext): boolean {
  try {
    if (c === null || typeof c !== 'object') return false;
    const f = resolvePath(ctx, c.field);
    if (c.op === 'exists') return c.value === false ? !f.found : f.found;
    if (!f.found) return false;
    let operand: unknown;
    if (c.ref !== undefined) {
      const r = resolvePath(ctx, c.ref);
      if (!r.found) return false;
      operand = r.value;
    } else {
      if (!has(c, 'value') || c.value === undefined) return false;
      operand = c.value;
    }
    const v = f.value;
    switch (c.op) {
      case 'eq':
        return deepEq(v, operand);
      case 'ne':
        return !deepEq(v, operand);
      case 'in':
        return Array.isArray(operand) && operand.some((x) => deepEq(v, x));
      case 'nin':
        return Array.isArray(operand) && !operand.some((x) => deepEq(v, x));
      case 'lt': {
        const o = ordered(v, operand);
        return o !== null && o < 0;
      }
      case 'lte': {
        const o = ordered(v, operand);
        return o !== null && o <= 0;
      }
      case 'gt': {
        const o = ordered(v, operand);
        return o !== null && o > 0;
      }
      case 'gte': {
        const o = ordered(v, operand);
        return o !== null && o >= 0;
      }
      case 'prefix':
        return typeof v === 'string' && typeof operand === 'string' && v.startsWith(operand);
      default:
        return false;
    }
  } catch {
    return false;
  }
}

function verbMatches(p: Predicate['verb'], verb: string): boolean {
  if (typeof p === 'string') return p === '*' || p === verb;
  if (Array.isArray(p)) return p.some((x) => typeof x === 'string' && (x === '*' || x === verb));
  return false;
}

function resourceMatches(pattern: unknown, resource: string): boolean {
  if (pattern === undefined) return true;
  if (typeof pattern !== 'string') return false;
  if (pattern === '*') return true;
  if (pattern.startsWith('re:')) {
    const src = pattern.slice(3);
    if (src.length > 200) return false;
    try {
      return new RegExp('^(?:' + src + ')$').test(resource);
    } catch {
      return false;
    }
  }
  if (pattern.endsWith('*')) return resource.startsWith(pattern.slice(0, -1));
  return pattern === resource;
}

/** Does a single predicate permit the action? */
export function predicateMatches(p: Predicate, ctx: ActionContext): boolean {
  try {
    if (p === null || typeof p !== 'object') return false;
    const a = ctx?.action;
    if (!a || typeof a.verb !== 'string' || typeof a.resource !== 'string') return false;
    if (!verbMatches(p.verb, a.verb)) return false;
    if (!resourceMatches(p.resource, a.resource)) return false;
    if (p.where !== undefined) {
      if (!Array.isArray(p.where)) return false;
      for (const c of p.where) if (!evaluateCondition(c, ctx)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * An action is allowed iff it matches AT LEAST ONE predicate (verb AND resource AND all `where`).
 * Default-deny: an empty predicate list allows nothing.
 */
export function evaluatePredicates(predicates: Predicate[], ctx: ActionContext): PredicateResult {
  try {
    if (!Array.isArray(predicates) || predicates.length === 0) {
      return { allowed: false, reason: 'envelope grants no predicates' };
    }
    for (const p of predicates) {
      if (predicateMatches(p, ctx)) return { allowed: true, matched: p };
    }
    const a = ctx?.action;
    return { allowed: false, reason: `no predicate permits ${String(a?.verb)} on ${String(a?.resource)}` };
  } catch {
    return { allowed: false, reason: 'predicate evaluation error (fail closed)' };
  }
}

// ---- built-in envelope caveats ---------------------------------------------------------

/** Reversibility classes in increasing severity (spec §10: reversible < rate-limited < irreversible). */
export const REVERSIBILITY_ORDER = ['reversible', 'rate_limited', 'irreversible'] as const;

/** Data the built-in caveats are evaluated against. Epoch times in ms. Missing data FAILS CLOSED. */
export interface CaveatContext {
  now: number;
  /** Normalized blast radius in [0,1]. */
  blastRadius?: number;
  reversibilityClass?: string;
  /** Hops below the root this holder sits at (0 = the grant holder). */
  delegationDepth?: number;
  /** Epoch-ms timestamps of this holder's previously admitted actions (for `rate`). */
  recentActionTimes?: number[];
}

const fin = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

/**
 * Built-in caveat types (all conjunctive; unknown type => unsatisfied):
 *  - `expires`            { at: ms }        satisfied iff now < at
 *  - `not_before`         { at: ms }        satisfied iff now >= at
 *  - `rate`               { max, per_secs } satisfied iff admitted actions in (now - per_secs, now] < max
 *                                           (so this action is at most the max-th); needs ctx.recentActionTimes
 *  - `max_blast_radius`   { max: [0,1] }    satisfied iff ctx.blastRadius <= max
 *  - `reversibility_max`  { class }         satisfied iff ctx.reversibilityClass is no more severe than `class`
 *  - `delegation_depth`   { max }           satisfied iff ctx.delegationDepth <= max
 */
export const envelopeCaveatEvaluator: CaveatEvaluator = (caveat: Caveat, ctx: unknown): boolean => {
  try {
    if (caveat === null || typeof caveat !== 'object' || ctx === null || typeof ctx !== 'object') return false;
    const c = ctx as Partial<CaveatContext>;
    if (!fin(c.now)) return false;
    switch (caveat.type) {
      case 'expires':
        return fin(caveat.at) && c.now < caveat.at;
      case 'not_before':
        return fin(caveat.at) && c.now >= caveat.at;
      case 'rate': {
        if (!fin(caveat.max) || !fin(caveat.per_secs) || caveat.per_secs <= 0) return false;
        if (!Array.isArray(c.recentActionTimes)) return false;
        const lo = c.now - caveat.per_secs * 1000;
        const n = c.recentActionTimes.filter((t) => fin(t) && t > lo && t <= c.now!).length;
        return n < caveat.max;
      }
      case 'max_blast_radius':
        return fin(caveat.max) && fin(c.blastRadius) && c.blastRadius <= caveat.max;
      case 'reversibility_max': {
        const lim = (REVERSIBILITY_ORDER as readonly string[]).indexOf(String(caveat.class));
        const cur = (REVERSIBILITY_ORDER as readonly string[]).indexOf(String(c.reversibilityClass));
        return lim >= 0 && cur >= 0 && cur <= lim;
      }
      case 'delegation_depth':
        return fin(caveat.max) && fin(c.delegationDepth) && c.delegationDepth <= caveat.max;
      default:
        return false;
    }
  } catch {
    return false;
  }
};

/** Evaluate all caveats; ok iff every caveat is satisfied. `failed` lists the unsatisfied types. */
export function evaluateCaveats(
  caveats: Caveat[],
  ctx: CaveatContext,
  evaluator: CaveatEvaluator = envelopeCaveatEvaluator,
): { ok: boolean; failed: string[] } {
  const failed: string[] = [];
  if (!Array.isArray(caveats)) return { ok: false, failed: ['<malformed caveats>'] };
  for (const cv of caveats) {
    let ok = false;
    try {
      ok = evaluator(cv, ctx);
    } catch {
      ok = false;
    }
    if (!ok) failed.push(typeof cv?.type === 'string' ? cv.type : '<malformed>');
  }
  return { ok: failed.length === 0, failed };
}
