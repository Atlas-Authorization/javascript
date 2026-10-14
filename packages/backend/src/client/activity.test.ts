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

function setup(body: unknown = {}) {
  const { impl, calls } = mockFetch([{ body }]);
  const atlas = createAtlasClient({ secretKey: SECRET, apiUrl: API_URL, fetch: impl });
  const last = () => calls[calls.length - 1]!;
  return { atlas, last };
}

describe('events / usage / configChangelog', () => {
  it('events.list with filters and cursor', async () => {
    const { atlas, last } = setup({
      object: 'list',
      data: [{ object: 'event', id: 'evt_1', type: 'user.created', payload: {}, created_at: 1 }],
      has_more: false,
      next_cursor: null,
      available_types: ['user.created'],
    });
    const page = await atlas.events.list({ type: 'user.created', from: 1, to: '2026-01-01', limit: 5, starting_after: 'evt_0' });
    expect(page.available_types).toEqual(['user.created']);
    expect(last().method).toBe('GET');
    expect(last().url).toBe(`${API_URL}/v1/events?type=user.created&from=1&to=2026-01-01&limit=5&starting_after=evt_0`);
  });

  it('usage.get', async () => {
    const { atlas, last } = setup({ object: 'usage', window: { from: 'a', to: 'b', days: 7 }, metrics: [] });
    const u = await atlas.usage.get({ days: 7 });
    expect(u.window.days).toBe(7);
    expect(last().url).toBe(`${API_URL}/v1/usage?days=7`);
    await atlas.usage.get();
    expect(last().url).toBe(`${API_URL}/v1/usage`);
  });

  it('configChangelog.list', async () => {
    const { atlas, last } = setup({ object: 'config_changelog', data: [], has_more: false, next_cursor: null });
    await atlas.configChangelog.list({ action: 'instance.updated', since: '2026-01-01T00:00:00Z', limit: 20 });
    expect(last().method).toBe('GET');
    expect(last().url).toBe(
      `${API_URL}/v1/config_changelog?action=instance.updated&since=2026-01-01T00%3A00%3A00Z&limit=20`,
    );
  });
});
