import { describe, expect, it, vi } from 'vitest';
import { createAtlasClient, evalFilter, filterToSql } from '../index';

function client(body: unknown) {
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  const impl = vi.fn(async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return new Response(JSON.stringify(body), { status: 200 });
  });
  return { atlas: createAtlasClient({ secretKey: 'sk_test_x', apiUrl: 'https://api.example.test', fetch: impl as unknown as typeof fetch }), calls };
}

describe('abac partial evaluation surface', () => {
  it('posts partial_evaluate and accessible_resources', async () => {
    const { atlas, calls } = client({ object: 'abac_residual', decision: 'conditional', filter: { op: 'eq', field: 'resource.department', value: 'eng' } });
    const out = await atlas.abac.partialEvaluate({ principal: { type: 'User', id: 'a' }, action: 'read', resource: { type: 'Doc' }, output: { sql: { columns: { 'resource.department': 'department' } } } });
    expect(calls[0]).toMatchObject({ method: 'POST', url: 'https://api.example.test/v1/abac/partial_evaluate' });
    expect(out.filter).toEqual({ op: 'eq', field: 'resource.department', value: 'eng' });
    await atlas.abac.accessibleResources({ principal: { type: 'User', id: 'a' }, action: 'read', resource_type: 'doc', limit: 5, starting_after: 'd1' });
    expect(calls[1]).toMatchObject({ url: 'https://api.example.test/v1/abac/accessible_resources', body: { limit: 5, starting_after: 'd1' } });
  });

  it('posts the AuthZEN search calls', async () => {
    const { atlas, calls } = client({ results: [{ type: 'todo', id: '1' }], page: { next_token: '', count: 1, total: 1 } });
    const req = { subject: { type: 'user', id: 'rick' }, action: { name: 'can_read' }, resource: { type: 'todo' }, page: { limit: 10 } };
    expect((await atlas.abac.authzenSearchResource(req)).results).toEqual([{ type: 'todo', id: '1' }]);
    await atlas.abac.authzenSearchSubject({ subject: { type: 'user' }, action: { name: 'can_read' }, resource: { type: 'todo', id: '1' } });
    await atlas.abac.authzenSearchAction({ subject: { type: 'user', id: 'rick' }, resource: { type: 'todo', id: '1' } });
    expect(calls.map((c) => c.url.replace('https://api.example.test', ''))).toEqual([
      '/v1/authzen/access/v1/search/resource',
      '/v1/authzen/access/v1/search/subject',
      '/v1/authzen/access/v1/search/action',
    ]);
    expect(calls[0]!.body).toMatchObject({ page: { limit: 10 } });
  });

  it('re-exports the filter helpers', () => {
    const f = { op: 'eq', field: 'resource.department', value: 'eng' } as const;
    expect(evalFilter(f, { resource: { department: 'eng' } })).toBe(true);
    expect(filterToSql(f, { columns: { 'resource.department': 'dept' } })).toEqual({ text: '("dept" = $1)', params: ['eng'] });
  });
});

describe('abac authoring surface', () => {
  it('calls templates, links, schema and diff', async () => {
    const { atlas, calls } = client({ object: 'x' });
    await atlas.abac.templates.list();
    await atlas.abac.templates.create({ name: 'T', source: 'permit (principal == ?principal, action, resource);' });
    await atlas.abac.templates.update('t1', { source: 'forbid (principal == ?principal, action, resource);' });
    await atlas.abac.templates.delete('t1', { force: true });
    await atlas.abac.links.list({ template_id: 't1' });
    await atlas.abac.links.create({ template_id: 't1', name: 'L', principal: { type: 'User', id: 'a' } });
    await atlas.abac.links.update('l1', { enabled: false });
    await atlas.abac.links.delete('l1');
    await atlas.abac.schema.get();
    await atlas.abac.schema.set({ entity_types: { User: {} } });
    await atlas.abac.schema.validate({ source: 'permit (principal, action, resource);' });
    await atlas.abac.schema.delete();
    await atlas.abac.diff('p1', { from: 1, to: 2, semantic: false });
    await atlas.abac.diffSources({ before: 'a', after: 'b' });
    expect(calls.map((c) => `${c.method} ${c.url.replace('https://api.example.test', '')}`)).toEqual([
      'GET /v1/abac_templates',
      'POST /v1/abac_templates',
      'PATCH /v1/abac_templates/t1',
      'DELETE /v1/abac_templates/t1?force=true',
      'GET /v1/abac_policy_links?template_id=t1',
      'POST /v1/abac_policy_links',
      'PATCH /v1/abac_policy_links/l1',
      'DELETE /v1/abac_policy_links/l1',
      'GET /v1/abac_schema',
      'PUT /v1/abac_schema',
      'POST /v1/abac_schema/validate',
      'DELETE /v1/abac_schema',
      'GET /v1/abac_policies/p1/diff?from=1&to=2&semantic=false',
      'POST /v1/abac/diff',
    ]);
    expect(calls[9]!.body).toEqual({ schema: { entity_types: { User: {} } } });
  });
});
