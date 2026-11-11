import { describe, expect, it, vi } from 'vitest';
import { SidRevocationList } from './sid-revocation';

function setup(pages: Array<{ data: Array<{ sid: string; revoked_at: number }>; has_more?: boolean; next_cursor?: string | null }>) {
  let t = 1_000_000;
  const calls: string[] = [];
  let i = 0;
  const fetchImpl = vi.fn(async (url: string) => {
    calls.push(url);
    const p = pages[Math.min(i++, pages.length - 1)]!;
    return new Response(JSON.stringify({ has_more: false, next_cursor: null, ...p, server_time: t }), { status: 200 });
  }) as unknown as typeof fetch;
  const list = new SidRevocationList({ mode: 'sid_list', intervalMs: 1000, maxTokenLifetimeSeconds: 60 }, { secretKey: 'sk_x', baseUrl: 'https://api.test', fetchImpl, now: () => t });
  return { list, calls, fetchImpl, advance: (ms: number) => (t += ms) };
}

describe('SidRevocationList', () => {
  it('rejects a listed sid, keeps it for the token lifetime, then forgets it', async () => {
    const { list, advance } = setup([{ data: [{ sid: 'sess_a', revoked_at: 1_000_000 }] }, { data: [] }, { data: [] }]);
    expect(await list.isRevoked('sess_a')).toBe(true);
    expect(await list.isRevoked('sess_b')).toBe(false);
    advance(61_000);
    expect(await list.isRevoked('sess_a')).toBe(false);
  });

  it('polls at most once per interval and sends the key', async () => {
    const { list, fetchImpl, advance } = setup([{ data: [] }]);
    await list.isRevoked('s');
    await list.isRevoked('s');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    advance(1500);
    await list.isRevoked('s');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect((fetchImpl as any).mock.calls[0][1].headers.authorization).toBe('Bearer sk_x');
  });

  it('follows pages and keeps the last list when a poll fails', async () => {
    const { list, calls } = setup([
      { data: [{ sid: 'sess_1', revoked_at: 1_000_000 }], has_more: true, next_cursor: 'c1' },
      { data: [{ sid: 'sess_2', revoked_at: 1_000_000 }] },
    ]);
    expect(await list.isRevoked('sess_2')).toBe(true);
    expect(calls[1]).toContain('cursor=c1');
    const onError = vi.fn();
    const bad = new SidRevocationList({ mode: 'sid_list', onError }, { secretKey: 'k', fetchImpl: (async () => new Response('', { status: 500 })) as typeof fetch, now: () => 5 });
    expect(await bad.isRevoked('x')).toBe(false);
    expect(onError).toHaveBeenCalled();
  });
});
