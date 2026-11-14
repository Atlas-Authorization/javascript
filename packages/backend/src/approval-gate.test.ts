import { describe, expect, it, vi } from 'vitest';
import { ApprovalDeniedError, ApprovalPendingError, bindingFor, createApprovalGate, guardToolCall, stableJson, withApproval, type ApprovalGateClient } from './approval-gate';
import type { ApprovalRequest, ApprovalRequestCreated } from './client/approvals';

const created = (id = 'appr_1'): ApprovalRequestCreated => ({
  object: 'approval_request', id, status: 'pending', user_id: 'user_1', match_number: null, expires_at: Date.now() + 60_000,
  approvers: { mode: 'subject', user_ids: [], organization_id: null, role: null, required: 1 }, require_signature: true, digest: 'd', reference: null, binding: null,
});
const req = (status: ApprovalRequest['status'], id = 'appr_1'): ApprovalRequest => ({
  object: 'approval_request', id, status, user_id: 'user_1', expires_at: Date.now() + 60_000, reference: null, binding: null, require_signature: true,
  approvers: { mode: 'subject', user_ids: [], organization_id: null, role: null, required: 1 }, digest: 'd', canonical: '{}', receipt: null, consumed_at: null,
});

function fakeClient(statuses: ApprovalRequest['status'][]): ApprovalGateClient & { calls: string[] } {
  const calls: string[] = [];
  let i = 0;
  return {
    calls,
    approvals: {
      create: vi.fn(async () => { calls.push('create'); return created(); }),
      get: vi.fn(async () => { calls.push('get'); return req(statuses[Math.min(i++, statuses.length - 1)]!); }),
      consume: vi.fn(async () => { calls.push('consume'); return req('approved'); }),
      cancel: vi.fn(async () => req('cancelled')),
    },
  };
}

describe('approval gate', () => {
  it('binds an approval to the tool and its arguments, independent of key order', async () => {
    expect(stableJson({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe('{"a":[2,{"c":2,"d":1}],"b":1}');
    expect(await bindingFor('t', { a: 1, b: 2 })).toBe(await bindingFor('t', { b: 2, a: 1 }));
    expect(await bindingFor('t', { a: 1 })).not.toBe(await bindingFor('t', { a: 2 }));
    expect(await bindingFor('t', {})).not.toBe(await bindingFor('u', {}));
  });

  it('runs the tool only after the approval was waited for and spent', async () => {
    const client = fakeClient(['pending', 'approved']);
    const gate = createApprovalGate({ client, pollSeconds: 1 });
    const run = vi.fn(async () => 'ok');
    const out = await guardToolCall({ gate, user: 'user_1' }, 'wire', { amount: 5 }, run);
    expect(out).toBe('ok');
    expect(client.calls).toEqual(['create', 'get', 'get', 'consume']);
    expect(run).toHaveBeenCalledOnce();
  });

  it('never runs the tool when the approval is denied or expired', async () => {
    for (const status of ['denied', 'expired'] as const) {
      const run = vi.fn(async () => 'ok');
      const gate = createApprovalGate({ client: fakeClient([status]) });
      await expect(guardToolCall({ gate, user: 'user_1' }, 'wire', {}, run)).rejects.toBeInstanceOf(ApprovalDeniedError);
      expect(run).not.toHaveBeenCalled();
    }
  });

  it('resume mode hands back the approval id instead of waiting, then proceeds with the token', async () => {
    const client = fakeClient(['approved']);
    const gate = createApprovalGate({ client });
    const run = vi.fn(async (a: unknown) => a);
    const pending = await guardToolCall({ gate, user: 'user_1', mode: 'resume' }, 'wire', { amount: 5 }, run).catch((e) => e) as ApprovalPendingError;
    expect(pending).toBeInstanceOf(ApprovalPendingError);
    expect(run).not.toHaveBeenCalled();
    const out = await guardToolCall({ gate, user: 'user_1', mode: 'resume' }, 'wire', { amount: 5, approval_id: pending.approvalId }, run);
    expect(out).toEqual({ amount: 5 });
  });

  it('gives up with a resume token when nobody answers in time', async () => {
    let t = 0;
    const gate = createApprovalGate({ client: fakeClient(['pending']), maxWaitMs: 1000, pollSeconds: 1, now: () => (t += 600) });
    await expect(guardToolCall({ gate, user: 'u' }, 'wire', {}, async () => 1)).rejects.toBeInstanceOf(ApprovalPendingError);
  });

  it('skips tools that do not need approval and wraps execute()', async () => {
    const client = fakeClient(['approved']);
    const gate = createApprovalGate({ client });
    const tools = withApproval([{ name: 'read', execute: async (_a: unknown) => 'r' }, { name: 'wire', execute: async (_a: unknown) => 'w' }], { gate, user: 'u', requireFor: ['wire'] });
    expect(await tools[0]!.execute({})).toBe('r');
    expect(client.calls).toEqual([]);
    expect(await tools[1]!.execute({})).toBe('w');
    expect(client.calls).toContain('consume');
  });

  it('spends the usage counter after approval and refunds when the tool throws', async () => {
    const gate = createApprovalGate({ client: fakeClient(['approved']) });
    const usage = { consume: vi.fn(async () => ({ allowed: true, reason: null, counter: 'c', amount: 1, remaining: 1, resetsAt: null, source: 'remote' as const, replayed: false })), refund: vi.fn(async () => ({ refunded: true, reason: null, source: 'remote' as const })), check: vi.fn(), close: vi.fn() };
    await expect(guardToolCall({ gate, user: 'u', usage: { gate: usage as never, grant: { grantType: 'machine', grantId: 'g' }, counter: 'c' } }, 'wire', {}, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(usage.consume).toHaveBeenCalledOnce();
    expect(usage.refund).toHaveBeenCalledOnce();
  });
});
