import { describe, expect, it, vi } from 'vitest';
import { createAtlasClient } from './index';

const API_URL = 'https://api.example.test';

describe('groups resource', () => {
  it('hits the group, member and rule routes', async () => {
    const calls: string[] = [];
    const impl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${String(url).replace(API_URL, '')}`);
      return new Response(JSON.stringify({ object: 'list', data: [] }), { status: 200 });
    });
    const client = createAtlasClient({ secretKey: 'sk_test_x', apiUrl: API_URL, fetch: impl as unknown as typeof fetch });
    await client.groups.list();
    await client.groups.create({ slug: 'eng', name: 'Eng' });
    await client.groups.addMembers('eng', ['usr_1']);
    await client.groups.removeMembers('eng', ['usr_1']);
    await client.groups.reapply('eng');
    await client.groups.forUser('usr_1');
    await client.groups.rules.create({ name: 'r', condition: { field: 'banned', op: 'eq', value: false }, actions: [{ type: 'add_to_group', group: 'eng' }] });
    await client.groups.rules.applyAll();
    expect(calls).toEqual([
      'GET /v1/groups',
      'POST /v1/groups',
      'POST /v1/groups/eng/members',
      'POST /v1/groups/eng/members/remove',
      'POST /v1/groups/eng/reapply',
      'GET /v1/users/usr_1/groups',
      'POST /v1/group_rules',
      'POST /v1/group_rules/apply',
    ]);
  });
});
