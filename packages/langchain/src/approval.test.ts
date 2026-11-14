import { describe, expect, it, vi } from 'vitest';
import { ApprovalDeniedError, withApproval, type ApprovalGate } from './index';

const gateOf = (outcome: 'approved' | 'denied'): ApprovalGate => ({
  request: vi.fn(async () => ({ id: 'appr_1', expires_at: Date.now() + 1000 }) as never),
  wait: vi.fn(async () => {
    if (outcome === 'denied') throw new ApprovalDeniedError('wire', 'appr_1', 'denied');
    return {} as never;
  }),
  resume: vi.fn(async () => ({}) as never),
  redeem: vi.fn(async () => ({}) as never),
});

describe('langchain withApproval', () => {
  it('runs invoke only after the approval and passes tool_call args through', async () => {
    const calls: unknown[] = [];
    const tool = { name: 'wire', description: 'd', invoke: async (i: unknown) => (calls.push(i), 'sent') };
    const gate = gateOf('approved');
    const [wrapped] = withApproval([tool], { gate, user: 'user_1' });
    expect(await wrapped!.invoke!({ amount: 5 })).toBe('sent');
    expect(await wrapped!.invoke!({ type: 'tool_call', name: 'wire', args: { amount: 6 } })).toBe('sent');
    expect(calls).toEqual([{ amount: 5 }, { type: 'tool_call', name: 'wire', args: { amount: 6 } }]);
    expect(wrapped!.name).toBe('wire');
    expect(gate.redeem).toHaveBeenCalledTimes(2);
  });

  it('does not run the tool when denied', async () => {
    const run = vi.fn(async (_a: unknown) => 'sent');
    const [wrapped] = withApproval([{ name: 'wire', invoke: run }], { gate: gateOf('denied'), user: 'u' });
    await expect(wrapped!.invoke!({})).rejects.toBeInstanceOf(ApprovalDeniedError);
    expect(run).not.toHaveBeenCalled();
  });
});
