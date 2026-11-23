import { describe, expect, it } from 'vitest';
import { MemoryConfigStore } from '../config';
import type { ManagementClient, RunContext } from '../context';
import { captureIO } from '../io';
import { run } from '../run';

describe('revocations stream', () => {
  it('prints one frame per line and stops at --count', async () => {
    const urls: string[] = [];
    const sse = 'id: 1\ndata: {"kind":"session","cursor":1}\n\nid: 2\ndata: {"kind":"api_key","cursor":2}\n\nid: 3\ndata: {"kind":"machine","cursor":3}\n\n';
    const io = captureIO();
    const ctx: RunContext = {
      io,
      env: {},
      config: new MemoryConfigStore({ active_profile: 'default', profiles: { default: { api_url: 'https://api.test', secret_key: 'sk_test_123456' } } }),
      prompt: { text: async () => '', secret: async () => '' },
      makeClient: () => ({}) as ManagementClient,
      readFile: () => '',
      fetch: (async (u: string) => {
        urls.push(u);
        return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }) as unknown as typeof fetch,
    };
    expect(await run(['revocations', 'stream', '--after', '9', '--kinds', 'session,api_key', '--count', '2'], ctx)).toBe(0);
    expect(urls).toEqual(['https://api.test/v1/revocations/stream?after=9&kinds=session%2Capi_key']);
    expect(io.stdout().trim().split('\n').map((l) => JSON.parse(l).cursor)).toEqual([1, 2]);
  });
});
