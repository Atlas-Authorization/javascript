import { describe, expect, it } from 'vitest';
import { MemoryConfigStore } from '../config';
import type { ConfigHttp } from '../config-http';
import type { ManagementClient, RunContext } from '../context';
import { captureIO } from '../io';
import { run } from '../run';

type Call = { method: string; path: string; body?: unknown };

function ctx(calls: Call[], answers: Record<string, unknown> = {}, fetchImpl?: typeof fetch) {
  const send = async (method: string, path: string, body?: unknown) => {
    calls.push({ method, path, body });
    return (answers[`${method} ${path}`] ?? {}) as never;
  };
  const http: ConfigHttp = {
    get: (p) => send('GET', p),
    post: (p, b) => send('POST', p, b),
    put: (p, b) => send('PUT', p, b),
    patch: (p, b) => send('PATCH', p, b),
    delete: async (p, b) => {
      await send('DELETE', p, b);
    },
  };
  const io = captureIO();
  const c: RunContext = {
    io,
    env: {},
    config: new MemoryConfigStore({ active_profile: 'default', profiles: { default: { api_url: 'https://api.test', secret_key: 'sk_test_123456' } } }),
    prompt: { text: async () => '', secret: async () => '' },
    makeClient: () => ({}) as ManagementClient,
    makeHttp: () => http,
    readFile: (p) => (p === 'a.js' ? 'api.console.log(1)' : ''),
    fetch: fetchImpl,
    sleep: async () => undefined,
  };
  return { c, io };
}

describe('workflows verbs', () => {
  it('approve and deny send the decision and the comment', async () => {
    const calls: Call[] = [];
    const { c } = ctx(calls);
    expect(await run(['workflows', 'approve', 'wfa_1', '--comment', 'ok', '--yes'], c)).toBe(0);
    expect(await run(['workflows', 'deny', 'wfa_1', '--yes'], c)).toBe(0);
    expect(calls[0]).toEqual({ method: 'POST', path: '/v1/workflow_approvals/wfa_1/decide', body: { decision: 'approve', comment: 'ok' } });
    expect(calls[1]!.body).toEqual({ decision: 'deny' });
  });

  it('dry-run, cancel and retry --from-step', async () => {
    const calls: Call[] = [];
    const { c } = ctx(calls);
    await run(['workflows', 'dry-run', 'wf_1', '--user-id', 'user_1'], c);
    expect(calls[0]).toEqual({ method: 'POST', path: '/v1/workflows/wf_1/dry_run', body: { user_id: 'user_1' } });
    expect(await run(['workflows', 'cancel', 'wf_1', 'run_1'], c)).toBe(1); // needs --yes
    await run(['workflows', 'cancel', 'wf_1', 'run_1', '--yes'], c);
    await run(['workflows', 'retry', 'wf_1', 'run_1', '--from-step', '1.then.0', '--yes'], c);
    expect(calls.map((x) => x.path)).toEqual(['/v1/workflows/wf_1/dry_run', '/v1/workflows/wf_1/runs/run_1/cancel', '/v1/workflows/wf_1/runs/run_1/retry']);
    expect(calls[2]!.body).toEqual({ from_step: '1.then.0' });
  });
});

describe('app-events and diagnostics', () => {
  it('publish fills the body from flags; list forwards its filters as the query', async () => {
    const calls: Call[] = [];
    const { c } = ctx(calls);
    await run(['app-events', 'publish', '--organization-id', '*', '--type', 'invoice.paid', '--data', '{"data":{"n":1}}'], c);
    expect(calls[0]).toEqual({ method: 'POST', path: '/v1/app_events', body: { data: { n: 1 }, organization_id: '*', type: 'invoice.paid' } });
    await run(['app-events', 'list', '--organization-id', 'org_1', '--type', 'invoice.paid'], c);
    expect(calls[1]!.path).toBe('/v1/app_events?organization_id=org_1&type=invoice.paid');
  });

  it('diagnostics forwards its flags as query parameters', async () => {
    const calls: Call[] = [];
    const { c } = ctx(calls);
    await run(['diagnostics', 'login-readiness', '--origin', 'https://app.example.com', '--live'], c);
    await run(['diagnostics', 'inspect', '--origin', 'https://app.example.com', '--method', 'POST', '--path', '/v1/client/sign_ins'], c);
    await run(['diagnostics', 'traces', '--user-id', 'user_1', '--code', 'rate_limited'], c);
    expect(calls.map((x) => x.path)).toEqual([
      '/v1/diagnostics/login_readiness?origin=https%3A%2F%2Fapp.example.com&live=true',
      '/v1/diagnostics/request_inspector?origin=https%3A%2F%2Fapp.example.com&method=POST&path=%2Fv1%2Fclient%2Fsign_ins',
      '/v1/diagnostics/traces?user_id=user_1&code=rate_limited',
    ]);
  });
});

describe('actions versions', () => {
  it('release stages with --percent; rollback needs --yes and --to-version', async () => {
    const calls: Call[] = [];
    const { c } = ctx(calls, { 'POST /v1/actions/act_1/versions': { version: 2, staged: true } });
    expect(await run(['actions', 'release', 'act_1', 'a.js', '--percent', '10', '--note', 'try'], c)).toBe(0);
    expect(calls[0]).toEqual({ method: 'POST', path: '/v1/actions/act_1/versions', body: { code: 'api.console.log(1)', note: 'try', rollout_percent: 10 } });
    expect(await run(['actions', 'rollout', 'act_1', '--percent', '100'], c)).toBe(0);
    expect(calls[1]).toEqual({ method: 'PATCH', path: '/v1/actions/act_1/rollout', body: { percent: 100 } });
    expect(await run(['actions', 'rollback', 'act_1', '--to-version', '1'], c)).toBe(1);
    expect(await run(['actions', 'rollback', 'act_1', '--to-version', '1', '--yes'], c)).toBe(0);
    expect(calls[2]).toEqual({ method: 'POST', path: '/v1/actions/act_1/rollback', body: { version: 1 } });
  });
});

describe('webhooks dlq', () => {
  it('dlq-ack and dlq-requeue need delivery ids and call the queue routes', async () => {
    const calls: Call[] = [];
    const { c } = ctx(calls, { 'POST /v1/webhook_endpoints/we_1/dlq/ack': { acknowledged: 2 } });
    expect(await run(['webhooks', 'dlq-ack', 'we_1'], c)).toBe(1);
    expect(await run(['webhooks', 'dlq-ack', 'we_1', '--delivery', 'd1,d2'], c)).toBe(0);
    expect(calls[0]).toEqual({ method: 'POST', path: '/v1/webhook_endpoints/we_1/dlq/ack', body: { delivery_ids: ['d1', 'd2'] } });
    await run(['webhooks', 'update', 'we_1', '--max-rps', '5', '--filters', '{"organization_ids":["org_1"]}'], c);
    expect(calls[1]).toEqual({ method: 'PATCH', path: '/v1/webhook_endpoints/we_1', body: { max_rps: 5, filters: { organization_ids: ['org_1'] } } });
  });
});

describe('logs tail', () => {
  it('prints new traces and audit entries oldest first, stops at --count, and refuses a bad source', async () => {
    const now = Date.now();
    const fetchImpl = (async (url: string | URL) => {
      const u = String(url);
      const body = u.includes('/v1/diagnostics/traces')
        ? { data: [{ id: 'tr_1', method: 'POST', path: '/v1/client/sign_ins', status: 403, code: 'origin_not_allowed', decided_by: 'cors', created_at: now + 2000 }] }
        : { data: [{ id: 'aud_1', action: 'user.banned', actor_type: 'api_key', actor_id: 'key_1', target_type: 'user', target_id: 'user_1', created_at: now + 1000 }] };
      return new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof fetch;
    const a = ctx([], {}, fetchImpl);
    expect(await run(['logs', 'tail', '--count', '2', '--json'], a.c)).toBe(0);
    const lines = a.io.stdout().trim().split('\n').map((l) => JSON.parse(l) as { source: string; id: string });
    expect(lines.map((l) => l.id)).toEqual(['aud_1', 'tr_1']);
    const b = ctx([], {}, fetchImpl);
    expect(await run(['logs', 'tail', '--source', 'nope'], b.c)).toBe(1);
    expect(await run(['logs', 'nope'], b.c)).toBe(1);
  });
});
