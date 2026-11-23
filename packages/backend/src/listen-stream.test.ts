import { describe, expect, it } from 'vitest';
import { listenEvents } from './listen-stream';

const sse = (chunks: string[]) =>
  new Response(new ReadableStream({ start(c) { for (const s of chunks) c.enqueue(new TextEncoder().encode(s)); c.close(); } }), { status: 200, headers: { 'content-type': 'text/event-stream' } });

describe('listenEvents', () => {
  it('yields webhook events across chunk boundaries, skips keep-alives and stops at expired', async () => {
    let url = '';
    const ev = (id: string) => `id: ${id}\nevent: webhook\ndata: ${JSON.stringify({ id, type: 'user.created', headers: { 'atlas-id': id }, body: { id } })}\n\n`;
    const chunks = [': keep-alive\n\n', ev('evt_1').slice(0, 20), ev('evt_1').slice(20), ev('evt_2'), 'event: expired\ndata: {}\n\n', ev('evt_3')];
    const fetchImpl = (async (u: string) => { url = u; return sse(chunks); }) as unknown as typeof fetch;
    const got: string[] = [];
    for await (const e of listenEvents({ secretKey: 'sk_test_x', sessionId: 'ls_1', baseUrl: 'https://api.example.com', fetchImpl, events: ['user.*'], maxEvents: 5 })) got.push(e.id);
    expect(got).toEqual(['evt_1', 'evt_2']);
    expect(url).toBe('https://api.example.com/v1/listen/sessions/ls_1/stream?events=user.*&max_events=5');
  });

  it('throws with the status on a refused stream', async () => {
    const fetchImpl = (async () => new Response('{}', { status: 404 })) as unknown as typeof fetch;
    await expect(listenEvents({ secretKey: 'sk', sessionId: 'nope', fetchImpl }).next()).rejects.toMatchObject({ status: 404 });
  });
});
