import { describe, expect, it, vi } from 'vitest';
import { createAtlasClient } from './index';

const SECRET = 'sk_test_placeholder_not_a_real_key';
const API_URL = 'https://api.example.test';

function mockFetch(responses: Array<{ status?: number; body?: unknown }>) {
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body?: unknown }> =
    [];
  let i = 0;
  const impl = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const spec = responses[Math.min(i, responses.length - 1)];
    i += 1;
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(init?.headers ?? {})) headers[k.toLowerCase()] = v as string;
    calls.push({ url: String(url), method: init?.method ?? 'GET', headers, body: init?.body });
    const payload = spec?.body === undefined ? '' : JSON.stringify(spec.body);
    return new Response(payload, { status: spec?.status ?? 200 });
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

const client = (f: typeof fetch, strict?: boolean) =>
  createAtlasClient({ secretKey: SECRET, apiUrl: API_URL, fetch: f, strict });
const last = <T>(xs: T[]): T => xs[xs.length - 1]!;
const json = (body: unknown) => JSON.parse(body as string);

describe('webhook endpoints (complete)', () => {
  it('updates an endpoint in place', async () => {
    const { impl, calls } = mockFetch([{ body: { object: 'webhook_endpoint', id: 'we_1', active: false } }]);
    const r = await client(impl).webhooks.endpoints.update('we_1', { active: false, enabled_events: ['*'] });
    expect(r.active).toBe(false);
    expect([last(calls).method, last(calls).url]).toEqual(['PATCH', `${API_URL}/v1/webhook_endpoints/we_1`]);
    expect(json(last(calls).body)).toEqual({ active: false, enabled_events: ['*'] });
  });

  it('reveals and rotates the signing secret', async () => {
    const { impl, calls } = mockFetch([{ body: { object: 'webhook_secret', secret: 'whsec_1' } }]);
    const c = client(impl);
    const revealed = await c.webhooks.endpoints.revealSecret('we_1');
    expect(revealed.secret).toBe('whsec_1');
    expect([last(calls).method, last(calls).url]).toEqual([
      'POST',
      `${API_URL}/v1/webhook_endpoints/we_1/reveal_secret`,
    ]);
    await c.webhooks.endpoints.rotateSecret('we_1');
    expect(last(calls).url).toBe(`${API_URL}/v1/webhook_endpoints/we_1/rotate_secret`);
    expect(last(calls).body).toBeUndefined();
    await c.webhooks.endpoints.rotateSecret('we_1', { overlap_seconds: 0 });
    expect(json(last(calls).body)).toEqual({ overlap_seconds: 0 });
  });

  it('sends a test event and redelivers', async () => {
    const { impl, calls } = mockFetch([
      { body: { object: 'webhook_delivery', id: 'whd_1', event_id: 'evt_1', status: 'pending', note: '' } },
    ]);
    const c = client(impl);
    await c.webhooks.endpoints.test('we_1');
    expect([last(calls).method, last(calls).url]).toEqual(['POST', `${API_URL}/v1/webhook_endpoints/we_1/test`]);
    await c.webhooks.endpoints.redeliver('we_1', 'whd_1');
    expect(last(calls).url).toBe(`${API_URL}/v1/webhook_endpoints/we_1/deliveries/whd_1/redeliver`);
    await c.webhooks.redeliver('we_1', 'whd_2');
    expect(last(calls).url).toBe(`${API_URL}/v1/webhook_endpoints/we_1/deliveries/whd_2/redeliver`);
  });

  it('lists deliveries with a limit', async () => {
    const { impl, calls } = mockFetch([{ body: { object: 'list', data: [], has_more: false } }]);
    await client(impl).webhooks.deliveries('we_1', { limit: 10 });
    expect(last(calls).url).toBe(`${API_URL}/v1/webhook_endpoints/we_1/deliveries?limit=10`);
  });

  it('sends Atlas-Strict on writes of a strict client', async () => {
    const { impl, calls } = mockFetch([{ body: { object: 'webhook_endpoint', id: 'we_1' } }]);
    const c = client(impl, true);
    await c.webhooks.endpoints.update('we_1', { url: 'https://hook.test' });
    expect(last(calls).headers['atlas-strict']).toBe('true');
    await c.webhooks.endpoints.list();
    expect(last(calls).headers['atlas-strict']).toBeUndefined();
    await c.withOptions({ strict: false }).webhooks.endpoints.update('we_1', { url: 'https://hook.test' });
    expect(last(calls).headers['atlas-strict']).toBe('false');
  });
});
