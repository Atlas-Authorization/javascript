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

describe('impersonations and web bot directories', () => {
  it('walks the approval flow paths', async () => {
    const { atlas, last } = setup({});
    await atlas.impersonations.requests.list({ status: 'pending' });
    expect(last().url).toBe(`${API_URL}/v1/impersonations/requests?status=pending`);
    await atlas.impersonations.requests.get('imreq_1');
    expect(last().url).toBe(`${API_URL}/v1/impersonations/requests/imreq_1`);
    await atlas.impersonations.requests.approve('imreq_1', { approver_user_id: 'user_2' });
    expect(last()).toMatchObject({ method: 'POST', url: `${API_URL}/v1/impersonations/requests/imreq_1/approve` });
    await atlas.impersonations.requests.deny('imreq_1', { approver_user_id: 'user_2' });
    expect(last().url).toBe(`${API_URL}/v1/impersonations/requests/imreq_1/deny`);
    await atlas.impersonations.end('sess_1');
    expect(last().url).toBe(`${API_URL}/v1/impersonations/sess_1/end`);
  });

  it('manages web bot directories', async () => {
    const { atlas, last } = setup({});
    await atlas.webBotAuth.directories.list();
    expect(last().url).toBe(`${API_URL}/v1/web_bot_auth/directories`);
    await atlas.webBotAuth.directories.add({ directory: 'https://bots.example', list: 'allow' });
    expect(last()).toMatchObject({ method: 'POST', url: `${API_URL}/v1/web_bot_auth/directories` });
    await atlas.webBotAuth.directories.delete('abc');
    expect(last()).toMatchObject({ method: 'DELETE', url: `${API_URL}/v1/web_bot_auth/directories/abc` });
  });
});
