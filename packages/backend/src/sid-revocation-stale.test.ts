import { describe, expect, it, vi } from 'vitest';
import { SidRevocationList } from './sid-revocation';

function setup(opts: Record<string, unknown>) {
  let t = 1_000_000;
  let healthy = true;
  const fetchImpl = vi.fn(async () => {
    if (!healthy) throw new Error('down');
    return new Response(JSON.stringify({ data: [], has_more: false, next_cursor: null, server_time: t }), { status: 200 });
  }) as unknown as typeof fetch;
  const list = new SidRevocationList({ mode: 'sid_list', intervalMs: 1000, onStale: 'reject', staleAfterMs: 60_000, ...opts }, { secretKey: 'sk_x', baseUrl: 'https://api.test', fetchImpl, now: () => t });
  return { list, advance: (ms: number) => (t += ms), down: () => (healthy = false) };
}

describe('SidRevocationList serveStaleForMs', () => {
  it('fails closed as soon as the list is stale when no grace is set', async () => {
    const { list, advance, down } = setup({});
    await list.isRevoked('s');
    down();
    advance(61_000);
    await list.isRevoked('s');
    expect(list.unavailable()).toBe(true);
  });

  it('keeps answering for the grace, reports it, then fails closed', async () => {
    const seen: number[] = [];
    const { list, advance, down } = setup({ serveStaleForMs: 30_000, onServeStale: (i: { staleForMs: number }) => seen.push(i.staleForMs) });
    await list.isRevoked('s');
    down();
    advance(70_000);
    await list.isRevoked('s');
    expect(list.unavailable()).toBe(false);
    expect(seen).toEqual([10_000]);
    advance(25_000);
    await list.isRevoked('s');
    expect(list.unavailable()).toBe(true);
  });

  it('never serves a list that was never fetched', async () => {
    const { list, advance, down } = setup({ serveStaleForMs: 1e9 });
    down();
    advance(61_000);
    await list.isRevoked('s');
    expect(list.unavailable()).toBe(true);
  });
});
