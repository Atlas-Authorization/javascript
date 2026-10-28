import { describe, expect, it } from 'vitest';
import { AtlasFga, AtlasFgaError } from './index';

/**
 * A tiny in-memory stand-in for the Atlas `/v1/fga` surface: just enough of the
 * wire contract (paths + response envelopes) to exercise the client end to end
 * without a live server. Records every request so tests can assert on them.
 */
interface Captured {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

function mockAtlas(): { fetch: typeof fetch; calls: Captured[]; tuples: Set<string> } {
  const calls: Captured[] = [];
  const tuples = new Set<string>(); // "user|relation|object"
  const key = (t: { user: string; relation: string; object: string }) =>
    `${t.user}|${t.relation}|${t.object}`;

  const fetchImpl = (async (input: any, init: any) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ method, url, headers: init?.headers ?? {}, body });
    const path = new URL(url).pathname;

    const json = (status: number, payload: unknown) =>
      new Response(JSON.stringify(payload), {
        status,
        headers: { 'content-type': 'application/json' },
      });

    // unknown store -> 404 envelope (to exercise error handling); matched first
    // so it wins over the operation branches below.
    if (path.includes('/stores/missing/')) {
      return json(404, { errors: [{ code: 'store_id_not_found', message: 'Unknown FGA store.' }] });
    }
    // check
    if (method === 'POST' && path.endsWith('/check')) {
      const allowed = tuples.has(key(body));
      return json(200, { object: 'fga.check', allowed, authorization_model_id: 'model_1' });
    }
    // write
    if (method === 'POST' && path.endsWith('/write')) {
      const writes = (body.writes ?? []) as any[];
      const deletes = (body.deletes ?? []) as any[];
      for (const t of writes) tuples.add(key(t));
      for (const t of deletes) tuples.delete(key(t));
      return json(200, { object: 'fga.write_result', writes: writes.length, deletes: deletes.length });
    }
    // list-objects
    if (method === 'POST' && path.endsWith('/list-objects')) {
      const objects = [...tuples]
        .map((k) => k.split('|'))
        .filter(([u, r, o]) => u === body.user && r === body.relation && o!.startsWith(`${body.type}:`))
        .map(([, , o]) => o!);
      return json(200, { object: 'fga.list_objects', objects, authorization_model_id: 'model_1' });
    }
    // read
    if (method === 'POST' && path.endsWith('/read')) {
      const data = [...tuples]
        .map((k) => k.split('|'))
        .filter(([u, r, o]) =>
          (!body.user || u === body.user) &&
          (!body.relation || r === body.relation) &&
          (!body.object || o === body.object))
        .map(([u, r, o]) => ({ object: 'fga.tuple', user: u, relation: r, target: o, created_at: 1 }));
      return json(200, { object: 'list', data, has_more: false });
    }
    // stores create
    if (method === 'POST' && path === '/v1/fga/stores') {
      return json(201, { object: 'fga.store', id: 'store_new', name: body.name, created_at: 1, updated_at: 1 });
    }
    return json(404, { errors: [{ code: 'not_found', message: `no route ${method} ${path}` }] });
  }) as unknown as typeof fetch;

  return { fetch: fetchImpl, calls, tuples };
}

describe('AtlasFga', () => {
  it('authenticates with a Bearer secret key against the configured base URL', async () => {
    const mock = mockAtlas();
    const fga = new AtlasFga({ secretKey: 'sk_test_abc', storeId: 'store_1', fetch: mock.fetch });
    await fga.check({ user: 'user:a', relation: 'viewer', object: 'doc:1' });
    const call = mock.calls[0]!;
    expect(call.url).toBe('https://api.atlasauth.net/v1/fga/stores/store_1/check');
    expect((call.headers as any).authorization).toBe('Bearer sk_test_abc');
  });

  it('returns allowed:false before a write and allowed:true after (write-then-check)', async () => {
    const mock = mockAtlas();
    const fga = new AtlasFga({ secretKey: 'sk_test', storeId: 'store_1', fetch: mock.fetch });

    const before = await fga.check({ user: 'user:alice', relation: 'viewer', object: 'doc:readme' });
    expect(before.allowed).toBe(false);

    const w = await fga.writeTuples([{ user: 'user:alice', relation: 'viewer', object: 'doc:readme' }]);
    expect(w.writes).toBe(1);

    const after = await fga.check({ user: 'user:alice', relation: 'viewer', object: 'doc:readme' });
    expect(after.allowed).toBe(true);
  });

  it('round-trips list-objects after writes', async () => {
    const mock = mockAtlas();
    const fga = new AtlasFga({ secretKey: 'sk_test', storeId: 'store_1', fetch: mock.fetch });
    await fga.store('store_1').writeTuples([
      { user: 'user:bob', relation: 'editor', object: 'doc:1' },
      { user: 'user:bob', relation: 'editor', object: 'doc:2' },
      { user: 'user:bob', relation: 'editor', object: 'folder:x' },
    ]);
    const res = await fga.listObjects({ user: 'user:bob', relation: 'editor', type: 'doc' });
    expect(res.objects.sort()).toEqual(['doc:1', 'doc:2']);
  });

  it('read returns the Atlas list envelope', async () => {
    const mock = mockAtlas();
    const fga = new AtlasFga({ secretKey: 'sk_test', storeId: 'store_1', fetch: mock.fetch });
    await fga.writeTuples([{ user: 'user:x', relation: 'owner', object: 'doc:9' }]);
    const page = await fga.read({ object: 'doc:9' });
    expect(page.object).toBe('list');
    expect(page.has_more).toBe(false);
    expect(page.data[0]!.target).toBe('doc:9');
  });

  it('folds the default authorization_model_id into query bodies', async () => {
    const mock = mockAtlas();
    const fga = new AtlasFga({ secretKey: 'sk_test', storeId: 'store_1', authorizationModelId: 'model_pinned', fetch: mock.fetch });
    await fga.check({ user: 'user:a', relation: 'viewer', object: 'doc:1' });
    expect((mock.calls[0]!.body as any).authorization_model_id).toBe('model_pinned');
  });

  it('surfaces the Atlas error envelope as AtlasFgaError with .code', async () => {
    const mock = mockAtlas();
    const fga = new AtlasFga({ secretKey: 'sk_test', fetch: mock.fetch });
    await expect(fga.check({ user: 'u:a', relation: 'v', object: 'd:1' }, 'missing')).rejects.toSatisfy(
      (e: unknown) => e instanceof AtlasFgaError && (e as AtlasFgaError).code === 'store_id_not_found' && (e as AtlasFgaError).status === 404,
    );
  });

  it('throws without a store id until one is configured or bound', async () => {
    const mock = mockAtlas();
    const fga = new AtlasFga({ secretKey: 'sk_test', fetch: mock.fetch });
    await expect(fga.check({ user: 'u:a', relation: 'v', object: 'd:1' })).rejects.toThrow(/store id/);
  });

  it('requires a secret key', () => {
    expect(() => new AtlasFga({ fetch: mockAtlas().fetch })).toThrow(/secret key/);
  });
});

describe('list-users, changes, conditions and consistency', () => {
  function recorder(responses: unknown[]) {
    const calls: { method: string; url: string; body: any }[] = [];
    let i = 0;
    const fetchImpl = (async (input: any, init: any) => {
      calls.push({ method: (init?.method ?? 'GET').toUpperCase(), url: String(input), body: init?.body ? JSON.parse(init.body) : undefined });
      return new Response(JSON.stringify(responses[Math.min(i++, responses.length - 1)]), { status: 200 });
    }) as unknown as typeof fetch;
    return { fetch: fetchImpl, calls };
  }

  it('listUsers posts the filter and returns usersets/wildcards untouched', async () => {
    const r = recorder([{ object: 'fga.list_users', users: ['user:*'], excluded_users: ['user:eve'], continuation_token: null, authorization_model_id: 'm', consistency_token: 'fgc1_x' }]);
    const fga = new AtlasFga({ secretKey: 'sk_test', storeId: 's1', authorizationModelId: 'm', fetch: r.fetch });
    const out = await fga.listUsers({ object: 'doc:1', relation: 'viewer', user_filters: [{ type: 'user' }], consistency: 'HIGHER_CONSISTENCY' });
    expect(out.excluded_users).toEqual(['user:eve']);
    expect(r.calls[0]!.url).toMatch(/\/v1\/fga\/stores\/s1\/list-users$/);
    expect(r.calls[0]!.body).toMatchObject({ object: 'doc:1', user_filters: [{ type: 'user' }], consistency: 'HIGHER_CONSISTENCY', authorization_model_id: 'm' });
  });

  it('listAllUsers follows the continuation token across pages', async () => {
    const page = (users: string[], next: string | null) => ({ object: 'fga.list_users', users, excluded_users: [], continuation_token: next, authorization_model_id: 'm', consistency_token: 't' });
    const r = recorder([page(['user:a', 'user:b'], 'c1'), page(['user:c'], null)]);
    const fga = new AtlasFga({ secretKey: 'sk_test', storeId: 's1', fetch: r.fetch });
    const all = await fga.store('s2').listAllUsers({ object: 'doc:1', relation: 'viewer', user_filters: [{ type: 'user' }], page_size: 2 });
    expect(all.users).toEqual(['user:a', 'user:b', 'user:c']);
    expect(all.continuation_token).toBeNull();
    expect(r.calls).toHaveLength(2);
    expect(r.calls[1]!.body.continuation_token).toBe('c1');
    expect(r.calls[1]!.url).toContain('/stores/s2/');
  });

  it('readChanges sends a GET with query parameters and no body', async () => {
    const r = recorder([{ object: 'list', data: [], has_more: false, continuation_token: 'tok' }]);
    const fga = new AtlasFga({ secretKey: 'sk_test', storeId: 's1', fetch: r.fetch });
    const page = await fga.readChanges({ type: 'doc', page_size: 10, continuation_token: 'abc', start_time: '2026-01-01T00:00:00Z' });
    expect(page.continuation_token).toBe('tok');
    const c = r.calls[0]!;
    expect(c.method).toBe('GET');
    expect(c.body).toBeUndefined();
    const u = new URL(c.url);
    expect(u.pathname).toBe('/v1/fga/stores/s1/changes');
    expect(Object.fromEntries(u.searchParams)).toEqual({ type: 'doc', page_size: '10', continuation_token: 'abc', start_time: '2026-01-01T00:00:00Z' });
  });

  it('sends conditions, context and consistency tokens on writes and checks', async () => {
    const r = recorder([{ object: 'fga.write_result', writes: 1, deletes: 0, consistency_token: 'fgc1_w' }, { object: 'fga.check', allowed: true, authorization_model_id: 'm', consistency_token: 'fgc1_c' }]);
    const fga = new AtlasFga({ secretKey: 'sk_test', storeId: 's1', fetch: r.fetch });
    const w = await fga.writeTuples([{ user: 'user:a', relation: 'viewer', object: 'doc:1', condition: { name: 'in_office', context: { cidr: '10.0.0.0/8' } } }]);
    await fga.check({ user: 'user:a', relation: 'viewer', object: 'doc:1', context: { ip: '10.1.1.1' }, consistency_token: w.consistency_token });
    expect(r.calls[0]!.body.writes[0].condition).toEqual({ name: 'in_office', context: { cidr: '10.0.0.0/8' } });
    expect(r.calls[1]!.body).toMatchObject({ context: { ip: '10.1.1.1' }, consistency_token: 'fgc1_w' });
  });
});
