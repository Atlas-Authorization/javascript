import { describe, expect, it, vi } from 'vitest';
import { atlasLimitsPlugin } from './limits';

const allow = vi.fn(async (_req: unknown) => ({ allowed: true as const, headers: { 'RateLimit-Remaining': '4' } }));
const deny = async () => ({ allowed: false as const, status: 403, headers: { 'X-Why': 'spent' }, body: { error: 'usage' } });

function register(options: Record<string, unknown>) {
  const ext: Record<string, (request: never, h: never) => unknown> = {};
  atlasLimitsPlugin.register({ ext: (e, m) => (ext[e] = m) }, options as never);
  return ext;
}
const toolkit = () => {
  const sent: Record<string, unknown> = { headers: {} };
  const res = { header: (k: string, v: string) => ((sent.headers as Record<string, string>)[k] = v), takeover: () => 'TAKEOVER' };
  return { sent, h: { continue: 'CONTINUE', response: (b: unknown) => ((sent.body = b), { code: (c: number) => ((sent.status = c), res) }) } as never };
};

describe('hapi limits plugin', () => {
  it('continues and stashes the headers for onPreResponse', async () => {
    const ext = register({ rateLimit: allow });
    const request = { headers: { a: 'b' }, auth: { credentials: { auth: { claims: { sub: 'u' } } } }, info: { remoteAddress: '2.2.2.2' }, app: {} };
    expect(await ext.onPreHandler!(request as never, toolkit().h)).toBe('CONTINUE');
    expect(allow).toHaveBeenLastCalledWith({ claims: { sub: 'u' }, headers: { a: 'b' }, ip: '2.2.2.2' });
    const headers: Record<string, string> = {};
    ext.onPreResponse!({ app: request.app, response: { header: (k: string, v: string) => (headers[k] = v) } } as never, { continue: 'CONTINUE' } as never);
    expect(headers).toEqual({ 'RateLimit-Remaining': '4' });
  });

  it('takes over with the denial', async () => {
    const ext = register({ grantUsage: deny });
    const { sent, h } = toolkit();
    expect(await ext.onPreHandler!({ headers: {}, app: {} } as never, h)).toBe('TAKEOVER');
    expect(sent).toMatchObject({ status: 403, body: { error: 'usage' }, headers: { 'X-Why': 'spent' } });
  });

  it('skips a route that opts out', async () => {
    const ext = register({ grantUsage: deny });
    expect(await ext.onPreHandler!({ headers: {}, app: {}, route: { settings: { plugins: { atlasLimits: false } } } } as never, toolkit().h)).toBe('CONTINUE');
  });
});
