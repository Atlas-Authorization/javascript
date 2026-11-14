import { describe, expect, it } from 'vitest';
import { createUsageGate, type UsageGateClient } from '@atlasauth/backend';
import { createAtlasToolkit } from './toolkit';
import { withGrantUsage, GrantUsageDeniedError } from './grant-usage';
import { createFakeBackend } from './testing/fake-backend';

function gateWith(allow: () => boolean) {
  const calls: Array<{ op: string; body: any }> = [];
  const client: UsageGateClient = {
    grantUsage: {
      async consume(_t, _i, body) {
        calls.push({ op: 'consume', body });
        const ok = allow();
        return { object: 'usage_decision', allowed: ok, counter: body.counter, amount: 1, used: 1, limit: 1, remaining: 0, window: 'day', window_start: 0, resets_at: null, reason: ok ? null : 'limit_reached' };
      },
      async refund(_t, _i, body) {
        calls.push({ op: 'refund', body });
        return { object: 'usage_refund', refunded: true, counter: body.counter, amount: 1, used: 0, reason: null };
      },
      async releaseLease() {
        throw new Error('unused');
      },
    },
  };
  return { gate: createUsageGate({ client }), calls };
}

const grant = { grantType: 'machine' as const, grantId: 'mrg_1' };

describe('withGrantUsage', () => {
  it('consumes before acting, with a distinct key per call', async () => {
    const { gate, calls } = gateWith(() => true);
    const order: string[] = [];
    const [tool] = withGrantUsage([{ name: 't', execute: async (_input?: unknown) => (order.push('run'), 'ok') }], { gate, grant, counter: 'calls' });
    await tool!.execute({});
    await tool!.execute({});
    expect(calls.map((c) => c.op)).toEqual(['consume', 'consume']);
    expect(calls[0]!.body.idempotency_key).not.toBe(calls[1]!.body.idempotency_key);
    expect(order).toEqual(['run', 'run']);
  });

  it('a denial throws and the tool never runs', async () => {
    const { gate } = gateWith(() => false);
    let ran = false;
    const [tool] = withGrantUsage([{ name: 't', execute: async (_input?: unknown) => void (ran = true) }], { gate, grant, counter: 'calls' });
    await expect(tool!.execute({})).rejects.toBeInstanceOf(GrantUsageDeniedError);
    expect(ran).toBe(false);
  });

  it('a throwing tool is refunded against its own consume key, and the error still surfaces', async () => {
    const { gate, calls } = gateWith(() => true);
    const [tool] = withGrantUsage([{ name: 't', execute: async (_input?: unknown) => { throw new Error('boom'); } }], { gate, grant, counter: 'calls' });
    await expect(tool!.execute({})).rejects.toThrow('boom');
    expect(calls[1]).toMatchObject({ op: 'refund', body: { consume_idempotency_key: calls[0]!.body.idempotency_key } });
  });

  it('only metered tools in a map are metered, with per-tool cost', async () => {
    const { gate, calls } = gateWith(() => true);
    const [a, b] = withGrantUsage(
      [{ name: 'a', execute: async (_input?: unknown) => 1 }, { name: 'b', execute: async (_input?: unknown) => 2 }],
      { gate, grant, counter: { a: { counter: 'spend', amount: 5 } } },
    );
    await a!.execute({});
    await b!.execute({});
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toMatchObject({ counter: 'spend', amount: 5 });
  });

  it('a failing local pre-check denies without any call', async () => {
    const { gate, calls } = gateWith(() => true);
    const [tool] = withGrantUsage([{ name: 't', execute: async (_input?: unknown) => 1 }], { gate, grant, counter: 'calls', claims: () => ({ constraints: { counters: {} } }) });
    await expect(tool!.execute({})).rejects.toBeInstanceOf(GrantUsageDeniedError);
    expect(calls).toHaveLength(0);
  });

  it('createAtlasToolkit({ grantUsage }) meters its tools', async () => {
    const { gate, calls } = gateWith(() => true);
    const toolkit = createAtlasToolkit({ backend: createFakeBackend().client, allowedTools: ['get_user'], grantUsage: { gate, grant, counter: 'calls' } });
    await toolkit.tools.get_user!.execute({ user_id: 'user_1' });
    expect(calls[0]!.op).toBe('consume');
  });
});
