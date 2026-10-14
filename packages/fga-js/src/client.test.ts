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
