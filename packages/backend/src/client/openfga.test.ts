import { describe, expect, it, vi } from 'vitest';
import { createAtlasClient } from './index';

const SECRET = 'sk_test_placeholder_not_a_real_key';
const API_URL = 'https://api.example.test';

/** A fetch mock that records calls and replies with the queued responses. */
function mockFetch(responses: Array<{ status?: number; body?: unknown; text?: string }>) {
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body?: string }> =
    [];
  let i = 0;
  const impl = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const spec = responses[Math.min(i, responses.length - 1)];
    i += 1;
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(init?.headers ?? {})) headers[k.toLowerCase()] = v as string;
    calls.push({
      url: String(url),
      method: init?.method ?? 'GET',
      headers,
      body: init?.body as string | undefined,
    });
    const status = spec?.status ?? 200;
    const nullBody = status === 204 || status === 205 || status === 304;
    const payload = nullBody
      ? null
      : (spec?.text ?? (spec?.body === undefined ? '' : JSON.stringify(spec.body)));
    return new Response(payload, { status });
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

function setup(body: unknown = {}, status = 200) {
  const { impl, calls } = mockFetch([{ status, body }]);
  const atlas = createAtlasClient({ secretKey: SECRET, apiUrl: API_URL, fetch: impl });
  const last = () => calls[calls.length - 1]!;
  return { atlas, last };
}

const tk = { user: 'user:alice', relation: 'viewer', object: 'document:roadmap' };

describe('openfga', () => {
  it('stores: list, create, get', async () => {
    const { atlas, last } = setup({ stores: [{ id: 's1', name: 'main', created_at: 'x', updated_at: 'y' }] });
    const list = await atlas.openfga.stores.list();
    expect(last().method).toBe('GET');
    expect(last().url).toBe(`${API_URL}/v1/openfga/stores`);
    expect(list.stores[0]!.id).toBe('s1');

    await atlas.openfga.stores.create({ name: 'main' }, 'idem-1');
    expect(last().method).toBe('POST');
    expect(last().url).toBe(`${API_URL}/v1/openfga/stores`);
    expect(JSON.parse(last().body!)).toEqual({ name: 'main' });
    expect(last().headers['idempotency-key']).toBe('idem-1');

    await atlas.openfga.stores.get('s/1');
    expect(last().url).toBe(`${API_URL}/v1/openfga/stores/s%2F1`);
  });

  it('authorization models: list, write, get', async () => {
    const { atlas, last } = setup({ authorization_model_id: 'm1' });
    await atlas.openfga.authorizationModels.list('s1');
    expect(last().method).toBe('GET');
    expect(last().url).toBe(`${API_URL}/v1/openfga/stores/s1/authorization-models`);

    const res = await atlas.openfga.authorizationModels.write('s1', { dsl: 'model\n  schema 1.1' });
    expect(last().method).toBe('POST');
    expect(last().url).toBe(`${API_URL}/v1/openfga/stores/s1/authorization-models`);
    expect(JSON.parse(last().body!)).toEqual({ dsl: 'model\n  schema 1.1' });
    expect(res.authorization_model_id).toBe('m1');

    await atlas.openfga.authorizationModels.get('s1', 'm1');
    expect(last().method).toBe('GET');
    expect(last().url).toBe(`${API_URL}/v1/openfga/stores/s1/authorization-models/m1`);
  });

  it('check, batchCheck, expand, listObjects, read, write', async () => {
    const { atlas, last } = setup({ allowed: true });
    const c = await atlas.openfga.check('s1', {
      tuple_key: tk,
      authorization_model_id: 'm1',
      contextual_tuples: { tuple_keys: [tk] },
    });
    expect(c.allowed).toBe(true);
    expect(last().url).toBe(`${API_URL}/v1/openfga/stores/s1/check`);
    expect(JSON.parse(last().body!)).toEqual({
      tuple_key: tk,
      authorization_model_id: 'm1',
      contextual_tuples: { tuple_keys: [tk] },
    });

    await atlas.openfga.batchCheck('s1', { checks: [{ tuple_key: tk, correlation_id: 'a' }] });
    expect(last().method).toBe('POST');
    expect(last().url).toBe(`${API_URL}/v1/openfga/stores/s1/batch-check`);
    expect(JSON.parse(last().body!)).toEqual({ checks: [{ tuple_key: tk, correlation_id: 'a' }] });

    await atlas.openfga.expand('s1', { tuple_key: { object: 'document:x', relation: 'viewer' } });
    expect(last().url).toBe(`${API_URL}/v1/openfga/stores/s1/expand`);
    expect(JSON.parse(last().body!)).toEqual({ tuple_key: { object: 'document:x', relation: 'viewer' } });

    await atlas.openfga.listObjects('s1', { type: 'document', relation: 'viewer', user: 'user:alice' });
    expect(last().url).toBe(`${API_URL}/v1/openfga/stores/s1/list-objects`);
    expect(JSON.parse(last().body!)).toEqual({ type: 'document', relation: 'viewer', user: 'user:alice' });

    await atlas.openfga.read('s1');
    expect(last().url).toBe(`${API_URL}/v1/openfga/stores/s1/read`);
    expect(JSON.parse(last().body!)).toEqual({});
    await atlas.openfga.read('s1', { tuple_key: { object: 'document:' }, page_size: 10 });
    expect(JSON.parse(last().body!)).toEqual({ tuple_key: { object: 'document:' }, page_size: 10 });

    await atlas.openfga.write('s1', { writes: { tuple_keys: [tk] }, deletes: { tuple_keys: [] } });
    expect(last().method).toBe('POST');
    expect(last().url).toBe(`${API_URL}/v1/openfga/stores/s1/write`);
    expect(JSON.parse(last().body!)).toEqual({ writes: { tuple_keys: [tk] }, deletes: { tuple_keys: [] } });
  });
});
