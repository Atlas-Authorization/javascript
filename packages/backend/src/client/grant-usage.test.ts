import { describe, expect, it, vi } from 'vitest';
import { createAtlasClient } from './index';

const API_URL = 'https://api.example.test';

function mock() {
  const calls: Array<{ url: string; method: string; body?: string }> = [];
  const impl = vi.fn(async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? 'GET', body: init?.body as string | undefined });
    return new Response('{}', { status: 200 });
  });
  return { client: createAtlasClient({ secretKey: 'sk_test_x', apiUrl: API_URL, fetch: impl as unknown as typeof fetch }), calls };
}

describe('grantUsage and machine grant update', () => {
  it('hits the counter routes', async () => {
    const { client, calls } = mock();
    await client.grantUsage.consume('machine', 'mrg_1', { counter: 'orders', idempotency_key: 'k' });
    expect(calls.at(-1)).toMatchObject({ method: 'POST', url: `${API_URL}/v1/grants/machine/mrg_1/consume` });
    expect(JSON.parse(calls.at(-1)!.body!)).toEqual({ counter: 'orders', idempotency_key: 'k' });
    await client.grantUsage.refund('agent', 'aar_1', { counter: 'orders', idempotency_key: 'r', consume_idempotency_key: 'k' });
    expect(calls.at(-1)).toMatchObject({ method: 'POST', url: `${API_URL}/v1/grants/agent/aar_1/refund` });
    await client.grantUsage.usage('machine', 'mrg_1');
    expect(calls.at(-1)).toMatchObject({ method: 'GET', url: `${API_URL}/v1/grants/machine/mrg_1/usage` });
    await client.grantUsage.releaseLease('machine', 'mrg_1', 'ulse_1', { consumed: 2 });
    expect(calls.at(-1)).toMatchObject({ method: 'POST', url: `${API_URL}/v1/grants/machine/mrg_1/leases/ulse_1/release` });
  });

  it('patches a machine grant', async () => {
    const { client, calls } = mock();
    await client.machines.updateGrant('mch_1', 'mrg_1', { constraints: null, expires_at: null });
    expect(calls.at(-1)).toMatchObject({ method: 'PATCH', url: `${API_URL}/v1/machines/mch_1/grants/mrg_1` });
    expect(JSON.parse(calls.at(-1)!.body!)).toEqual({ constraints: null, expires_at: null });
  });
});
