import { describe, expect, it } from 'vitest';
import { createAtlasClient } from './client';
import { AtlasApiError } from './client/error';
import { parseRetryAfter, retryDelay, resolveRetry } from './client/resilience';
import { doctor, formatDoctorReport } from './doctor';

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

function client(responses: Response[], extra: Record<string, unknown> = {}) {
  const calls: Array<{ url: string; method: string }> = [];
  const waits: number[] = [];
  const fetch = (async (url: string, init: { method: string }) => {
    calls.push({ url, method: init.method });
    return responses.shift() ?? json(200, {});
  }) as unknown as typeof globalThis.fetch;
  const atlas = createAtlasClient({ secretKey: 'sk_test_1', fetch, retry: { sleep: async (ms) => void waits.push(ms) }, ...extra });
  return { atlas, calls, waits };
}

describe('Retry-After parsing and the retry decision', () => {
  it('reads seconds and dates', () => {
    expect(parseRetryAfter('2')).toBe(2000);
    expect(parseRetryAfter('Sat, 14 Nov 2026 12:00:10 GMT', Date.parse('2026-11-14T12:00:00Z'))).toBe(10_000);
    expect(parseRetryAfter('soon')).toBeUndefined();
    expect(parseRetryAfter(null)).toBeUndefined();
  });

  it('retries 429 for any method, 503 only when repeating is safe, and never past the cap', () => {
    const p = resolveRetry({ maxRetries: 2 });
    expect(retryDelay(p, 0, 429, 'POST', false, '1')).toBe(1000);
    expect(retryDelay(p, 0, 503, 'POST', false, '1')).toBeUndefined();
    expect(retryDelay(p, 0, 503, 'POST', true, '1')).toBe(1000);
    expect(retryDelay(p, 0, 503, 'GET', false, undefined, () => 0.5)).toBe(125);
    expect(retryDelay(p, 2, 429, 'GET', false, '1')).toBeUndefined();
    expect(retryDelay(p, 0, 429, 'GET', false, '3600')).toBeUndefined();
    expect(retryDelay(p, 0, 500, 'GET', false, '1')).toBeUndefined();
  });
});

describe('client retries', () => {
  it('waits for Retry-After on a 429, then succeeds', async () => {
    const { atlas, calls, waits } = client([json(429, { errors: [{ code: 'RATE_LIMITED', message: 'slow' }] }, { 'retry-after': '2' }), json(200, { id: 'sess_1' })]);
    await expect(atlas.sessions.get('sess_1')).resolves.toMatchObject({ id: 'sess_1' });
    expect(calls).toHaveLength(2);
    expect(waits).toEqual([2000]);
  });

  it('gives up after maxRetries and exposes retryAfterMs', async () => {
    const r = () => json(503, { errors: [{ code: 'UNAVAILABLE', message: 'down' }] }, { 'retry-after': '1' });
    const { atlas, calls } = client([r(), r(), r(), r()]);
    const err = await atlas.sessions.get('sess_1').catch((e) => e);
    expect(err).toBeInstanceOf(AtlasApiError);
    expect(err.status).toBe(503);
    expect(err.retryAfterMs).toBe(1000);
    expect(calls).toHaveLength(3);
  });

  it('does not retry a 503 on a write without an idempotency key, nor with retry: false', async () => {
    const a = client([json(503, { errors: [{ code: 'UNAVAILABLE', message: 'down' }] })]);
    await expect(a.atlas.users.create({ email_address: ['a@example.com'] } as never)).rejects.toBeInstanceOf(AtlasApiError);
    expect(a.calls).toHaveLength(1);
    const b = client([json(429, { errors: [{ code: 'RATE_LIMITED', message: 'x' }] })], { retry: false });
    await expect(b.atlas.sessions.get('sess_1')).rejects.toBeInstanceOf(AtlasApiError);
    expect(b.calls).toHaveLength(1);
  });
});

describe('OpenTelemetry', () => {
  it('records a span and metrics through an injected tracer and meter, retries included', async () => {
    const spans: Array<{ name: string; attrs: Record<string, unknown>; ended: boolean; status?: number }> = [];
    const counts: Record<string, number> = {};
    const tracer = {
      startSpan(name: string, o?: { attributes?: Record<string, unknown> }) {
        const s = { name, attrs: { ...o?.attributes }, ended: false, status: undefined as number | undefined };
        spans.push(s);
        return { setAttribute: (k: string, v: unknown) => void (s.attrs[k] = v), setStatus: (x: { code: number }) => void (s.status = x.code), end: () => void (s.ended = true) };
      },
    };
    const meter = {
      createCounter: (n: string) => ({ add: (v: number) => void (counts[n] = (counts[n] ?? 0) + v) }),
      createHistogram: (n: string) => ({ record: () => void (counts[n] = (counts[n] ?? 0) + 1) }),
    };
    const { atlas } = client([json(429, { errors: [{ code: 'RATE_LIMITED', message: 'x' }] }, { 'retry-after': '1' }), json(200, { id: 'sess_abc12345' })], { otel: { tracer, meter } });
    await atlas.sessions.get('sess_abc12345');
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({ ended: true, status: 1 });
    expect(spans[0]!.name).toBe('atlas GET /v1/sessions/{id}');
    expect(spans[0]!.attrs['atlas.retry_count']).toBe(1);
    expect(spans[0]!.attrs['http.response.status_code']).toBe(200);
    expect(counts['atlas.client.requests']).toBe(1);
    expect(counts['atlas.client.retries']).toBe(1);
  });

  it('does nothing when otel is unset', async () => {
    const { atlas } = client([json(200, { id: 'sess_1' })]);
    await expect(atlas.sessions.get('sess_1')).resolves.toBeDefined();
  });
});

describe('doctor', () => {
  const instance = { id: 'ins_1', environment: 'production', frontend_api_host: 'fapi.example.test', issuer: 'https://fapi.example.test', jwks_uri: 'https://fapi.example.test/.well-known/jwks.json', allowed_origins: ['https://app.example.test'] };
  const make = (skewSeconds: number, over: Partial<Record<string, Response>> = {}) => {
    const now = Date.parse('2026-11-14T12:00:00Z');
    return {
      now: () => now,
      fetch: (async (url: string) => {
        if (over[url]) return over[url]!;
        if (url.endsWith('/v1/instance')) return json(200, instance, { date: new Date(now - skewSeconds * 1000).toUTCString() });
        if (url.endsWith('/.well-known/jwks.json')) return json(200, { keys: [{ kid: 'k1' }] });
        if (url.endsWith('/v1/status')) return json(200, { status: 'operational' });
        return json(404, {});
      }) as unknown as typeof globalThis.fetch,
    };
  };

  it('passes on a healthy instance and prints no key', async () => {
    const report = await doctor({ secretKey: 'sk_live_secretvalue', apiUrl: 'https://api.example.test', ...make(0) });
    expect(report.ok).toBe(true);
    expect(report.checks.map((c) => c.status)).toEqual(['pass', 'pass', 'pass', 'pass', 'pass', 'pass', 'pass']);
    expect(JSON.stringify(report) + formatDoctorReport(report)).not.toContain('secretvalue');
  });

  it('flags clock skew, a publishable key and a refused key', async () => {
    expect((await doctor({ secretKey: 'sk_test_1', ...make(45) })).checks.find((c) => c.name === 'clock')!.status).toBe('warn');
    const big = await doctor({ secretKey: 'sk_test_1', ...make(600) });
    expect(big.ok).toBe(false);
    expect(big.clockSkewSeconds).toBe(600);
    expect((await doctor({ secretKey: 'pk_test_1', ...make(0) })).checks[0]).toMatchObject({ name: 'key', status: 'fail' });
    const refused = await doctor({ secretKey: 'sk_test_1', apiUrl: 'https://api.atlasauth.net', ...make(0, { 'https://api.atlasauth.net/v1/instance': json(401, {}) }) });
    expect(refused.ok).toBe(false);
    expect(refused.checks.filter((c) => c.status === 'skip')).toHaveLength(5);
  });
});

describe('connection reset retry', () => {
  const reset = () => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) });
  function resetClient(outcomes: Array<Error | Response>) {
    const calls: string[] = [];
    const waits: number[] = [];
    const fetch = (async (_u: string, init: { method: string }) => {
      calls.push(init.method);
      const o = outcomes.shift() ?? json(200, {});
      if (o instanceof Error) throw o;
      return o;
    }) as unknown as typeof globalThis.fetch;
    const atlas = createAtlasClient({ secretKey: 'sk_test_1', fetch, retry: { sleep: async (ms) => void waits.push(ms) } });
    return { atlas, calls, waits };
  }

  it('retries a GET once after a reset, with a short jittered wait', async () => {
    const { atlas, calls, waits } = resetClient([reset(), json(200, { id: 'u1', object: 'user' })]);
    await atlas.users.get('u1');
    expect(calls).toEqual(['GET', 'GET']);
    expect(waits).toHaveLength(1);
    expect(waits[0]).toBeLessThan(100);
  });

  it('retries only once', async () => {
    const { atlas, calls } = resetClient([reset(), reset(), json(200, {})]);
    await expect(atlas.users.get('u1')).rejects.toThrow('fetch failed');
    expect(calls).toHaveLength(2);
  });

  it('does not retry a plain write, a timeout or an abort', async () => {
    const w = resetClient([reset()]);
    await expect(w.atlas.users.create({ email_address: 'a@example.com' })).rejects.toThrow();
    expect(w.calls).toEqual(['POST']);
    for (const name of ['TimeoutError', 'AbortError']) {
      const t = resetClient([Object.assign(new Error('x'), { name, cause: { code: 'ECONNRESET' } })]);
      await expect(t.atlas.users.get('u1')).rejects.toThrow();
      expect(t.calls).toHaveLength(1);
    }
  });

  it('retries a write that carries an idempotency key', async () => {
    const { atlas, calls } = resetClient([Object.assign(new Error('other side closed')), json(200, {})]);
    await atlas.users.create({ email_address: 'a@example.com' }, 'idem-1').catch(() => undefined);
    expect(calls).toEqual(['POST', 'POST']);
  });
});
