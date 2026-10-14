import { describe, expect, it, vi } from 'vitest';
import { createAtlasClient, AtlasApiError, AtlasErrorCodes } from './index';
import { createKeyedRequest } from './request';

const SECRET = 'sk_test_placeholder_not_a_real_key';
const API_URL = 'https://api.example.test';

function mockFetch(
  responses: Array<{ status?: number; body?: unknown; headers?: Record<string, string> }>,
) {
  const calls: Array<{
    url: string;
    method: string;
    headers: Record<string, string>;
    body?: unknown;
  }> = [];
  let i = 0;
  const impl = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const spec = responses[Math.min(i, responses.length - 1)];
    i += 1;
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(init?.headers ?? {})) headers[k.toLowerCase()] = v as string;
    calls.push({ url: String(url), method: init?.method ?? 'GET', headers, body: init?.body });
    const status = spec?.status ?? 200;
    return new Response(spec?.body === undefined ? '' : JSON.stringify(spec.body), {
      status,
      headers: spec?.headers,
    });
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

const last = <T>(a: T[]) => a[a.length - 1]!;

describe('strict request bodies', () => {
  it('sends no Atlas-Strict header by default', async () => {
    const { impl, calls } = mockFetch([{ body: { object: 'user', id: 'u' } }]);
    await createAtlasClient({ secretKey: SECRET, apiUrl: API_URL, fetch: impl }).users.create({
      email_address: 'a@b.com',
    });
    expect(last(calls).headers['atlas-strict']).toBeUndefined();
  });

  it('strict: true sends Atlas-Strict: true on writes but not on reads', async () => {
    const { impl, calls } = mockFetch([{ body: { object: 'user', id: 'u' } }]);
    const atlas = createAtlasClient({ secretKey: SECRET, apiUrl: API_URL, fetch: impl, strict: true });
    await atlas.users.create({ email_address: 'a@b.com' });
    expect(last(calls).headers['atlas-strict']).toBe('true');
    await atlas.users.get('u');
    expect(last(calls).headers['atlas-strict']).toBeUndefined();
    await atlas.users.delete('u');
    expect(last(calls).headers['atlas-strict']).toBe('true');
  });

  it('withOptions overrides strict for the calls made through it only', async () => {
    const { impl, calls } = mockFetch([{ body: { object: 'user', id: 'u' } }]);
    const atlas = createAtlasClient({ secretKey: SECRET, apiUrl: API_URL, fetch: impl, strict: true });
    await atlas.withOptions({ strict: false }).users.create({ email_address: 'a@b.com' });
    expect(last(calls).headers['atlas-strict']).toBe('false');
    await atlas.users.create({ email_address: 'a@b.com' });
    expect(last(calls).headers['atlas-strict']).toBe('true');
    expect(last(calls).headers.authorization).toBe(`Bearer ${SECRET}`);
  });

  it('surfaces a strict-mode UNKNOWN_FIELD refusal as an AtlasApiError', async () => {
    const { impl } = mockFetch([
      {
        status: 422,
        body: { errors: [{ code: 'UNKNOWN_FIELD', message: 'Unknown field: nmae', param: 'nmae' }] },
      },
    ]);
    const atlas = createAtlasClient({ secretKey: SECRET, apiUrl: API_URL, fetch: impl, strict: true });
    const err = await atlas.organizations.create({ name: 'x', slug: 'x', created_by: 'user_1' }).catch((e) => e);
    expect(err).toBeInstanceOf(AtlasApiError);
    expect(err.code).toBe(AtlasErrorCodes.UNKNOWN_FIELD);
    expect(err.errors[0].param).toBe('nmae');
  });
});

describe('Atlas-Unknown-Fields', () => {
  it('calls onUnknownFields with the ignored fields', async () => {
    const { impl } = mockFetch([
      { body: { object: 'user', id: 'u' }, headers: { 'Atlas-Unknown-Fields': 'nmae, profile.colour' } },
    ]);
    const onUnknownFields = vi.fn();
    const atlas = createAtlasClient({ secretKey: SECRET, apiUrl: API_URL, fetch: impl, onUnknownFields });
    await atlas.users.update('u', { first_name: 'A' });
    expect(onUnknownFields).toHaveBeenCalledWith({
      method: 'PATCH',
      path: '/v1/users/u',
      fields: ['nmae', 'profile.colour'],
    });
  });

  it('does not call the hook when the header is absent', async () => {
    const { impl } = mockFetch([{ body: { object: 'user', id: 'u' } }]);
    const onUnknownFields = vi.fn();
    await createAtlasClient({ secretKey: SECRET, apiUrl: API_URL, fetch: impl, onUnknownFields }).users.get('u');
    expect(onUnknownFields).not.toHaveBeenCalled();
  });
});

describe('raw request bodies', () => {
  it('sends bytes with their content type, not JSON', async () => {
    const { impl, calls } = mockFetch([{ status: 201, body: { ok: true } }]);
    const request = createKeyedRequest('psk_test', { apiUrl: API_URL, fetch: impl });
    const bytes = new Uint8Array([137, 80, 78, 71]);
    await request({ method: 'POST', path: '/v1/x', rawBody: { data: bytes, contentType: 'image/png' } });
    const call = last(calls);
    expect(call.headers['content-type']).toBe('image/png');
    expect(call.headers.authorization).toBe('Bearer psk_test');
    expect(call.body).toBe(bytes);
  });

  it('takes the content type from a Blob, and requires one otherwise', async () => {
    const { impl, calls } = mockFetch([{ status: 201, body: { ok: true } }]);
    const request = createKeyedRequest('psk_test', { apiUrl: API_URL, fetch: impl });
    await request({ method: 'POST', path: '/v1/x', rawBody: { data: new Blob(['x'], { type: 'image/webp' }) } });
    expect(last(calls).headers['content-type']).toBe('image/webp');
    await expect(
      request({ method: 'POST', path: '/v1/x', rawBody: { data: new Uint8Array([1]) } }),
    ).rejects.toThrow(/contentType/);
  });
});
