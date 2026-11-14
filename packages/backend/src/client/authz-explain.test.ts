import { describe, expect, it, vi } from 'vitest';
import { createAtlasClient } from './index';

const SECRET = 'sk_test_placeholder_not_a_real_key';
const API_URL = 'https://api.example.test';

function setup(responses: unknown[]) {
  const calls: Array<{ url: string; method: string; body?: string; headers: Record<string, string> }> = [];
  let i = 0;
  const impl = vi.fn(async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? 'GET', body: init?.body as string | undefined, headers: (init?.headers ?? {}) as Record<string, string> });
    return new Response(JSON.stringify(responses[Math.min(i++, responses.length - 1)]), { status: 200 });
  });
  return { atlas: createAtlasClient({ secretKey: SECRET, apiUrl: API_URL, fetch: impl as unknown as typeof fetch }), calls };
}

describe('authz explain, what-if and events', () => {
  it('explains, role-checks and replays', async () => {
    const { atlas, calls } = setup([{ object: 'authz_explanation' }, { object: 'rbac_check' }, { object: 'authz_what_if' }]);
    await atlas.authz.explain({ subject: { id: 'u1' }, action: 'docs:read', resource: { type: 'doc', id: 'd1' } });
    await atlas.authz.rbacCheck({ subject: { id: 'u1' }, permission: 'docs:read' });
    await atlas.authz.whatIf.run({ candidate: { abac: { remove: ['p'] } }, days: 3 });
    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual(['POST /v1/authz/explain', 'POST /v1/authz/rbac/check', 'POST /v1/authz/what_if']);
    expect(JSON.parse(calls[0]!.body!)).toMatchObject({ subject: { id: 'u1' }, action: 'docs:read' });
    expect(JSON.parse(calls[2]!.body!)).toEqual({ candidate: { abac: { remove: ['p'] } }, days: 3 });
  });

  it('lists, reads and deletes saved what-if runs', async () => {
    const { atlas, calls } = setup([{ object: 'list', data: [], has_more: false }, { object: 'authz_what_if_run' }, { object: 'authz_what_if_run', deleted: true }]);
    await atlas.authz.whatIf.list({ limit: 5 });
    await atlas.authz.whatIf.get('azwi_1');
    await atlas.authz.whatIf.delete('azwi_1');
    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual(['GET /v1/authz/what_if', 'GET /v1/authz/what_if/azwi_1', 'DELETE /v1/authz/what_if/azwi_1']);
    expect(new URL(calls[0]!.url).searchParams.get('limit')).toBe('5');
  });

  it('lists events with a joined kinds filter, and watch follows next_after', async () => {
    const first = setup([{ object: 'list', data: [{ id: 'azev_1', seq: 1 }], has_more: false, next_after: 1 }]);
    const page = await first.atlas.authz.events.list({ after: 'latest', kinds: ['tuples_written', 'sync_run'], wait_ms: 100 });
    expect(page.next_after).toBe(1);
    expect(Object.fromEntries(new URL(first.calls[0]!.url).searchParams)).toEqual({ after: 'latest', kinds: 'tuples_written,sync_run', wait_ms: '100' });

    const w = setup([
      { object: 'list', data: [{ id: 'azev_1', seq: 1 }], has_more: false, next_after: 1 },
      { object: 'list', data: [{ id: 'azev_2', seq: 2 }], has_more: false, next_after: 2 },
    ]);
    const ctl = new AbortController();
    const seen: string[] = [];
    for await (const e of w.atlas.authz.events.watch({ after: 5, signal: ctl.signal })) {
      seen.push(e.id);
      if (seen.length === 2) ctl.abort();
    }
    expect(seen).toEqual(['azev_1', 'azev_2']);
    expect(new URL(w.calls[0]!.url).searchParams.get('after')).toBe('5');
    expect(new URL(w.calls[1]!.url).searchParams.get('after')).toBe('1');
  });
});

describe('fga sync', () => {
  it('reads, updates, backfills, lists runs and purges', async () => {
    const { atlas, calls } = setup([{ object: 'fga.sync' }, { object: 'fga.sync' }, { object: 'fga_sync_run' }, { object: 'list', data: [] }, { object: 'fga_sync_run' }, { object: 'fga.sync_purge' }]);
    await atlas.fga.sync.get();
    await atlas.fga.sync.update({ enabled: true, store_id: 'fgas_1' });
    await atlas.fga.sync.backfill({ repair: true });
    await atlas.fga.sync.runs.list();
    await atlas.fga.sync.runs.get('fgasr_1');
    await atlas.fga.sync.purge();
    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      'GET /v1/fga/sync',
      'PUT /v1/fga/sync',
      'POST /v1/fga/sync/backfill',
      'GET /v1/fga/sync/runs',
      'GET /v1/fga/sync/runs/fgasr_1',
      'POST /v1/fga/sync/purge',
    ]);
    expect(JSON.parse(calls[1]!.body!)).toEqual({ enabled: true, store_id: 'fgas_1' });
    expect(JSON.parse(calls[5]!.body!)).toEqual({ confirm: true });
  });
});
