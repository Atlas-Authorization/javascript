import { describe, expect, it } from 'vitest';
import {
  envelopeCaveatEvaluator,
  evaluateCaveats,
  evaluateCondition,
  evaluatePredicates,
  resolvePath,
  type ActionContext,
  type Predicate,
} from './predicates';

const ctx = (over: Partial<ActionContext> = {}): ActionContext => ({
  action: { verb: 'revoke_session', resource: '/acct/42/sessions/s1', params: { session: { device: 'laptop' }, n: 5 } },
  subject: { id: 'u1', tags: ['a', 'b'] },
  env: { current_device: 'phone', region: 'eu' },
  ...over,
});

describe('predicates', () => {
  it('verb match: string, list, wildcard, mismatch', () => {
    expect(evaluatePredicates([{ verb: 'revoke_session' }], ctx()).allowed).toBe(true);
    expect(evaluatePredicates([{ verb: ['x', 'revoke_session'] }], ctx()).allowed).toBe(true);
    expect(evaluatePredicates([{ verb: '*' }], ctx()).allowed).toBe(true);
    const r = evaluatePredicates([{ verb: 'delete_account' }], ctx());
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/no predicate permits/);
  });
  it('resource: exact, prefix, regex, bad regex', () => {
    const v = 'revoke_session';
    expect(evaluatePredicates([{ verb: v, resource: '/acct/42/sessions/s1' }], ctx()).allowed).toBe(true);
    expect(evaluatePredicates([{ verb: v, resource: '/acct/42/*' }], ctx()).allowed).toBe(true);
    expect(evaluatePredicates([{ verb: v, resource: '/acct/43/*' }], ctx()).allowed).toBe(false);
    expect(evaluatePredicates([{ verb: v, resource: 're:/acct/\\d+/sessions/.+' }], ctx()).allowed).toBe(true);
    expect(evaluatePredicates([{ verb: v, resource: 're:/acct/\\d+' }], ctx()).allowed).toBe(false); // full match
    expect(evaluatePredicates([{ verb: v, resource: 're:(' }], ctx()).allowed).toBe(false);
  });
  it('spec example: revoke_session WHERE session.device != current_device', () => {
    const p: Predicate = {
      verb: 'revoke_session',
      where: [{ field: 'action.params.session.device', op: 'ne', ref: 'env.current_device' }],
    };
    expect(evaluatePredicates([p], ctx()).allowed).toBe(true);
    const same = ctx({ env: { current_device: 'laptop' } });
    expect(evaluatePredicates([p], same).allowed).toBe(false);
    const noEnv = ctx({ env: {} });
    expect(evaluatePredicates([p], noEnv).allowed).toBe(false); // missing ref => fail closed
  });
  it('dotted path resolution incl. arrays and forbidden segments', () => {
    expect(resolvePath(ctx(), 'subject.tags.1')).toEqual({ found: true, value: 'b' });
    expect(resolvePath(ctx(), 'subject.tags.9').found).toBe(false);
    expect(resolvePath(ctx(), 'action.params.session.device').value).toBe('laptop');
    expect(resolvePath(ctx(), 'other.x').found).toBe(false);
    expect(resolvePath(ctx(), 'action.__proto__.x').found).toBe(false);
    expect(resolvePath(ctx(), 'action.params.constructor').found).toBe(false);
    expect(resolvePath(ctx(), 'subject.toString').found).toBe(false);
    expect(resolvePath(ctx(), '').found).toBe(false);
  });
  it('operators', () => {
    const t = (c: Parameters<typeof evaluateCondition>[0]) => evaluateCondition(c, ctx());
    expect(t({ field: 'action.params.n', op: 'eq', value: 5 })).toBe(true);
    expect(t({ field: 'action.params.n', op: 'lt', value: 6 })).toBe(true);
    expect(t({ field: 'action.params.n', op: 'lte', value: 5 })).toBe(true);
    expect(t({ field: 'action.params.n', op: 'gt', value: 5 })).toBe(false);
    expect(t({ field: 'action.params.n', op: 'gte', value: 5 })).toBe(true);
    expect(t({ field: 'env.region', op: 'in', value: ['eu', 'us'] })).toBe(true);
    expect(t({ field: 'env.region', op: 'nin', value: ['us'] })).toBe(true);
    expect(t({ field: 'env.region', op: 'nin', value: ['eu'] })).toBe(false);
    expect(t({ field: 'action.resource', op: 'prefix', value: '/acct/' })).toBe(true);
    expect(t({ field: 'subject.id', op: 'exists' })).toBe(true);
    expect(t({ field: 'subject.nope', op: 'exists' })).toBe(false);
    expect(t({ field: 'subject.nope', op: 'exists', value: false })).toBe(true);
    expect(t({ field: 'subject.tags', op: 'eq', value: ['a', 'b'] })).toBe(true);
  });
  it('unknown op, missing field, type mismatch, bad shapes are safe (false, no throw)', () => {
    const t = (c: unknown) => evaluateCondition(c as never, ctx());
    expect(t({ field: 'env.region', op: 'matches', value: 'e.' })).toBe(false);
    expect(t({ field: 'env.zzz', op: 'eq', value: 1 })).toBe(false);
    expect(t({ field: 'env.zzz', op: 'ne', value: 1 })).toBe(false);
    expect(t({ field: 'env.region', op: 'lt', value: 5 })).toBe(false);
    expect(t({ field: 'env.region', op: 'in', value: 'eu' })).toBe(false);
    expect(t({ field: 'env.region', op: 'eq' })).toBe(false);
    expect(t(null)).toBe(false);
    expect(evaluatePredicates(null as never, ctx()).allowed).toBe(false);
    expect(evaluatePredicates([null as never, { verb: 5 as never }], ctx()).allowed).toBe(false);
    expect(evaluatePredicates([{ verb: '*' }], { action: null } as never).allowed).toBe(false);
    expect(evaluatePredicates([], ctx()).reason).toMatch(/no predicates/);
  });
  it('all where-conditions must hold; any predicate may match', () => {
    const p1: Predicate = { verb: 'revoke_session', where: [{ field: 'env.region', op: 'eq', value: 'us' }] };
    const p2: Predicate = { verb: 'revoke_session', where: [{ field: 'env.region', op: 'eq', value: 'eu' }, { field: 'action.params.n', op: 'lt', value: 10 }] };
    const r = evaluatePredicates([p1, p2], ctx());
    expect(r.allowed).toBe(true);
    expect(r.matched).toBe(p2);
  });
});

describe('envelope caveat evaluator', () => {
  const base = { now: 1_000_000 };
  const ev = (cv: Record<string, unknown> & { type: string }, c: object = {}) => envelopeCaveatEvaluator(cv, { ...base, ...c });
  it('expires / not_before', () => {
    expect(ev({ type: 'expires', at: 2_000_000 })).toBe(true);
    expect(ev({ type: 'expires', at: 1_000_000 })).toBe(false);
    expect(ev({ type: 'not_before', at: 1_000_000 })).toBe(true);
    expect(ev({ type: 'not_before', at: 1_000_001 })).toBe(false);
  });
  it('rate window', () => {
    const cv = { type: 'rate', max: 2, per_secs: 60 };
    expect(ev(cv, { recentActionTimes: [] })).toBe(true);
    expect(ev(cv, { recentActionTimes: [999_000] })).toBe(true);
    expect(ev(cv, { recentActionTimes: [999_000, 999_500] })).toBe(false);
    expect(ev(cv, { recentActionTimes: [900_000, 999_500] })).toBe(true); // 900_000 outside window
    expect(ev(cv)).toBe(false); // missing data
  });
  it('max_blast_radius / reversibility_max / delegation_depth', () => {
    expect(ev({ type: 'max_blast_radius', max: 0.3 }, { blastRadius: 0.3 })).toBe(true);
    expect(ev({ type: 'max_blast_radius', max: 0.3 }, { blastRadius: 0.31 })).toBe(false);
    expect(ev({ type: 'max_blast_radius', max: 0.3 })).toBe(false);
    expect(ev({ type: 'reversibility_max', class: 'rate_limited' }, { reversibilityClass: 'reversible' })).toBe(true);
    expect(ev({ type: 'reversibility_max', class: 'rate_limited' }, { reversibilityClass: 'irreversible' })).toBe(false);
    expect(ev({ type: 'reversibility_max', class: 'rate_limited' }, { reversibilityClass: 'weird' })).toBe(false);
    expect(ev({ type: 'delegation_depth', max: 1 }, { delegationDepth: 1 })).toBe(true);
    expect(ev({ type: 'delegation_depth', max: 1 }, { delegationDepth: 2 })).toBe(false);
  });
  it('unknown caveat / bad ctx fail closed; evaluateCaveats aggregates', () => {
    expect(ev({ type: 'mystery' })).toBe(false);
    expect(envelopeCaveatEvaluator({ type: 'expires', at: 1 }, null)).toBe(false);
    const r = evaluateCaveats([{ type: 'expires', at: 2_000_000 }, { type: 'delegation_depth', max: 0 }], { ...base, delegationDepth: 3 });
    expect(r).toEqual({ ok: false, failed: ['delegation_depth'] });
    expect(evaluateCaveats([], base).ok).toBe(true);
  });
});
