import { describe, expect, it, vi } from 'vitest';
import { getTestingToken } from './testing-token';

const SK = 'sk_test_abc';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('getTestingToken', () => {
  it('mints a token on a 2xx { token } body and POSTs with the secret key as Bearer', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ token: 'tt_123' })) as unknown as typeof fetch;

    const token = await getTestingToken({ secretKey: SK, fetchImpl });

    expect(token).toBe('tt_123');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toBe('https://api.atlasauth.net/v1/testing_tokens');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${SK}`);
  });

  it('honours a custom apiUrl and trims a trailing slash', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ token: 'tt_x' })) as unknown as typeof fetch;
    await getTestingToken({ secretKey: SK, apiUrl: 'https://api.acme.test/', fetchImpl });
    const [url] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(url).toBe('https://api.acme.test/v1/testing_tokens');
  });

  it('accepts the nested { testing_token: { token } } envelope', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ testing_token: { token: 'tt_nested' } }),
    ) as unknown as typeof fetch;
    expect(await getTestingToken({ secretKey: SK, fetchImpl })).toBe('tt_nested');
  });

  it('returns null (never throws) when fetch rejects', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    await expect(getTestingToken({ secretKey: SK, fetchImpl })).resolves.toBeNull();
  });

  it('returns null on a non-2xx status', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ errors: [{ code: 'unauthorized' }] }, 401),
    ) as unknown as typeof fetch;
    expect(await getTestingToken({ secretKey: SK, fetchImpl })).toBeNull();
  });

  it('returns null on a 2xx body with no token field', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ nope: true })) as unknown as typeof fetch;
    expect(await getTestingToken({ secretKey: SK, fetchImpl })).toBeNull();
  });

  it('returns null on an unparseable body', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse('<<not json>>')) as unknown as typeof fetch;
    expect(await getTestingToken({ secretKey: SK, fetchImpl })).toBeNull();
  });

  it('returns null when no secret key is given, without calling fetch', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    expect(await getTestingToken({ secretKey: '', fetchImpl })).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
