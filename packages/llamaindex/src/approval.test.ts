import { describe, expect, it, vi } from 'vitest';
import { ApprovalDeniedError, withApproval, type ApprovalGate } from './index';

const gateOf = (outcome: 'approved' | 'denied'): ApprovalGate => ({
  request: vi.fn(async () => ({ id: 'appr_1', expires_at: Date.now() + 1000 }) as never),
  wait: vi.fn(async () => {
    if (outcome === 'denied') throw new ApprovalDeniedError('send_email', 'appr_1', 'denied');
    return {} as never;
  }),
  resume: vi.fn(async () => ({}) as never),
  redeem: vi.fn(async () => ({}) as never),
});

describe('llamaindex withApproval', () => {
  it('gates call() and leaves metadata alone', async () => {
    const tool = { metadata: { name: 'send_email' }, call: vi.fn(async (i: unknown) => ({ sent: i })) };
    const gate = gateOf('approved');
    const [wrapped] = withApproval([tool], { gate, user: 'user_1', describe: (t) => ({ description: `Run ${t}` }) });
    expect(await wrapped!.call!({ to: 'a' })).toEqual({ sent: { to: 'a' } });
    expect(wrapped!.metadata.name).toBe('send_email');
    expect(gate.request).toHaveBeenCalledOnce();
  });

  it('never calls the tool when denied', async () => {
    const tool = { metadata: { name: 'send_email' }, call: vi.fn(async (_a: unknown) => 1) };
    const [wrapped] = withApproval([tool], { gate: gateOf('denied'), user: 'u' });
    await expect(wrapped!.call!({})).rejects.toBeInstanceOf(ApprovalDeniedError);
    expect(tool.call).not.toHaveBeenCalled();
  });
});
