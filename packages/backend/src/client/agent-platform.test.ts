import { describe, expect, it, vi } from 'vitest';
import { createAtlasClient } from './index';

const API_URL = 'https://api.example.test';

function run(call: (c: ReturnType<typeof createAtlasClient>) => Promise<unknown>) {
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return new Response(JSON.stringify({ object: 'x' }), { status: 200 });
  }) as unknown as typeof fetch;
  const c = createAtlasClient({ secretKey: 'sk_test_x', apiUrl: API_URL, fetch: fetchImpl });
  return call(c).then(() => calls[0]!);
}

const CASES: Array<[string, string, unknown, (c: ReturnType<typeof createAtlasClient>) => Promise<unknown>]> = [
  ['POST', '/v1/mcp_gateways/mgw_1/upstreams', { namespace: 'gh', kind: 'mcp', url: 'https://m.example' }, (c) => c.mcpGateways.upstreams.create('mgw_1', { namespace: 'gh', kind: 'mcp', url: 'https://m.example' })],
  ['POST', '/v1/mcp_gateways/mgw_1/upstreams/mgu_1/test', undefined, (c) => c.mcpGateways.upstreams.test('mgw_1', 'mgu_1')],
  ['POST', '/v1/mcp_gateways/mgw_1/packs', { name: 'p', tools: ['a*'] }, (c) => c.mcpGateways.packs.create('mgw_1', { name: 'p', tools: ['a*'] })],
  ['GET', '/v1/mcp_gateways/mgw_1/pins?status=changed', undefined, (c) => c.mcpGateways.pins.list('mgw_1', { status: 'changed' })],
  ['POST', '/v1/mcp_gateways/mgw_1/pins/gh__list/approve', undefined, (c) => c.mcpGateways.pins.approve('mgw_1', 'gh__list')],
  ['GET', '/v1/connection_actions?provider=github', undefined, (c) => c.connectionActions.catalog.list({ provider: 'github' })],
  ['POST', '/v1/connections/con_1/actions/create_issue', { input: { title: 't' }, dry_run: true }, (c) => c.connectionActions.run('con_1', 'create_issue', { input: { title: 't' }, dry_run: true })],
  ['POST', '/v1/connections/con_1/triggers', { event: 'issues', target_url: 'https://a.example/h' }, (c) => c.connectionActions.triggers.create('con_1', { event: 'issues', target_url: 'https://a.example/h' })],
  ['PATCH', '/v1/connections/con_1/triggers/ctg_1', { status: 'paused' }, (c) => c.connectionActions.triggers.setStatus('con_1', 'ctg_1', 'paused')],
  ['POST', '/v1/connections/con_1/scoped_tokens', { url_prefixes: ['https://api.example/v1'] }, (c) => c.connectionActions.mintScopedToken('con_1', { url_prefixes: ['https://api.example/v1'] })],
  ['GET', '/v1/usage/connections?group_by=day', undefined, (c) => c.connectionActions.usage({ group_by: 'day' })],
  ['PUT', '/v1/agents/mch_1/lifecycle', { sponsor_user_id: 'user_1' }, (c) => c.agentGovernance.lifecycle.set('mch_1', { sponsor_user_id: 'user_1' })],
  ['POST', '/v1/agents/mch_1/renew', { extend_days: 30 }, (c) => c.agentGovernance.lifecycle.renew('mch_1', 30)],
  ['GET', '/v1/agents/mch_1/activity?limit=10', undefined, (c) => c.agentGovernance.activity('mch_1', { limit: 10 })],
  ['POST', '/v1/agent_access_reviews', { name: 'Q4' }, (c) => c.agentGovernance.reviews.start({ name: 'Q4' })],
  ['POST', '/v1/agent_access_reviews/agv_1/items/agi_1/decide', { decision: 'revoked' }, (c) => c.agentGovernance.reviews.decide('agv_1', 'agi_1', { decision: 'revoked' })],
  ['POST', '/v1/mcp_registry/mgr_1/decide', { status: 'approved' }, (c) => c.mcpRegistry.decide('mgr_1', 'approved')],
  ['POST', '/v1/mcp/elevations', { api_key_id: 'key_1', ttl_seconds: 120 }, (c) => c.mcpRegistry.elevate({ api_key_id: 'key_1', ttl_seconds: 120 })],
];

describe('agent platform client', () => {
  it.each(CASES)('%s %s', async (method, path, body, call) => {
    const sent = await run(call);
    expect(sent.method).toBe(method);
    expect(sent.url).toBe(`${API_URL}${path}`);
    expect(sent.body).toEqual(body);
  });
});
