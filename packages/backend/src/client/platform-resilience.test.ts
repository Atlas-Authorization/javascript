import { describe, expect, it, vi } from 'vitest';
import { createAtlasClient } from './index';

const API_URL = 'https://api.example.test';

function setup(body: unknown = {}) {
  const calls: Array<{ url: string; method: string; body?: string }> = [];
  const impl = vi.fn(async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? 'GET', body: init?.body as string | undefined });
    return new Response(JSON.stringify(body), { status: 200 });
  });
  const atlas = createAtlasClient({ secretKey: 'sk_test_placeholder_not_a_real_key', apiUrl: API_URL, fetch: impl as unknown as typeof fetch });
  return { atlas, last: () => calls[calls.length - 1]! };
}

describe('platform resilience resources', () => {
  it('writeBudget get, update and reset', async () => {
    const { atlas, last } = setup({ object: 'write_budget' });
    await atlas.writeBudget.get();
    expect([last().method, last().url]).toEqual(['GET', `${API_URL}/v1/instance/write_budget`]);
    await atlas.writeBudget.update({ mode: 'enforce', writes_per_minute: 100, events_per_minute: null });
    expect(last().method).toBe('PUT');
    expect(JSON.parse(last().body!)).toEqual({ mode: 'enforce', writes_per_minute: 100, events_per_minute: null });
    await atlas.writeBudget.reset();
    expect([last().method, last().url]).toEqual(['DELETE', `${API_URL}/v1/instance/write_budget`]);
  });

  it('deprecations list the instance and public feeds', async () => {
    const { atlas, last } = setup({ object: 'list', data: [] });
    await atlas.deprecations.list();
    expect(last().url).toBe(`${API_URL}/v1/instance/deprecations`);
    await atlas.deprecations.listPublic();
    expect(last().url).toBe(`${API_URL}/v1/deprecations`);
  });

  it('dataKeyDrills run, list and get', async () => {
    const { atlas, last } = setup({ object: 'data_key_drill' });
    await atlas.dataKeyDrills.run();
    expect([last().method, last().url]).toEqual(['POST', `${API_URL}/v1/instance/data_key_provider/rotation_drill`]);
    await atlas.dataKeyDrills.list();
    expect(last().url).toBe(`${API_URL}/v1/instance/data_key_provider/rotation_drills`);
    await atlas.dataKeyDrills.get('cmkdr_1');
    expect(last().url).toBe(`${API_URL}/v1/instance/data_key_provider/rotation_drills/cmkdr_1`);
  });
});
