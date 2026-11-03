import { describe, expect, it, vi } from 'vitest';
import { FapiClient } from './fapi';
import { removeAvatar, setAvatar } from './avatar';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function clientWith(handler: (url: string, init: RequestInit) => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    return handler(String(input), init);
  }) as unknown as typeof fetch;
  return { client: new FapiClient({ publishableKey: 'pk_test_x', baseUrl: 'https://fapi.example', fetchImpl }), calls };
}

describe('avatar', () => {
  it('uploads the image as the raw body with its own content type', async () => {
    const { client, calls } = clientWith(() => json(200, { id: 'user_1', image_url: 'https://img.example/a.png' }));
    const file = new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' });
    const res = await setAvatar(client, file);
    expect(res).toEqual({ ok: true, user: { id: 'user_1', image_url: 'https://img.example/a.png' } });
    expect(calls[0]!.url).toBe('https://fapi.example/v1/client/me/avatar');
    expect(calls[0]!.init.method).toBe('POST');
    expect(calls[0]!.init.body).toBe(file);
    expect((calls[0]!.init.headers as Record<string, string>)['content-type']).toBe('image/png');
  });

  it('refuses an unsupported type without calling the server', async () => {
    const { client, calls } = clientWith(() => json(200, {}));
    const res = await setAvatar(client, new Blob(['x'], { type: 'image/svg+xml' }));
    expect(res.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('removes the picture with DELETE and passes server errors through', async () => {
    const ok = clientWith(() => json(200, { id: 'user_1', image_url: null }));
    expect(await removeAvatar(ok.client)).toEqual({ ok: true, user: { id: 'user_1', image_url: null } });
    expect(ok.calls[0]!.init.method).toBe('DELETE');
    const bad = clientWith(() => json(401, { errors: [{ code: 'unauthenticated', message: 'Sign in first.' }] }));
    const res = await removeAvatar(bad.client);
    expect(res.ok).toBe(false);
  });
});
