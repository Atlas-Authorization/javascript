import { describe, expect, it } from 'vitest';
import { createAtlasClient } from './index';

// [namespace, method, HTTP method, expected path, arguments]: every operation added for full Backend API coverage.
const TABLE: Array<[string, string, string, string, unknown[]]> = [
  ['ssf', 'getMetadata', 'GET', '/v1/ssf/metadata', []],
  ['ssf', 'createConfiguration', 'POST', '/v1/ssf/configuration', [{}]],
  ['ssf', 'getConfiguration', 'GET', '/v1/ssf/configuration', [{}]],
  ['ssf', 'updateConfiguration', 'PATCH', '/v1/ssf/configuration', [{ stream_id: 's1' }]],
  ['ssf', 'replaceConfiguration', 'PUT', '/v1/ssf/configuration', [{ stream_id: 's1' }]],
  ['ssf', 'deleteConfiguration', 'DELETE', '/v1/ssf/configuration', [{ stream_id: 's1' }]],
  ['ssf', 'addSubject', 'POST', '/v1/ssf/add_subject', [{ stream_id: 's1', subject: {} }]],
  ['ssf', 'removeSubject', 'POST', '/v1/ssf/remove_subject', [{ stream_id: 's1', subject: {} }]],
  ['ssf', 'requestVerification', 'POST', '/v1/ssf/verification', [{ stream_id: 's1' }]],
  ['ssf', 'pollStream', 'POST', '/v1/ssf/streams/p1/poll', ['p1', {}]],
  ['revocations', 'list', 'GET', '/v1/revocations', [{}]],
];

describe('ssf-org parity operations', () => {
  it('covers every table row once', () => {
    expect(new Set(TABLE.map((r) => `${r[0]}.${r[1]}`)).size).toBe(TABLE.length);
  });

  it.each(TABLE)('%s.%s sends %s %s', async (ns, name, method, path, args) => {
    const calls: Array<{ url: string; method: string }> = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method ?? 'GET' });
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    const client = createAtlasClient({ secretKey: 'sk_test_x', apiUrl: 'https://api.example.test', fetch: fetchImpl }) as unknown as Record<
      string,
      Record<string, (...a: unknown[]) => Promise<unknown>>
    >;
    await client[ns]![name]!(...args);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe(method);
    expect(new URL(calls[0]!.url).pathname).toBe(path);
  });
});
