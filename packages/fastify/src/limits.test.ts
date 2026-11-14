import { describe, expect, it, vi } from 'vitest';
import { atlasGrantUsage, atlasRateLimit } from './limits';

const allow = vi.fn(async (_req: unknown) => ({ allowed: true as const, headers: { 'RateLimit-Remaining': '4' } }));
const deny = async () => ({ allowed: false as const, status: 403, headers: { 'X-Why': 'spent' }, body: { error: 'usage' } });

function reply() {
  const r = { headers: {} as Record<string, string>, code: 0, sent: undefined as unknown } as Record<string, any>;
  r.headers = (h: Record<string, string>) => (Object.assign(r.sent_headers ??= {}, h), r);
  r.code = (c: number) => ((r.status = c), r);
  r.send = async (b: unknown) => (r.sent = b);
  return r;
}

describe('fastify limits', () => {
  it('adds headers and does not send when allowed; reads atlasToken before atlas', async () => {
    const rep = reply();
    await atlasRateLimit(allow as never)({ headers: { a: 'b' }, ip: '9.9.9.9', atlasToken: { claims: { sub: 'm' } }, atlas: { claims: { sub: 'u' } } } as never, rep as never);
    expect(rep.sent).toBeUndefined();
    expect(rep.sent_headers).toEqual({ 'RateLimit-Remaining': '4' });
    expect(allow).toHaveBeenLastCalledWith({ claims: { sub: 'm' }, headers: { a: 'b' }, ip: '9.9.9.9' });
  });

  it('sends the denial with its status and body', async () => {
    const rep = reply();
    await atlasGrantUsage(deny as never)({ headers: {} } as never, rep as never);
    expect(rep.status).toBe(403);
    expect(rep.sent).toEqual({ error: 'usage' });
    expect(rep.sent_headers).toEqual({ 'X-Why': 'spent' });
  });

  it('lets a check error reject the hook (fastify answers 500, never allows)', async () => {
    await expect(atlasGrantUsage((async () => { throw new Error('down'); }) as never)({ headers: {} } as never, reply() as never)).rejects.toThrow('down');
  });
});
