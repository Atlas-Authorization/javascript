import { describe, expect, it, vi } from 'vitest';
import { createSessionExchange } from './session-exchange';

const claims = { sid: 'sess_1', sub: 'user_1' } as never;
const backend = (ok = true) => ({
  verify: vi.fn(async () => (ok ? { ok: true, claims } : { ok: false, reason: 'invalid' })) as never,
  verifyOnline: vi.fn(async () => (ok ? { ok: true, claims } : { ok: false, reason: 'invalid' })) as never,
});
const post = (headers: Record<string, string> = { authorization: 'Bearer tok' }, body?: unknown) =>
  new Request('https://app.example.com/api/auth/atlas/session', {
    method: 'POST',
    headers: { host: 'app.example.com', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

describe('createSessionExchange', () => {
  it('runs onExchange once per sid, sequentially and concurrently', async () => {
    const onExchange = vi.fn(async () => ({ body: { id: 'app_1' }, setCookie: 'app=1; Path=/' }));
    const b = backend();
    const { POST } = createSessionExchange({ backend: b, onExchange });
    const [a, c] = await Promise.all([POST(post()), POST(post())]);
    const again = await POST(post());
    expect(onExchange).toHaveBeenCalledTimes(1);
    for (const r of [a, c, again]) {
      expect(r.status).toBe(200);
      expect(await r.json()).toEqual({ id: 'app_1' });
      expect(r.headers.get('set-cookie')).toContain('app=1');
    }
    expect(b.verifyOnline).toHaveBeenCalled();
  });
  it('verify: local skips the online check; a token in the body works', async () => {
    const b = backend();
    const { POST } = createSessionExchange({ backend: b, verify: 'local', onExchange: () => undefined });
    expect((await POST(post({}, { token: 'tok' }))).status).toBe(200);
    expect(b.verify).toHaveBeenCalledWith('tok');
    expect(b.verifyOnline).not.toHaveBeenCalled();
  });
  it('refuses a bad token, a missing token and a foreign origin without calling onExchange', async () => {
    const onExchange = vi.fn();
    expect((await createSessionExchange({ backend: backend(false), onExchange }).POST(post())).status).toBe(401);
    const ok = createSessionExchange({ backend: backend(), onExchange });
    expect((await ok.POST(post({}))).status).toBe(400);
    expect((await ok.POST(post({ authorization: 'Bearer tok', origin: 'https://evil.example.net' }))).status).toBe(403);
    expect(onExchange).not.toHaveBeenCalled();
  });
  it('a failed onExchange is not remembered, so a retry runs it again', async () => {
    const onExchange = vi.fn().mockRejectedValueOnce(new Error('db down')).mockResolvedValueOnce({ body: { ok: 1 } });
    const { POST } = createSessionExchange({ backend: backend(), onExchange });
    expect((await POST(post())).status).toBe(500);
    expect((await POST(post())).status).toBe(200);
    expect(onExchange).toHaveBeenCalledTimes(2);
  });
});
