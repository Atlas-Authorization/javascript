import { describe, expect, it, vi } from 'vitest';
import { createAtlasClient } from './index';
import { splitBundleParts } from './better-auth-imports';

const API_URL = 'https://api.example.test';

function mockFetch(respond: (url: string, method: string) => unknown = () => ({ object: 'x' })) {
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  const impl = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ url: String(url), method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return new Response(JSON.stringify(respond(String(url), method)), { status: 200 });
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

type Client = ReturnType<typeof createAtlasClient>;

const CASES: Array<[string, string, unknown, (c: Client) => Promise<unknown>]> = [
  ['GET', '/v1/better_auth_imports/public_key', undefined, (c) => c.betterAuthImports.getPublicKey()],
  ['POST', '/v1/better_auth_imports/public_key/rotate', undefined, (c) => c.betterAuthImports.rotatePublicKey()],
  ['POST', '/v1/better_auth_imports', { options: { import_sessions: false } }, (c) => c.betterAuthImports.create({ options: { import_sessions: false } })],
  ['GET', '/v1/better_auth_imports?limit=5', undefined, (c) => c.betterAuthImports.list({ limit: 5 })],
  ['GET', '/v1/better_auth_imports/baimp_1', undefined, (c) => c.betterAuthImports.get('baimp_1')],
  ['PUT', '/v1/better_auth_imports/baimp_1/parts/2', { data: 'line\n' }, (c) => c.betterAuthImports.uploadPart('baimp_1', 2, 'line\n')],
  ['POST', '/v1/better_auth_imports/baimp_1/finalize', undefined, (c) => c.betterAuthImports.finalize('baimp_1')],
  ['POST', '/v1/better_auth_imports/baimp_1/dry_run', { options: { models: ['user'] } }, (c) => c.betterAuthImports.dryRun('baimp_1', { options: { models: ['user'] } })],
  ['POST', '/v1/better_auth_imports/baimp_1/apply', { confirm_conflicts: true }, (c) => c.betterAuthImports.apply('baimp_1', { confirm_conflicts: true })],
  ['DELETE', '/v1/better_auth_imports/baimp_1', undefined, (c) => c.betterAuthImports.delete('baimp_1')],
  ['GET', '/v1/better_auth_imports/jwks', undefined, (c) => c.betterAuthImports.listJwks()],
  ['DELETE', '/v1/better_auth_imports/jwks/k%2F1', undefined, (c) => c.betterAuthImports.deleteJwk('k/1')],
];

describe('betterAuthImports', () => {
  it.each(CASES)('%s %s', async (method, path, body, run) => {
    const { impl, calls } = mockFetch();
    await run(createAtlasClient({ secretKey: 'sk_test_x', apiUrl: API_URL, fetch: impl }));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe(method);
    expect(calls[0]!.url).toBe(`${API_URL}${path}`);
    if (body !== undefined) expect(calls[0]!.body).toEqual(body);
  });

  it('upload() creates, sends every part in order and finalizes', async () => {
    const { impl, calls } = mockFetch((url) => (url.endsWith('/v1/better_auth_imports') ? { object: 'better_auth_import', id: 'baimp_9', status: 'uploading' } : { object: 'better_auth_import', id: 'baimp_9', status: 'ready' }));
    const c = createAtlasClient({ secretKey: 'sk_test_x', apiUrl: API_URL, fetch: impl });
    const seen: number[] = [];
    const text = ['{"header":1}', 'a'.repeat(40), 'b'.repeat(40), 'c'.repeat(40)].join('\n') + '\n';
    const imp = await c.betterAuthImports.upload(text, { partBytes: 60, onPart: (n) => seen.push(n) });
    expect(imp.status).toBe('ready');
    expect(calls.map((x) => `${x.method} ${x.url.slice(API_URL.length)}`)).toEqual([
      'POST /v1/better_auth_imports',
      'PUT /v1/better_auth_imports/baimp_9/parts/1',
      'PUT /v1/better_auth_imports/baimp_9/parts/2',
      'PUT /v1/better_auth_imports/baimp_9/parts/3',
      'POST /v1/better_auth_imports/baimp_9/finalize',
    ]);
    expect(seen).toEqual([1, 2, 3]);
    const sent = calls.filter((x) => x.method === 'PUT').map((x) => (x.body as { data: string }).data).join('');
    expect(sent).toBe(text);
  });

  it('waitFor() polls until the import settles', async () => {
    const states = ['applying', 'applying', 'completed'];
    const { impl, calls } = mockFetch(() => ({ object: 'better_auth_import', id: 'baimp_1', status: states.shift() }));
    const c = createAtlasClient({ secretKey: 'sk_test_x', apiUrl: API_URL, fetch: impl });
    const done = await c.betterAuthImports.waitFor('baimp_1', { sleep: async () => {} });
    expect(done.status).toBe('completed');
    expect(calls).toHaveLength(3);
  });

  it('splitBundleParts keeps whole lines and never exceeds the part size', () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line-${i}-${'x'.repeat(i)}`);
    const parts = splitBundleParts(lines.join('\n') + '\n', 200);
    for (const p of parts) {
      expect(p.endsWith('\n')).toBe(true);
      expect(new TextEncoder().encode(p).length).toBeLessThanOrEqual(200);
    }
    expect(parts.join('')).toBe(lines.join('\n') + '\n');
  });
});
