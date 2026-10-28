import { describe, expect, it, vi } from 'vitest';
import { createAtlasClient } from './index';

const SECRET = 'sk_test_placeholder_not_a_real_key';
const API_URL = 'https://api.example.test';

function setup(responses: unknown[]) {
  const calls: Array<{ url: string; method: string; body?: string }> = [];
  let i = 0;
  const impl = vi.fn(async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? 'GET', body: init?.body as string | undefined });
    return new Response(JSON.stringify(responses[Math.min(i++, responses.length - 1)]), { status: 200 });
  });
  const atlas = createAtlasClient({ secretKey: SECRET, apiUrl: API_URL, fetch: impl as unknown as typeof fetch });
  return { atlas, calls };
}

const page = (users: string[], next: string | null) => ({
  object: 'fga.list_users',
  users,
  excluded_users: [],
  continuation_token: next,
  authorization_model_id: 'm',
  consistency_token: 't',
});

describe('fga: list-users, changes, conditions, consistency', () => {
  it('listUsers posts the filter; listAllUsers follows the cursor', async () => {
    const { atlas, calls } = setup([page(['user:a'], 'c1'), page(['user:b'], null)]);
    const all = await atlas.fga.store('s1').listAllUsers({
      object: 'doc:1',
      relation: 'viewer',
      user_filters: [{ type: 'user' }],
      page_size: 1,
    });
    expect(all.users).toEqual(['user:a', 'user:b']);
    expect(calls[0]!.url).toBe(`${API_URL}/v1/fga/stores/s1/list-users`);
    expect(JSON.parse(calls[1]!.body!).continuation_token).toBe('c1');
  });

  it('readChanges sends query parameters on a GET', async () => {
    const { atlas, calls } = setup([{ object: 'list', data: [], has_more: false, continuation_token: 'tok' }]);
    const out = await atlas.fga.readChanges('s1', { type: 'doc', page_size: 3, continuation_token: 'abc' });
    expect(out.continuation_token).toBe('tok');
    const u = new URL(calls[0]!.url);
    expect(calls[0]!.method).toBe('GET');
    expect(u.pathname).toBe('/v1/fga/stores/s1/changes');
    expect(Object.fromEntries(u.searchParams)).toEqual({ type: 'doc', page_size: '3', continuation_token: 'abc' });
  });

  it('passes conditions, context and consistency through', async () => {
    const { atlas, calls } = setup([{ object: 'fga.write_result', writes: 1, deletes: 0, consistency_token: 'fgc1_w' }, { object: 'fga.check', allowed: true, authorization_model_id: 'm', consistency_token: 'c' }]);
    const w = await atlas.fga.write('s1', {
      writes: [{ user: 'user:a', relation: 'viewer', object: 'doc:1', condition: { name: 'in_office', context: { cidr: '10.0.0.0/8' } } }],
    });
    await atlas.fga.check('s1', { user: 'user:a', relation: 'viewer', object: 'doc:1', context: { ip: '10.0.0.1' }, consistency: 'HIGHER_CONSISTENCY', consistency_token: w.consistency_token });
    expect(JSON.parse(calls[0]!.body!).writes[0].condition.name).toBe('in_office');
    expect(JSON.parse(calls[1]!.body!)).toMatchObject({ context: { ip: '10.0.0.1' }, consistency: 'HIGHER_CONSISTENCY', consistency_token: 'fgc1_w' });
  });
});

describe('fga: settings', () => {
  it('gets and updates the instance settings', async () => {
    const body = { object: 'fga.settings', cache_ttl_ms: 0, default_consistency: 'HIGHER_CONSISTENCY', changelog_retention_days: 30 };
    const { atlas, calls } = setup([body, body]);
    expect((await atlas.fga.settings.get()).default_consistency).toBe('HIGHER_CONSISTENCY');
    await atlas.fga.settings.update({ cache_ttl_ms: 0, changelog_retention_days: 30 });
    expect(calls[0]).toMatchObject({ method: 'GET', url: `${API_URL}/v1/fga/settings` });
    expect(calls[1]).toMatchObject({ method: 'PUT', url: `${API_URL}/v1/fga/settings` });
    expect(JSON.parse(calls[1]!.body!)).toEqual({ cache_ttl_ms: 0, changelog_retention_days: 30 });
  });
});
