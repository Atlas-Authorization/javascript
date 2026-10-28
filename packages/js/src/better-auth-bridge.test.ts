import { describe, expect, it, vi } from 'vitest';
import { FapiClient } from './fapi';
import { clearBetterAuthCookies, exchangeBetterAuthSession, readBetterAuthCookie } from './better-auth-bridge';

/** A tiny cookie jar with document.cookie semantics (set appends/overwrites, Max-Age=0 deletes). */
function jar(initial: Record<string, string>) {
  const store = new Map(Object.entries(initial));
  const writes: string[] = [];
  return {
    store,
    writes,
    get cookie() {
      return [...store].map(([k, v]) => `${k}=${v}`).join('; ');
    },
    set cookie(value: string) {
      writes.push(value);
      const [pair] = value.split(';');
      const [k, ...rest] = pair!.split('=');
      if (/Max-Age=0/.test(value)) store.delete(k!);
      else store.set(k!, rest.join('='));
    },
  };
}

function client(status: number, body: unknown) {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ path: new URL(String(input)).pathname, body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { calls, client: new FapiClient({ publishableKey: 'pk_test_x', baseUrl: 'https://f.example', fetchImpl, referral: false }) };
}

describe('exchangeBetterAuthSession (browser)', () => {
  it('reads the readable Better Auth cookie, exchanges with cookie delivery, and clears the old cookies', async () => {
    const doc = jar({ 'better-auth.session_token': 'tok.sig', 'better-auth.session_data': 'cache', other: '1' });
    const { client: c, calls } = client(200, { object: 'session', id: 'sess_1', user_id: 'user_1', jwt: 'jwt' });
    const out = await exchangeBetterAuthSession(c, { document: doc });
    expect(out).toEqual({ status: 'complete', sessionId: 'sess_1', userId: 'user_1', jwt: 'jwt' });
    expect(calls).toEqual([{ path: '/v1/client/migrations/better_auth/exchange', body: { token: 'tok.sig', delivery: 'cookie' } }]);
    expect(doc.store.has('better-auth.session_token')).toBe(false);
    expect(doc.store.has('better-auth.session_data')).toBe(false);
    expect(doc.store.get('other')).toBe('1');
  });

  it('returns none without a cookie (and makes no call)', async () => {
    const { client: c, calls } = client(200, {});
    expect(await exchangeBetterAuthSession(c, { document: jar({}) })).toEqual({ status: 'none' });
    expect(calls).toHaveLength(0);
  });

  it('hands back the attempt when a second factor is owed', async () => {
    const { client: c } = client(200, { object: 'sign_in_attempt', id: 'sia_1', status: 'needs_second_factor' });
    expect(await exchangeBetterAuthSession(c, { token: 't', document: jar({}) })).toEqual({ status: 'needs_second_factor', attemptId: 'sia_1' });
  });

  it('clears on a final refusal but keeps the cookie when the bridge is closed', async () => {
    const reused = jar({ 'better-auth.session_token': 't' });
    const r1 = client(400, { errors: [{ code: 'VERIFICATION_FAILED', message: 'used', meta: { bridge_outcome: 'reused' } }] });
    expect(await exchangeBetterAuthSession(r1.client, { document: reused })).toEqual({ status: 'refused', outcome: 'reused' });
    expect(reused.store.size).toBe(0);

    const closed = jar({ 'better-auth.session_token': 't' });
    const r2 = client(403, { errors: [{ code: 'FORBIDDEN', message: 'off', meta: { bridge_outcome: 'closed' } }] });
    expect(await exchangeBetterAuthSession(r2.client, { document: closed })).toEqual({ status: 'refused', outcome: 'closed' });
    expect(closed.store.size).toBe(1);
  });

  it('honours a custom prefix, the __Secure- name, and remember:false', async () => {
    const doc = jar({ '__Secure-myapp.session_token': 's' });
    expect(readBetterAuthCookie({ cookiePrefix: 'myapp', document: doc })).toBe('s');
    const { client: c, calls } = client(200, { object: 'session', id: 'x', jwt: 'j' });
    await exchangeBetterAuthSession(c, { cookiePrefix: 'myapp', document: doc, remember: false });
    expect(calls[0]!.body).toEqual({ token: 's', delivery: 'cookie', remember: false });
    clearBetterAuthCookies({ cookiePrefix: 'myapp', document: doc });
    expect(doc.writes.some((w) => w.startsWith('__Secure-myapp.session_token=;') && w.includes('Secure'))).toBe(true);
  });
});
