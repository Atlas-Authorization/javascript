import { describe, expect, it, vi } from 'vitest';
import { createAtlasToolkit, ApprovalDeniedError, type ApprovalGate } from './index';

const gateOf = (outcome: 'approved' | 'denied'): ApprovalGate => ({
  request: vi.fn(async () => ({ id: 'appr_1', expires_at: Date.now() + 1000 }) as never),
  wait: vi.fn(async () => {
    if (outcome === 'denied') throw new ApprovalDeniedError('t', 'appr_1', 'denied');
    return {} as never;
  }),
  resume: vi.fn(async () => ({}) as never),
  redeem: vi.fn(async () => ({}) as never),
});

const backend = (calls: string[]) =>
  ({
    users: {
      list: async () => (calls.push('list'), { data: [] }),
      ban: async () => (calls.push('ban'), { id: 'user_1' }),
    },
  }) as never;

describe('toolkit approvals', () => {
  it('holds write tools for approval and lets pure reads through', async () => {
    const calls: string[] = [];
    const gate = gateOf('approved');
    const toolkit = createAtlasToolkit({ backend: backend(calls), scopes: ['users:write'], approvals: { gate, user: 'user_1' } });
    const read = toolkit.all.find((t) => t.readOnly && t.resource === 'users')!;
    const write = toolkit.all.find((t) => !t.readOnly && t.resource === 'users')!;
    expect(read && write).toBeTruthy();
    await read.execute({}).catch(() => undefined);
    expect(gate.request).not.toHaveBeenCalled();
    await write.execute({ user_id: 'user_1' }).catch(() => undefined);
    expect(gate.request).toHaveBeenCalledOnce();
    expect(gate.redeem).toHaveBeenCalledOnce();
  });

  it('a denied approval stops the write before it reaches Atlas', async () => {
    const calls: string[] = [];
    const toolkit = createAtlasToolkit({ backend: backend(calls), scopes: ['users:write'], approvals: { gate: gateOf('denied'), user: 'user_1' } });
    const write = toolkit.all.find((t) => !t.readOnly && t.resource === 'users')!;
    await expect(write.execute({ user_id: 'user_1' })).rejects.toBeInstanceOf(ApprovalDeniedError);
    expect(calls).toEqual([]);
  });
});
