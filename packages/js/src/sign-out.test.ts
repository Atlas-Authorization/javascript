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
  const FAPI = 'https://accounts.acme.test';
  const KEY = `atlas:signed-out-sessions:${FAPI}`;
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    sessionStorage.clear();
  });

  it('remembers signed-out ids across instances — and so across tabs (localStorage)', () => {
    const a = new SessionTombstones({ frontendApi: FAPI });
    a.add('sess_1', undefined, '');
    expect(a.has('sess_1')).toBe(true);
    expect(a.has('sess_2')).toBe(false);
    expect(a.has(null)).toBe(false);
    // A tab opened later reads the same store.
    expect(new SessionTombstones({ frontendApi: FAPI }).has('sess_1')).toBe(true);
    expect(localStorage.getItem(KEY)).toContain('sess_1');
    expect(sessionStorage.length).toBe(0);
  });

  it('is keyed per Frontend API origin', () => {
    new SessionTombstones({ frontendApi: `${FAPI}/some/path` }).add('sess_1');
    expect(new SessionTombstones({ frontendApi: FAPI }).has('sess_1')).toBe(true);
    expect(new SessionTombstones({ frontendApi: 'https://accounts.other.test' }).has('sess_1')).toBe(false);
  });

  it('sees another tab add and remove ids on the next read', () => {
    const tabA = new SessionTombstones({ frontendApi: FAPI });
    const tabB = new SessionTombstones({ frontendApi: FAPI });
    tabB.add('sess_1');
    expect(tabA.has('sess_1')).toBe(true);
    tabB.remove('sess_1');
    expect(tabA.has('sess_1')).toBe(false);
    // …and tabA writing later does not resurrect it.
    tabA.add('sess_2');
    expect(tabB.list()).toEqual(['sess_2']);
  });

  it('remove() forgets a tombstone (a later confirmed revoke)', () => {
    const t = new SessionTombstones({ frontendApi: FAPI });
    t.add('sess_1', 'sess_2');
    t.remove('sess_1');
    expect(t.has('sess_1')).toBe(false);
    expect(t.has('sess_2')).toBe(true);
    expect(new SessionTombstones({ frontendApi: FAPI }).list()).toEqual(['sess_2']);
  });

  it('expires entries after 30 days, pruned on read', () => {
    let now = Date.UTC(2026, 0, 1);
    const t = new SessionTombstones({ frontendApi: FAPI, now: () => now });
    t.add('sess_old');
    now += 29 * 24 * 3600 * 1000;
    t.add('sess_new');
    expect(t.has('sess_old')).toBe(true);
    now += 2 * 24 * 3600 * 1000;
    expect(t.has('sess_old')).toBe(false);
    expect(t.list()).toEqual(['sess_new']);
  });

  it('is bounded to the 20 most recent', () => {
    const t = new SessionTombstones({ frontendApi: FAPI });
    for (let i = 0; i < 50; i++) t.add(`sess_${i}`);
    expect(t.list()).toHaveLength(20);
    expect(t.has('sess_49')).toBe(true);
    expect(t.has('sess_0')).toBe(false);
    expect((JSON.parse(localStorage.getItem(KEY)!) as unknown[]).length).toBe(20);
  });

  it('falls back to sessionStorage only when localStorage throws', () => {
    const fail = () => {
      throw new Error('quota');
    };
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: fail, removeItem: fail });
    try {
      const t = new SessionTombstones({ frontendApi: FAPI });
      t.add('sess_9');
      expect(t.has('sess_9')).toBe(true);
      expect(sessionStorage.getItem(KEY)).toContain('sess_9');
      // Same tab, new instance: still found (via the sessionStorage copy).
      expect(new SessionTombstones({ frontendApi: FAPI }).has('sess_9')).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
    // Nothing went to sessionStorage while localStorage worked.
    sessionStorage.clear();
    new SessionTombstones({ frontendApi: FAPI }).add('sess_10');
    expect(sessionStorage.getItem(KEY)).toBeNull();
  });

  it('keeps working in memory when every storage throws', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    const t = new SessionTombstones({ frontendApi: FAPI });
    t.add('sess_9');
    expect(t.has('sess_9')).toBe(true);
  });

  it('reports another tab’s change through the storage event', () => {
    const t = new SessionTombstones({ frontendApi: FAPI });
    const seen: string[][] = [];
    const off = t.subscribe((ids) => seen.push(ids));
    localStorage.setItem(KEY, JSON.stringify([{ id: 'sess_x', at: Date.now() }]));
    window.dispatchEvent(new StorageEvent('storage', { key: KEY }));
    window.dispatchEvent(new StorageEvent('storage', { key: 'unrelated' }));
    expect(seen).toEqual([['sess_x']]);
    off();
    window.dispatchEvent(new StorageEvent('storage', { key: KEY }));
    expect(seen).toHaveLength(1);
  });

  it('carries over tombstones an older SDK kept in sessionStorage', () => {
    sessionStorage.setItem('atlas:signed-out-sessions', JSON.stringify(['sess_legacy']));
    const t = new SessionTombstones({ frontendApi: FAPI });
    expect(t.has('sess_legacy')).toBe(true);
    expect(localStorage.getItem(KEY)).toContain('sess_legacy');
    expect(sessionStorage.getItem('atlas:signed-out-sessions')).toBeNull();
  });

  it('still accepts a bare storage key (earlier constructor signature)', () => {
    new SessionTombstones('custom-key').add('sess_1');
    expect(localStorage.getItem('custom-key')).toContain('sess_1');
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
