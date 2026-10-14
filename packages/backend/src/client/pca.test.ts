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

describe('pca (server controls)', () => {
  it('attestors get/set', async () => {
    const { atlas, last } = setup({ object: 'pca_attestors', trusted_attestor_keys: ['k1'] });
    const a = await atlas.pca.attestors.get();
    expect(a.trusted_attestor_keys).toEqual(['k1']);
    expect(last().method).toBe('GET');
    expect(last().url).toBe(`${API_URL}/v1/pca/attestors`);

    await atlas.pca.attestors.set(['k1', 'k2']);
    expect(last().method).toBe('PUT');
    expect(JSON.parse(last().body!)).toEqual({ trusted_attestor_keys: ['k1', 'k2'] });
  });

  it('freeze / unfreeze', async () => {
    const { atlas, last } = setup({ object: 'pca_freeze', frozen: true });
    await atlas.pca.freeze({ reason: 'incident' });
    expect(last().method).toBe('POST');
    expect(last().url).toBe(`${API_URL}/v1/pca/freeze`);
    expect(JSON.parse(last().body!)).toEqual({ reason: 'incident' });

    await atlas.pca.unfreeze();
    expect(last().method).toBe('DELETE');
    expect(last().url).toBe(`${API_URL}/v1/pca/freeze`);
  });

  it('revoke and denyStepUp', async () => {
    const { atlas, last } = setup({ object: 'pca_revocation', revoked: true });
    await atlas.pca.revoke({ grant_ref: 'g1', cap_id: 'c1' });
    expect(last().method).toBe('POST');
    expect(last().url).toBe(`${API_URL}/v1/pca/revocations`);
    expect(JSON.parse(last().body!)).toEqual({ grant_ref: 'g1', cap_id: 'c1' });

    await atlas.pca.denyStepUp('su_1', { reason: 'no' });
    expect(last().url).toBe(`${API_URL}/v1/pca/stepups/su_1/deny`);
    expect(JSON.parse(last().body!)).toEqual({ reason: 'no' });
  });
});
