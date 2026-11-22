import { describe, expect, it } from 'vitest';
import { createMachineDenyList } from './machine-deny-list';

const T = 1_700_000_000_000;

describe('createMachineDenyList', () => {
  it('denies tokens of a revoked machine issued at or before the revocation, not later ones', () => {
    const list = createMachineDenyList({ now: () => T + 10_000 });
    list.apply({ object: 'machine', id: 'mach_1', revoked_at: T });
    expect(list.isRevoked({ sub: 'mach_1', iat: T / 1000 - 30 })).toBe(true);
    expect(list.isRevoked({ sub: 'mach_1', iat: T / 1000 })).toBe(true);
    expect(list.isRevoked({ sub: 'mach_1', iat: T / 1000 + 5 })).toBe(false); // approved again, fresh token
    expect(list.isRevoked({ sub: 'mach_2', iat: T / 1000 - 30 })).toBe(false);
  });

  it('an ended grant denies only tokens for that machine and audience', () => {
    const list = createMachineDenyList({ now: () => T + 10_000 });
    list.apply({ object: 'machine_grant', id: 'mg_1', machine_id: 'mach_1', audience: 'https://api.example.com', revoked_at: T });
    expect(list.isRevoked({ sub: 'mach_1', aud: 'https://api.example.com', iat: T / 1000 - 5 })).toBe(true);
    expect(list.isRevoked({ sub: 'mach_1', aud: ['https://other.example.com', 'https://api.example.com'], iat: T / 1000 - 5 })).toBe(true);
    expect(list.isRevoked({ sub: 'mach_1', aud: 'https://other.example.com', iat: T / 1000 - 5 })).toBe(false);
    expect(list.isRevoked({ sub: 'mach_1', iat: T / 1000 - 5 })).toBe(false);
  });

  it('forgets an entry once no token that could be live is left', () => {
    let now = T + 1000;
    const list = createMachineDenyList({ now: () => now, maxTokenLifetimeSeconds: 600 });
    list.apply({ object: 'machine', id: 'mach_1', revoked_at: T });
    expect(list.isRevoked({ sub: 'mach_1', iat: T / 1000 - 1 })).toBe(true);
    now = T + 601_000;
    expect(list.isRevoked({ sub: 'mach_1', iat: T / 1000 - 1 })).toBe(false);
    expect(list.size()).toBe(0);
  });

  it('sync pages the feed from the last cursor', async () => {
    const calls: Array<{ since?: string }> = [];
    const pages = [
      { data: [{ object: 'machine' as const, id: 'm1', revoked_at: T }], has_more: true, next_cursor: 'c1' },
      { data: [{ object: 'machine' as const, id: 'm2', revoked_at: T }], has_more: false, next_cursor: 'c2' },
    ];
    const list = createMachineDenyList({
      now: () => T + 1000,
      machines: { listRevoked: async (q) => (calls.push(q), pages.shift() ?? { data: [], has_more: false, next_cursor: 'c2' }) },
    });
    expect(list.canSync).toBe(true);
    expect(await list.sync()).toEqual({ applied: 2 });
    expect(calls[0]).not.toHaveProperty('since');
    expect(calls[1]!.since).toBe('c1');
    expect(list.isRevoked({ sub: 'm2', iat: T / 1000 - 1 })).toBe(true);
    await list.sync();
    expect(calls[2]!.since).toBe('c2');
  });

  it('sync without a client says so', async () => {
    const list = createMachineDenyList();
    expect(list.canSync).toBe(false);
    await expect(list.sync()).rejects.toThrow(TypeError);
  });
});
