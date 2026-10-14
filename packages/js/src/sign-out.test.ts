// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionTombstones, SignOutError, revokeSession } from './sign-out';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('revokeSession', () => {
  it('reports a confirmed revoke and the promoted session', async () => {
    const request = vi.fn(async () =>
      json({ object: 'session', id: 'sess_1', status: 'revoked', active_session_id: 'sess_2' }),
    );
    const out = await revokeSession(request, 'sess_1');
    expect(out).toMatchObject({ revoked: true, status: 200, activeSessionId: 'sess_2' });
    expect(request).toHaveBeenCalledWith('/v1/client/sessions/sess_1/revoke', { method: 'POST' });
  });

  it('retries once after a network failure or a 5xx', async () => {
    const network = vi
      .fn<() => Promise<Response>>()
      .mockRejectedValueOnce(new TypeError('offline'))
      .mockResolvedValueOnce(json({ status: 'revoked' }));
    expect((await revokeSession(network, 's')).revoked).toBe(true);
    expect(network).toHaveBeenCalledTimes(2);

    const down = vi.fn(async () => json({}, 503));
    expect(await revokeSession(down, 's')).toEqual({ revoked: false, status: 503 });
    expect(down).toHaveBeenCalledTimes(2);
  });

  it('does not retry a refusal, and treats 404 as already revoked', async () => {
    const refused = vi.fn(async () => json({}, 403));
    expect(await revokeSession(refused, 's')).toEqual({ revoked: false, status: 403 });
    expect(refused).toHaveBeenCalledTimes(1);

    expect((await revokeSession(async () => json({}, 404), 's')).revoked).toBe(true);
  });

  it('reports status 0 when the server never answered', async () => {
    const out = await revokeSession(async () => Promise.reject(new TypeError('offline')), 's');
    expect(out).toEqual({ revoked: false, status: 0 });
  });
});

describe('SessionTombstones', () => {
  beforeEach(() => sessionStorage.clear());

  it('remembers signed-out ids across instances in the same tab (sessionStorage)', () => {
    const a = new SessionTombstones();
    a.add('sess_1', undefined, '');
    expect(a.has('sess_1')).toBe(true);
    expect(a.has('sess_2')).toBe(false);
    expect(a.has(null)).toBe(false);
    expect(new SessionTombstones().has('sess_1')).toBe(true);
  });

  it('keeps working in memory when storage throws', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    const t = new SessionTombstones();
    t.add('sess_9');
    expect(t.has('sess_9')).toBe(true);
    vi.restoreAllMocks();
  });

  it('is bounded', () => {
    const t = new SessionTombstones();
    for (let i = 0; i < 50; i++) t.add(`sess_${i}`);
    expect(t.list()).toHaveLength(20);
    expect(t.has('sess_49')).toBe(true);
    expect(t.has('sess_0')).toBe(false);
  });
});

describe('SignOutError', () => {
  it('carries a stable code, the session id and the status', () => {
    const e = new SignOutError('sess_1', 0);
    expect(e).toBeInstanceOf(Error);
    expect(e.code).toBe('SIGN_OUT_REVOKE_FAILED');
    expect(e.sessionId).toBe('sess_1');
    expect(e.status).toBe(0);
    expect(e.message).toMatch(/could not be reached/);
  });
});
