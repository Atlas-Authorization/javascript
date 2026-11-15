import { describe, expect, it, vi } from 'vitest';
import { createAtlasClient } from './index';

const SECRET = 'sk_test_placeholder_not_a_real_key';
const API_URL = 'https://api.example.test';

function setup(body: unknown = {}) {
  const calls: Array<{ url: string; method: string; body?: string }> = [];
  const impl = vi.fn(async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? 'GET', body: init?.body as string | undefined });
    return new Response(JSON.stringify(body), { status: 200 });
  });
  const atlas = createAtlasClient({ secretKey: SECRET, apiUrl: API_URL, fetch: impl as unknown as typeof fetch });
  return { atlas, last: () => calls[calls.length - 1]! };
}

describe('changes', () => {
  it('list joins types and passes the cursor', async () => {
    const { atlas, last } = setup({ object: 'list', data: [], has_more: false, next_after: 4, head_seq: 4, retention_floor_seq: 0 });
    const page = await atlas.changes.list({ after: 3, types: ['user', 'organization'], limit: 50 });
    expect(page.next_after).toBe(4);
    expect(last().method).toBe('GET');
    expect(last().url).toBe(`${API_URL}/v1/changes?after=3&limit=50&types=user%2Corganization`);
  });

  it('snapshot hits the type path with the cursor', async () => {
    const { atlas, last } = setup({ object: 'list', resource_type: 'user', data: [], has_more: false, next_cursor: null, snapshot_seq: 9, head_seq: 9, retention_floor_seq: 0 });
    await atlas.changes.snapshot('user', { cursor: 'abc', limit: 10 });
    expect(last().url).toBe(`${API_URL}/v1/changes/snapshot/user?cursor=abc&limit=10`);
  });

  it('ack puts the seq and consumers.get reads it', async () => {
    const { atlas, last } = setup({ object: 'change_consumer', name: 'mirror', seq: 7, updated_at: 1, head_seq: 9, lag: 2 });
    await atlas.changes.ack('mirror', 7);
    expect(last().method).toBe('PUT');
    expect(last().url).toBe(`${API_URL}/v1/changes/consumers/mirror/ack`);
    expect(JSON.parse(last().body!)).toEqual({ seq: 7 });
    await atlas.changes.consumers.list();
    expect(last().url).toBe(`${API_URL}/v1/changes/consumers`);
    await atlas.changes.consumers.get('mirror');
    expect(last().url).toBe(`${API_URL}/v1/changes/consumers/mirror`);
  });
});
