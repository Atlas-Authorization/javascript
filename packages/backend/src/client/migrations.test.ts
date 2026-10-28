import { describe, expect, it, vi } from 'vitest';
import { createAtlasClient } from './index';

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
const I = '/v1/migrations/auth0/imports';

const CASES: Array<[string, string, unknown, (c: Client) => Promise<unknown>]> = [
  ['GET', '/v1/migrations/sources', undefined, (c) => c.migrations.sources()],
  ['GET', `${I}/public_key`, undefined, (c) => c.migrations.imports('auth0').getPublicKey()],
  ['POST', `${I}/public_key/rotate`, undefined, (c) => c.migrations.imports('auth0').rotatePublicKey()],
  ['POST', I, { options: { import_sessions: false } }, (c) => c.migrations.imports('auth0').create({ options: { import_sessions: false } })],
  ['GET', `${I}?limit=5`, undefined, (c) => c.migrations.imports('auth0').list({ limit: 5 })],
  ['GET', `${I}/mimp_1`, undefined, (c) => c.migrations.imports('auth0').get('mimp_1')],
  ['PUT', `${I}/mimp_1/parts/2`, { data: 'line\n' }, (c) => c.migrations.imports('auth0').uploadPart('mimp_1', 2, 'line\n')],
  ['POST', `${I}/mimp_1/finalize`, undefined, (c) => c.migrations.imports('auth0').finalize('mimp_1')],
  ['POST', `${I}/mimp_1/dry_run`, { options: { models: ['user'] } }, (c) => c.migrations.imports('auth0').dryRun('mimp_1', { options: { models: ['user'] } })],
  ['POST', `${I}/mimp_1/apply`, { confirm_conflicts: true }, (c) => c.migrations.imports('auth0').apply('mimp_1', { confirm_conflicts: true })],
  ['DELETE', `${I}/mimp_1`, undefined, (c) => c.migrations.imports('auth0').delete('mimp_1')],
  ['GET', '/v1/migrations/cognito/bridge', undefined, (c) => c.migrations.bridge('cognito').get()],
  [
    'PUT',
    '/v1/migrations/cognito/bridge',
    { enabled: true, preset: 'cognito', preset_vars: { region: 'us-east-1' } },
    (c) => c.migrations.bridge('cognito').update({ enabled: true, preset: 'cognito', preset_vars: { region: 'us-east-1' } }),
  ],
  ['DELETE', '/v1/migrations/cognito/bridge', undefined, (c) => c.migrations.bridge('cognito').delete()],
];

describe('migrations', () => {
  it.each(CASES)('%s %s', async (method, path, body, run) => {
    const { impl, calls } = mockFetch();
    await run(createAtlasClient({ secretKey: 'sk_test_x', apiUrl: API_URL, fetch: impl }));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe(method);
    expect(calls[0]!.url).toBe(`${API_URL}${path}`);
    if (body !== undefined) expect(calls[0]!.body).toEqual(body);
  });

  it('upload() creates, sends every part and finalizes; resumes into an existing import', async () => {
    const { impl, calls } = mockFetch((url) => (url.endsWith(I) ? { object: 'migration_import', id: 'mimp_9', status: 'uploading' } : { object: 'migration_import', id: 'mimp_9', status: 'ready' }));
    const c = createAtlasClient({ secretKey: 'sk_test_x', apiUrl: API_URL, fetch: impl });
    const text = ['{"header":1}', 'a'.repeat(40), 'b'.repeat(40)].join('\n') + '\n';
    const imp = await c.migrations.imports('auth0').upload(text, { partBytes: 60, options: { provider_map: { x: 'y' } } });
    expect(imp.status).toBe('ready');
    expect(calls.map((x) => `${x.method} ${x.url.slice(API_URL.length)}`)).toEqual([`POST ${I}`, `PUT ${I}/mimp_9/parts/1`, `PUT ${I}/mimp_9/parts/2`, `POST ${I}/mimp_9/finalize`]);
    expect(calls[0]!.body).toEqual({ options: { provider_map: { x: 'y' } } });

    calls.length = 0;
    await c.migrations.imports('auth0').upload(text, { partBytes: 60, importId: 'mimp_9', resumeFrom: 2 });
    expect(calls.map((x) => `${x.method} ${x.url.slice(API_URL.length)}`)).toEqual([`PUT ${I}/mimp_9/parts/2`, `POST ${I}/mimp_9/finalize`]);
  });

  it('waitFor() polls until the import settles', async () => {
    const states = ['analyzing', 'queued', 'applying', 'completed'];
    const { impl, calls } = mockFetch(() => ({ object: 'migration_import', id: 'mimp_1', status: states.shift() }));
    const c = createAtlasClient({ secretKey: 'sk_test_x', apiUrl: API_URL, fetch: impl });
    const done = await c.migrations.imports('clerk').waitFor('mimp_1', { sleep: async () => {} });
    expect(done.status).toBe('completed');
    expect(calls).toHaveLength(4);
  });
});
