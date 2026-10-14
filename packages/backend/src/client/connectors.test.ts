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

describe('connectors', () => {
  it('CRUD', async () => {
    const { atlas, last } = setup({ object: 'connector', id: 'con_1', slug: 'acme' });
    await atlas.connectors.list();
    expect(last().method).toBe('GET');
    expect(last().url).toBe(`${API_URL}/v1/connectors`);

    const c = await atlas.connectors.create(
      { slug: 'acme', display_name: 'Acme', share_modes: ['prefill'] },
      'idem-c',
    );
    expect(c.id).toBe('con_1');
    expect(last().method).toBe('POST');
    expect(last().url).toBe(`${API_URL}/v1/connectors`);
    expect(JSON.parse(last().body!)).toEqual({ slug: 'acme', display_name: 'Acme', share_modes: ['prefill'] });
    expect(last().headers['idempotency-key']).toBe('idem-c');

    await atlas.connectors.get('con_1');
    expect(last().method).toBe('GET');
    expect(last().url).toBe(`${API_URL}/v1/connectors/con_1`);

    await atlas.connectors.update('con_1', { tagline: 'Hi' });
    expect(last().method).toBe('PATCH');
    expect(last().url).toBe(`${API_URL}/v1/connectors/con_1`);
    expect(JSON.parse(last().body!)).toEqual({ tagline: 'Hi' });

    await atlas.connectors.delete('con_1');
    expect(last().method).toBe('DELETE');
    expect(last().url).toBe(`${API_URL}/v1/connectors/con_1`);
  });

  it('publish, unlist, shared credentials', async () => {
    const { atlas, last } = setup({ object: 'connector', id: 'con_1' });
    await atlas.connectors.publish('con_1');
    expect(last().method).toBe('POST');
    expect(last().url).toBe(`${API_URL}/v1/connectors/con_1/publish`);
    await atlas.connectors.unlist('con_1');
    expect(last().url).toBe(`${API_URL}/v1/connectors/con_1/unlist`);
    await atlas.connectors.setSharedCredentials('con_1', { revoke: true });
    expect(last().url).toBe(`${API_URL}/v1/connectors/con_1/shared_credentials`);
    expect(JSON.parse(last().body!)).toEqual({ revoke: true });
  });

  it('install and review by slug', async () => {
    const { atlas, last } = setup({ object: 'connector_install', connector: 'acme', share_mode: 'prefill' }, 201);
    const i = await atlas.connectors.install('acme', {
      share_mode: 'prefill',
      client_id: 'cid',
      client_secret: 'cs',
      scopes: ['openid'],
    });
    expect(i.share_mode).toBe('prefill');
    expect(last().method).toBe('POST');
    expect(last().url).toBe(`${API_URL}/v1/connectors/acme/install`);
    expect(JSON.parse(last().body!)).toEqual({
      share_mode: 'prefill',
      client_id: 'cid',
      client_secret: 'cs',
      scopes: ['openid'],
    });

    await atlas.connectors.review('acme', { rating: 5, body: 'great' });
    expect(last().url).toBe(`${API_URL}/v1/connectors/acme/reviews`);
    expect(JSON.parse(last().body!)).toEqual({ rating: 5, body: 'great' });
  });

  it('directory with filters', async () => {
    const { atlas, last } = setup({ object: 'list', data: [{ source: 'builtin', key: 'google', slug: 'google', displayName: 'Google', category: 'social' }] });
    const d = await atlas.connectors.directory({ category: 'social', verified: true, q: 'goo', limit: 5, offset: 10 });
    expect(d.data[0]!.displayName).toBe('Google');
    expect(last().method).toBe('GET');
    expect(last().url).toBe(`${API_URL}/v1/directory?category=social&verified=true&q=goo&limit=5&offset=10`);

    await atlas.connectors.directory();
    expect(last().url).toBe(`${API_URL}/v1/directory`);
  });
});
