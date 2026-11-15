import { describe, expect, it, vi } from 'vitest';
import { createAtlasClient, VcWaitTimeoutError } from './index';

const API_URL = 'https://api.example.test';
const request = (status: string, extra: Record<string, unknown> = {}) => ({
  object: 'vc_presentation_request',
  id: 'vpr_1',
  status,
  expires_at: 10_000_000,
  result: status === 'verified' ? { issuer: 'https://issuer.example', vct: 'urn:vct:age', claims: { age_over_18: true } } : null,
  error: status === 'failed' ? 'The wallet answered access_denied.' : null,
  ...extra,
});

/** Answers each call from the queue; the last answer repeats. Records method + path. */
function client(answers: unknown[]) {
  const calls: string[] = [];
  let i = 0;
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    calls.push(`${init?.method ?? 'GET'} ${new URL(String(url)).pathname}`);
    return new Response(JSON.stringify(answers[Math.min(i++, answers.length - 1)]), { status: 200 });
  }) as unknown as typeof fetch;
  return { atlas: createAtlasClient({ secretKey: 'sk_test_x', apiUrl: API_URL, fetch: fetchImpl } as never), calls };
}

describe('vc.presentationRequests.waitForResult', () => {
  it('polls until the request is no longer pending and returns the verified result', async () => {
    const { atlas, calls } = client([request('pending'), request('pending'), request('verified')]);
    const sleep = vi.fn(async () => undefined);
    const done = await atlas.vc.presentationRequests.waitForResult('vpr_1', { sleep, now: () => 0, intervalMs: 1000 });
    expect(done.status).toBe('verified');
    expect(done.result?.claims).toEqual({ age_over_18: true });
    expect(calls).toEqual(['GET /v1/vc/presentation_requests/vpr_1', 'GET /v1/vc/presentation_requests/vpr_1', 'GET /v1/vc/presentation_requests/vpr_1']);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(1000);
  });

  it('returns a failed request as it is, for the caller to read the error', async () => {
    const { atlas } = client([request('failed')]);
    const done = await atlas.vc.presentationRequests.waitForResult('vpr_1', { sleep: async () => undefined });
    expect(done).toMatchObject({ status: 'failed', error: 'The wallet answered access_denied.' });
  });

  it('times out with VcWaitTimeoutError, at the caller timeout or the request expiry, whichever is first', async () => {
    let clock = 0;
    const tick = async () => {
      clock += 1_000;
    };
    const slow = client([request('pending')]);
    await expect(slow.atlas.vc.presentationRequests.waitForResult('vpr_1', { timeoutMs: 3_000, sleep: tick, now: () => clock })).rejects.toBeInstanceOf(VcWaitTimeoutError);
    clock = 0;
    const expiring = client([request('pending', { expires_at: 2_000 })]);
    await expect(expiring.atlas.vc.presentationRequests.waitForResult('vpr_1', { timeoutMs: 600_000, sleep: tick, now: () => clock })).rejects.toBeInstanceOf(VcWaitTimeoutError);
  });

  it('stops when the signal aborts', async () => {
    const { atlas, calls } = client([request('pending')]);
    const controller = new AbortController();
    controller.abort();
    await expect(atlas.vc.presentationRequests.waitForResult('vpr_1', { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls).toEqual([]);
  });
});

describe('vc.presentationRequests.verify', () => {
  it('creates the request, hands it to onRequest, then waits for the answer', async () => {
    const { atlas, calls } = client([request('pending'), request('pending'), request('verified')]);
    const seen: string[] = [];
    const done = await atlas.vc.presentationRequests.verify(
      { vct: 'urn:vct:age', claims: ['age_over_18'] },
      { onRequest: (r) => void seen.push(r.id), sleep: async () => undefined, now: () => 0 },
    );
    expect(seen).toEqual(['vpr_1']);
    expect(done.status).toBe('verified');
    expect(calls[0]).toBe('POST /v1/vc/presentation_requests');
    expect(calls.slice(1).every((c) => c === 'GET /v1/vc/presentation_requests/vpr_1')).toBe(true);
  });
});
