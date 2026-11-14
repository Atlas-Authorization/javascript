import { describe, expect, it } from 'vitest';
import type { UsageDecision } from './client/grant-usage';
import { createUsageGate, requireGrantUsage, type UsageGateClient } from './usage-gate';

const dec = (o: Partial<UsageDecision> = {}): UsageDecision => ({
  object: 'usage_decision', allowed: true, counter: 'calls', amount: 1, used: 1, limit: 10, remaining: 9,
  window: 'day', window_start: 0, resets_at: null, reason: null, ...o,
});

function fake(handler?: (body: any) => UsageDecision | Error) {
  const calls: Array<{ op: string; args: any[] }> = [];
  const client: UsageGateClient = {
    grantUsage: {
      async consume(t, id, body) {
        calls.push({ op: 'consume', args: [t, id, body] });
        const r = handler?.(body) ?? (body.lease ? dec({ amount: body.amount, lease: { id: 'ulse_1', amount: body.amount!, expires_at: 100_000 } }) : dec());
        if (r instanceof Error) throw r;
        return r;
      },
      async refund(t, id, body) {
        calls.push({ op: 'refund', args: [t, id, body] });
        return { object: 'usage_refund', refunded: true, counter: body.counter, amount: 1, used: 0, reason: null };
      },
      async releaseLease(t, id, leaseId, body) {
        calls.push({ op: 'release', args: [t, id, leaseId, body] });
        return { object: 'usage_lease', id: leaseId, counter: 'calls', amount: 5, consumed: body?.consumed ?? 0, returned: 0, status: 'released', expires_at: 0 };
      },
    },
  };
  return { client, calls };
}

const base = { grantType: 'machine' as const, grantId: 'mrg_1', counter: 'calls' };

describe('usage gate check (deny-only)', () => {
  const { client } = fake();
  const gate = createUsageGate({ client, now: () => 1_000_000 });
  const claims = { exp: 2000, constraints: { counters: { calls: { limit: 10 } } } };
  it('passes a well-formed token', () => expect(gate.check(claims, { counter: 'calls' })).toEqual({ ok: true }));
  it('denies no grant, expired, unknown counter', () => {
    expect(gate.check(null, { counter: 'calls' })).toEqual({ ok: false, reason: 'no_grant' });
    expect(gate.check({ constraints: {} }, { counter: 'x' })).toEqual({ ok: false, reason: 'unknown_counter' });
    expect(gate.check({ ...claims, exp: 999 }, { counter: 'calls' })).toEqual({ ok: false, reason: 'expired' });
  });
  it('denies on an exhausted hint only while the window has not reset', () => {
    const hint = (resets_at: number | null) => ({ ...claims, cnt: { calls: { used: 10, limit: 10, resets_at } } });
    expect(gate.check(hint(null), { counter: 'calls' })).toEqual({ ok: false, reason: 'exhausted' });
    expect(gate.check(hint(2_000_000), { counter: 'calls' })).toEqual({ ok: false, reason: 'exhausted' });
    expect(gate.check(hint(500_000), { counter: 'calls' })).toEqual({ ok: true });
  });
});

describe('usage gate consume', () => {
  it('remote mode makes one call per consume and passes the key', async () => {
    const { client, calls } = fake();
    const gate = createUsageGate({ client });
    const r = await gate.consume({ ...base, idempotencyKey: 'k1' });
    expect(r).toMatchObject({ allowed: true, source: 'remote' });
    expect(calls[0]!.args[2]).toMatchObject({ counter: 'calls', idempotency_key: 'k1' });
    expect(calls[0]!.args[2].amount).toBeUndefined();
  });

  it('lease mode reserves one block, spends locally, replays a retry, and releases what was spent', async () => {
    const { client, calls } = fake();
    const gate = createUsageGate({ client, mode: 'lease', leaseSize: 5, now: () => 0 });
    const a = await gate.consume({ ...base, idempotencyKey: 'a' });
    const b = await gate.consume({ ...base, idempotencyKey: 'b', amount: 2 });
    const again = await gate.consume({ ...base, idempotencyKey: 'a' });
    expect(a).toMatchObject({ source: 'lease', remaining: 4 });
    expect(b.remaining).toBe(2);
    expect(again.replayed).toBe(true);
    expect(calls.filter((c) => c.op === 'consume')).toHaveLength(1);
    expect(calls[0]!.args[2]).toMatchObject({ lease: true, amount: 5 });
    await gate.close();
    expect(calls.at(-1)).toMatchObject({ op: 'release', args: ['machine', 'mrg_1', 'ulse_1', { consumed: 3 }] });
  });

  it('lease mode never leases with a context, and stops leasing a counter the server refuses to lease', async () => {
    const refuse = Object.assign(new Error('no lease'), { status: 422 });
    const { client, calls } = fake((b) => (b.lease ? refuse : dec()));
    const gate = createUsageGate({ client, mode: 'lease' });
    await gate.consume({ ...base, idempotencyKey: 'c1', context: { cost: 3 } });
    expect(calls).toHaveLength(1);
    expect((calls[0]!.args[2] as any).lease).toBeUndefined();
    await gate.consume({ ...base, idempotencyKey: 'c2' }); // lease attempt refused, then remote
    await gate.consume({ ...base, idempotencyKey: 'c3' }); // no second lease attempt
    expect(calls.filter((c) => (c.args[2] as any).lease)).toHaveLength(1);
  });

  it('lease mode falls back to a remote consume when a whole block is not available', async () => {
    const { client, calls } = fake((b) => (b.lease ? dec({ allowed: false, reason: 'limit_reached' }) : dec()));
    const gate = createUsageGate({ client, mode: 'lease' });
    expect((await gate.consume({ ...base, idempotencyKey: 'z' })).source).toBe('remote');
    expect(calls).toHaveLength(2);
  });

  it('a lease past its safety margin is released with what was spent and replaced', async () => {
    let t = 0;
    const { client, calls } = fake();
    const gate = createUsageGate({ client, mode: 'lease', leaseSize: 5, leaseSafetyMs: 2000, now: () => t });
    await gate.consume({ ...base, idempotencyKey: 'a' });
    t = 99_000; // within the 2s margin of expires_at = 100_000
    await gate.consume({ ...base, idempotencyKey: 'b' });
    expect(calls.map((c) => c.op)).toEqual(['consume', 'release', 'consume']);
    expect(calls[1]!.args[3]).toEqual({ consumed: 1 });
    await gate.close();
  });

  it('refund: a leased consume returns to the open block; a remote one calls Atlas', async () => {
    const { client, calls } = fake();
    const gate = createUsageGate({ client, mode: 'lease', leaseSize: 5, now: () => 0 });
    await gate.consume({ ...base, idempotencyKey: 'a' });
    expect(await gate.refund({ ...base, idempotencyKey: 'r', consumeIdempotencyKey: 'a' })).toMatchObject({ refunded: true, source: 'lease' });
    await gate.close();
    expect(calls.at(-1)!.args[3]).toEqual({ consumed: 0 });
    const remote = createUsageGate({ client });
    expect(await remote.refund({ ...base, idempotencyKey: 'r2', consumeIdempotencyKey: 'x' })).toMatchObject({ refunded: true, source: 'remote' });
  });
});

describe('requireGrantUsage', () => {
  const claims = { exp: 4_000_000_000, constraints: { counters: { calls: {} } }, grant_id: 'mrg_1' };
  const run = (handler: (b: any) => UsageDecision, c: any = claims, headers: any = {}) => {
    const { client, calls } = fake(handler);
    const gate = createUsageGate({ client });
    return { calls, go: requireGrantUsage({ gate, counter: 'calls' })({ claims: c, headers }) };
  };
  it('allows and forwards the Idempotency-Key header', async () => {
    const { go, calls } = run(() => dec(), claims, { 'idempotency-key': 'abc' });
    expect((await go).allowed).toBe(true);
    expect((calls[0]!.args[2] as any).idempotency_key).toBe('abc');
  });
  it('429 with Retry-After on limit_reached', async () => {
    const out = await run(() => dec({ allowed: false, reason: 'limit_reached', resets_at: Date.now() + 30_000 }), claims, new Headers()).go;
    expect(out).toMatchObject({ allowed: false, status: 429 });
    expect(Number((out as any).headers['Retry-After'])).toBeGreaterThan(0);
  });
  it('403 for an expired grant, a missing grant id, and a token without the counter', async () => {
    expect(await run(() => dec({ allowed: false, reason: 'grant_expired' })).go).toMatchObject({ status: 403 });
    expect(await run(() => dec(), { ...claims, grant_id: undefined }).go).toMatchObject({ status: 403 });
    expect(await run(() => dec(), { exp: claims.exp, constraints: { counters: {} } }).go).toMatchObject({ status: 403 });
  });
});
