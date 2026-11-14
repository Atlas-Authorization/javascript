import { describe, expect, it, vi } from 'vitest';
import { atlasGrantUsage, atlasRateLimit } from './limits';

const allow = vi.fn(async (_req: unknown) => ({ allowed: true as const, headers: { 'RateLimit-Remaining': '4' } }));
const deny = vi.fn(async (_req: unknown) => ({ allowed: false as const, status: 429, headers: { 'Retry-After': '3' }, body: { error: 'rate_limited' } }));

function run(mw: ReturnType<typeof atlasRateLimit>, req: Record<string, unknown>) {
  const res = { headers: {} as Record<string, string>, code: 0, body: undefined as unknown } as {
    headers: Record<string, string>;
    code: number;
    body: unknown;
    set: (h: Record<string, string>) => unknown;
    status: (c: number) => { json: (b: unknown) => void };
  };
  res.set = (h) => Object.assign(res.headers, h);
  res.status = (c) => ({ json: (b) => ((res.code = c), (res.body = b)) });
  const next = vi.fn();
  return (mw(req as never, res as never, next) as Promise<unknown>).then(() => ({ res, next }));
}

describe('express limits', () => {
  it('passes the token claims, flattened headers and ip to the check and continues when allowed', async () => {
    const { res, next } = await run(atlasRateLimit(allow as never), {
      headers: { Authorization: 'Bearer x', 'X-Multi': ['a', 'b'] },
      ip: '1.2.3.4',
      atlasToken: { claims: { sub: 'machine_1' } },
      atlas: { claims: { sub: 'user_1' } },
    });
    expect(next).toHaveBeenCalledWith();
    expect(res.headers).toEqual({ 'RateLimit-Remaining': '4' });
    expect(allow).toHaveBeenLastCalledWith({ claims: { sub: 'machine_1' }, headers: { authorization: 'Bearer x', 'x-multi': 'a, b' }, ip: '1.2.3.4' });
  });

  it('falls back to the session claims', async () => {
    await run(atlasRateLimit(allow as never), { headers: {}, atlas: { claims: { sub: 'user_1' } } });
    expect(allow).toHaveBeenLastCalledWith(expect.objectContaining({ claims: { sub: 'user_1' } }));
  });

  it('answers the denial status, headers and body without calling next', async () => {
    const { res, next } = await run(atlasGrantUsage(deny as never), { headers: {} });
    expect(next).not.toHaveBeenCalled();
    expect(res.code).toBe(429);
    expect(res.headers['Retry-After']).toBe('3');
    expect(res.body).toEqual({ error: 'rate_limited' });
  });

  it('forwards a throwing check to next(err) instead of allowing', async () => {
    const boom = new Error('store down');
    const { next, res } = await run(atlasGrantUsage((async () => { throw boom; }) as never), { headers: {} });
    expect(next).toHaveBeenCalledWith(boom);
    expect(res.code).toBe(0);
  });

  it('uses a custom claims reader', async () => {
    await run(atlasGrantUsage(allow as never, { claims: () => ({ sub: 'custom' }) }), { headers: {} });
    expect(allow).toHaveBeenLastCalledWith(expect.objectContaining({ claims: { sub: 'custom' } }));
  });
});
