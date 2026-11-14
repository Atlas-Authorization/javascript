import { describe, expect, it } from 'vitest';
import type { ConfigHttp } from '../../config-http';
import type { SingletonSpec } from '../config';
import { registeredConfigTypes } from './index';
import { WRITE_BUDGET_CONFIG_TYPES } from './write-budget';

const spec = WRITE_BUDGET_CONFIG_TYPES[0] as SingletonSpec;

describe('write_budget config type', () => {
  it('is registered', () => {
    expect(registeredConfigTypes().map((s) => s.type)).toContain('write_budget');
  });

  it('reads only limits the instance set, null otherwise', async () => {
    const http = {
      get: async () => ({ mode: 'enforce', budgets: { writes: { limit: 100, custom: true }, counter_writes: { limit: 6000, custom: false }, events: { limit: 12000, custom: false }, webhook_fanout: { limit: 30000, custom: false } } }),
    } as unknown as ConfigHttp;
    expect(await spec.fetchLive(http)).toEqual({ mode: 'enforce', writes_per_minute: 100, counter_writes_per_minute: null, events_per_minute: null, webhook_fanout_per_minute: null });
  });

  it('writes only the keys the file names', async () => {
    const puts: unknown[] = [];
    const http = { put: async (_p: string, b: unknown) => { puts.push(b); return {}; } } as unknown as ConfigHttp;
    await spec.apply(http, { mode: 'observe', writes_per_minute: 50, extra: 1 } as never, { forceHook: false });
    expect(puts).toEqual([{ mode: 'observe', writes_per_minute: 50 }]);
  });
});
