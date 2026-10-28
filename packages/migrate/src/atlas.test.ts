import { describe, expect, it } from 'vitest';
import { AtlasApiError, fetchMigrationImportKey, importsPath, splitIntoParts, uploadMigrationBundle } from './atlas';

type Call = { method: string; url: string; auth: string | null; body: unknown };

/** A fake Atlas API: records every call and answers from a handler. */
function fakeAtlas(handler: (c: Call) => { status?: number; body: unknown }) {
  const calls: Call[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>;
    const call = { method: String(init.method), url, auth: headers.authorization ?? null, body: init.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    const r = handler(call);
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof globalThis.fetch;
  return { calls, fetch };
}

const API = 'https://api.atlas.test/';

describe('Atlas upload client', () => {
  it('builds the per-source path', () => {
    expect(importsPath('auth0')).toBe('/v1/migrations/auth0/imports');
    expect(importsPath('better_auth')).toBe('/v1/migrations/better_auth/imports');
  });

  it('fetches the import key with the secret key only', async () => {
    const { calls, fetch } = fakeAtlas(() => ({ body: { object: 'migration_import_key', kid: 'imk_1', public_key: 'pk', alg: 'X25519', fingerprint: 'fp' } }));
    const key = await fetchMigrationImportKey({ secretKey: 'sk_test_1', apiUrl: API, fetch, source: 'cognito' });
    expect(key).toEqual({ kid: 'imk_1', publicKey: 'pk', alg: 'X25519', fingerprint: 'fp' });
    expect(calls).toEqual([{ method: 'GET', url: 'https://api.atlas.test/v1/migrations/cognito/imports/public_key', auth: 'Bearer sk_test_1', body: undefined }]);
  });

  it('creates, uploads every part and finalizes', async () => {
    const { calls, fetch } = fakeAtlas((c) => ({
      status: c.method === 'POST' && c.url.endsWith('/imports') ? 201 : 200,
      body: { object: 'migration_import', id: 'mig_1', source: 'clerk', status: c.url.endsWith('/finalize') ? 'ready' : 'uploading' },
    }));
    const progress: string[] = [];
    const out = await uploadMigrationBundle({
      secretKey: 'sk_test_1',
      apiUrl: API,
      fetch,
      source: 'clerk',
      text: 'header\nchunk1\nchunk2\n',
      options: { on_email_conflict: 'link' },
      onPart: (n, of) => progress.push(`${n}/${of}`),
    });
    expect(out.status).toBe('ready');
    expect(calls.map((c) => `${c.method} ${c.url.replace('https://api.atlas.test', '')}`)).toEqual([
      'POST /v1/migrations/clerk/imports',
      'PUT /v1/migrations/clerk/imports/mig_1/parts/1',
      'POST /v1/migrations/clerk/imports/mig_1/finalize',
    ]);
    expect(calls[0]!.body).toEqual({ options: { on_email_conflict: 'link' } });
    expect(calls[1]!.body).toEqual({ data: 'header\nchunk1\nchunk2\n' });
    expect(progress).toEqual(['1/1']);
  });

  it('resumes an existing import without creating another or re-sending parts', async () => {
    const { calls, fetch } = fakeAtlas(() => ({ body: { object: 'migration_import', id: 'mig_9', source: 'okta', status: 'ready' } }));
    await uploadMigrationBundle({ secretKey: 'sk', apiUrl: API, fetch, source: 'okta', text: 'a\nb\n', importId: 'mig_9', resumeFrom: 2 });
    expect(calls.map((c) => c.method + ' ' + c.url.split('/v1')[1])).toEqual(['POST /migrations/okta/imports/mig_9/finalize']);
  });

  it('surfaces the API error code and message', async () => {
    const { fetch } = fakeAtlas(() => ({ status: 403, body: { errors: [{ code: 'FORBIDDEN', message: 'Missing scope jobs:write.' }] } }));
    const err = await uploadMigrationBundle({ secretKey: 'sk', apiUrl: API, fetch, source: 'auth0', text: 'x\n' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AtlasApiError);
    expect(err).toMatchObject({ status: 403, code: 'FORBIDDEN', message: 'Missing scope jobs:write.' });
  });

  it('splits on line boundaries under the part size', () => {
    expect(splitIntoParts('aaa\nbbb\nccc\n', 8)).toEqual(['aaa\nbbb\n', 'ccc\n']);
    expect(splitIntoParts('aaa\n\nbbb', 100)).toEqual(['aaa\nbbb\n']);
    // A single line longer than the limit still travels whole.
    expect(splitIntoParts('aaaaaaaaaaaa\nb\n', 4)).toEqual(['aaaaaaaaaaaa\n', 'b\n']);
    expect(splitIntoParts('')).toEqual([]);
  });
});
