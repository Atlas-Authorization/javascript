import { describe, expect, it } from 'vitest';
import { createAtlasClient } from './index';

// [namespace, method, HTTP method, expected path, arguments]
const TABLE: Array<[string, string, string, string, unknown[]]> = [
  ['signingKeySchedule', 'get', 'GET', '/v1/instance/signing_key_schedule', []],
  ['signingKeySchedule', 'set', 'PUT', '/v1/instance/signing_key_schedule', [{ interval_days: 30 }]],
  ['signingKeySchedule', 'remove', 'DELETE', '/v1/instance/signing_key_schedule', []],
  ['auditChain', 'get', 'GET', '/v1/audit/chain', []],
  ['auditChain', 'enable', 'PUT', '/v1/audit/chain', [{}]],
  ['auditChain', 'links', 'GET', '/v1/audit/chain/links', [{}]],
  ['auditChain', 'checkpoints', 'GET', '/v1/audit/chain/checkpoints', [{}]],
  ['auditChain', 'signCheckpoint', 'POST', '/v1/audit/chain/checkpoints', []],
  ['auditChain', 'verify', 'POST', '/v1/audit/chain/verify', [{}]],
  ['sessionBindings', 'get', 'GET', '/v1/sessions/p1/binding', ['p1']],
  ['sessionBindings', 'remove', 'DELETE', '/v1/sessions/p1/binding', ['p1']],
  ['agentDelegations', 'create', 'POST', '/v1/agent_delegations', [{ child_machine_id: 'm', scopes: ['a'], delegator_user_id: 'u' }]],
  ['agentDelegations', 'list', 'GET', '/v1/agent_delegations', [{}]],
  ['agentDelegations', 'get', 'GET', '/v1/agent_delegations/p1', ['p1']],
  ['agentDelegations', 'graph', 'GET', '/v1/agent_delegations/p1/graph', ['p1']],
  ['agentDelegations', 'revoke', 'POST', '/v1/agent_delegations/p1/revoke', ['p1']],
  ['agentDelegations', 'revokeForUser', 'POST', '/v1/agent_delegations/revoke_for_user', ['u1']],
  ['agentDelegations', 'evaluate', 'POST', '/v1/agent_delegations/p1/evaluate', ['p1']],
];

describe('trust operations', () => {
  it.each(TABLE)('%s.%s sends %s %s', async (ns, name, method, path, args) => {
    const calls: Array<{ url: string; method: string; body?: string }> = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method ?? 'GET', body: init?.body as string | undefined });
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    const client = createAtlasClient({ secretKey: 'sk_test_x', apiUrl: 'https://api.example.test', fetch: fetchImpl }) as unknown as Record<
      string,
      Record<string, (...a: unknown[]) => Promise<unknown>>
    >;
    await client[ns]![name]!(...args);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe(method);
    expect(new URL(calls[0]!.url).pathname).toBe(path);
  });

  it('enable sends enabled: true with the interval', async () => {
    let body = '';
    const fetchImpl = (async (_u: string | URL, init?: RequestInit) => {
      body = String(init?.body);
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    const client = createAtlasClient({ secretKey: 'sk_test_x', apiUrl: 'https://api.example.test', fetch: fetchImpl });
    await client.auditChain.enable({ checkpoint_interval_seconds: 600 });
    expect(JSON.parse(body)).toEqual({ enabled: true, checkpoint_interval_seconds: 600 });
  });
});
