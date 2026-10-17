import { describe, expect, it, vi } from 'vitest';
import { fetchAtlasInitialState } from './initial-state';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('fetchAtlasInitialState', () => {
  it('fetches the appearance and the environment in parallel with the publishable key', async () => {
    const seen: { url: string; key: string | null; extra: unknown }[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      seen.push({
        url,
        key: new Headers(init?.headers).get('x-publishable-key'),
        extra: (init as { next?: unknown } | undefined)?.next,
      });
      return json(url.endsWith('/v1/appearance') ? { design: null } : { social_providers: [] });
    }) as unknown as typeof fetch;

    const state = await fetchAtlasInitialState({
      publishableKey: 'pk_test_x',
      frontendApi: 'https://auth.example.com/',
      fetchImpl,
      init: { next: { revalidate: 60 } },
    });

    expect(state).toEqual({ appearance: { design: null }, environment: { social_providers: [] } });
    expect(seen.map((s) => s.url).sort()).toEqual([
      'https://auth.example.com/v1/appearance',
      'https://auth.example.com/v1/client/environment',
    ]);
    expect(seen.every((s) => s.key === 'pk_test_x')).toBe(true);
    expect(seen.every((s) => JSON.stringify(s.extra) === '{"revalidate":60}')).toBe(true);
  });

  it('leaves out a part that fails, and never throws', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/v1/appearance')) throw new Error('network down');
      return json({ errors: [] }, 500);
    }) as unknown as typeof fetch;
    await expect(
      fetchAtlasInitialState({ publishableKey: 'pk_test_x', frontendApi: 'https://auth.example.com', fetchImpl }),
    ).resolves.toEqual({});
  });

  it('gives up after timeoutMs and leaves the part to the browser', async () => {
    const fetchImpl = vi.fn(
      (input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((resolve, reject) => {
          if (String(input).endsWith('/v1/client/environment')) {
            resolve(json({ social_providers: [] }));
            return;
          }
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    ) as unknown as typeof fetch;
    const state = await fetchAtlasInitialState({
      publishableKey: 'pk_test_x',
      frontendApi: 'https://auth.example.com',
      fetchImpl,
      timeoutMs: 20,
    });
    expect(state).toEqual({ environment: { social_providers: [] } });
  });

  it('returns nothing without a key or Frontend API', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    expect(await fetchAtlasInitialState({ publishableKey: '', frontendApi: 'https://a.example', fetchImpl })).toEqual({});
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
