import { describe, expect, it, vi } from 'vitest';
import { createWebCryptoDeviceKey, deviceProof } from './native-device-key';
import { sha256Base64Url } from './dpop';
import { exchangeTicketForNativeSession, warnRefreshTokenWithheld, withDeviceBoundSession, type SecretSlot } from './device-session';
import { parseNativeSession, refreshNativeSession, serializeNativeSession } from './native-session';

const dec = (p: string) => JSON.parse(atob(p.replace(/-/g, '+').replace(/_/g, '/')));
const b64uBytes = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const jwt = (sid: string) => `h.${btoa(JSON.stringify({ sid })).replace(/=+$/, '')}.s`;
const memSlot = (): SecretSlot & { value: string | null } => {
  const s = { value: null as string | null, getToken: () => s.value, setToken: (v: string) => void (s.value = v), clearToken: () => void (s.value = null) };
  return s;
};
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

describe('deviceProof', () => {
  it('signs a verifiable proof with ath, htu and the nonce', async () => {
    const key = createWebCryptoDeviceKey();
    const proof = await deviceProof(key, 'post', 'https://fapi.example.com/v1/client/sessions/s1/tokens?x=1', { refreshToken: 'rt_1', nonce: 'n1' });
    const [h, p, s] = proof.split('.');
    expect(dec(h!)).toMatchObject({ typ: 'dpop+jwt', alg: 'ES256', jwk: await key.publicJwk() });
    expect(dec(p!)).toMatchObject({ htm: 'POST', htu: 'https://fapi.example.com/v1/client/sessions/s1/tokens', nonce: 'n1' });
    expect(dec(p!).ath).toBeTruthy();
    expect(b64uBytes(s!).length).toBe(64);
    const pub = await crypto.subtle.importKey('jwk', await key.publicJwk(), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    expect(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, b64uBytes(s!), new TextEncoder().encode(`${h}.${p}`))).toBe(true);
  });
});

describe('withDeviceBoundSession', () => {
  it('binds on exchange, proves on refresh, answers the nonce once, keeps the rotated token', async () => {
    const key = createWebCryptoDeviceKey();
    const slot = memSlot();
    const seen: Array<{ path: string; body: Record<string, unknown>; dpop: string | null }> = [];
    const inner = (async (url: string, init: RequestInit) => {
      const path = new URL(url).pathname;
      const dpop = new Headers(init.headers).get('DPoP');
      seen.push({ path, body: JSON.parse(String(init.body)), dpop });
      if (path.endsWith('/exchange')) return json({ jwt: jwt('sess_1'), refresh_token: 'rt_1', binding: 'device_key' });
      if (!dpop || !dec(dpop.split('.')[1]!).nonce) return json({ code: 'DEVICE_PROOF_REQUIRED' }, 401, { 'DPoP-Nonce': 'n1' });
      return json({ jwt: jwt('sess_1'), refresh_token: 'rt_2' }, 200, { 'DPoP-Nonce': 'n2' });
    }) as unknown as typeof fetch;
    const f = withDeviceBoundSession(inner, { deviceKey: key, slot });

    await f('https://fapi.example.com/v1/client/tickets/exchange', { method: 'POST', body: JSON.stringify({ attempt_id: 'a', ticket: 't' }) });
    expect(seen[0]!.body).toMatchObject({ attempt_id: 'a', return_refresh_token: true, device_key: await key.publicJwk() });
    expect(JSON.parse(slot.value!)).toEqual({ refreshToken: 'rt_1', sessionId: 'sess_1', binding: 'device_key' });

    const res = await f('https://fapi.example.com/v1/client/sessions/sess_1/tokens', { method: 'POST', body: '{}' });
    expect(res.status).toBe(200);
    expect(seen.slice(1).map((c) => c.body)).toEqual([{ refresh_token: 'rt_1' }, { refresh_token: 'rt_1' }]);
    expect(seen[2]!.dpop).not.toBe(seen[1]!.dpop);
    expect(JSON.parse(slot.value!).refreshToken).toBe('rt_2');

    await f('https://fapi.example.com/v1/client/sessions/sess_1/tokens', { method: 'POST', body: '{}' });
    expect(dec(seen[3]!.dpop!.split('.')[1]!).nonce).toBe('n2');
  });

  it('forgets the token when the session is revoked and passes other calls through', async () => {
    const slot = memSlot();
    slot.value = JSON.stringify({ refreshToken: 'rt', sessionId: 's1' });
    const inner = vi.fn(async () => json({}));
    const f = withDeviceBoundSession(inner as unknown as typeof fetch, { deviceKey: createWebCryptoDeviceKey(), slot });
    await f('https://fapi.example.com/v1/client', { method: 'GET' });
    expect(slot.value).not.toBeNull();
    await f('https://fapi.example.com/v1/client/sessions/s1/revoke', { method: 'POST' });
    expect(slot.value).toBeNull();
  });

  it('refreshes with a proof before the start-up session check when the stored token has expired, and not when it is fresh', async () => {
    const key = createWebCryptoDeviceKey();
    const slot = memSlot();
    slot.value = JSON.stringify({ refreshToken: 'rt_1', sessionId: 'sess_1', binding: 'device_key' });
    const tok = (sid: string, expSec: number) => `h.${btoa(JSON.stringify({ sid, exp: expSec })).replace(/=+$/, '')}.s`;
    const fresh = tok('sess_1', Math.floor(Date.now() / 1000) + 60);
    const seen: Array<{ path: string; auth: string | null; dpop: string | null }> = [];
    const inner = (async (url: string, init: RequestInit) => {
      const h = new Headers(init.headers);
      seen.push({ path: new URL(url).pathname, auth: h.get('authorization'), dpop: h.get('DPoP') });
      if (url.endsWith('/tokens')) return json({ jwt: fresh, refresh_token: 'rt_2' }, 200, { 'DPoP-Nonce': 'n1' });
      return json({ object: 'client', session: { id: 'sess_1' }, jwt: fresh });
    }) as unknown as typeof fetch;
    const f = withDeviceBoundSession(inner, { deviceKey: key, slot });

    const expired = tok('sess_1', Math.floor(Date.now() / 1000) - 120);
    await f('https://fapi.example.com/v1/client', { headers: { authorization: `Bearer ${expired}`, 'x-publishable-key': 'pk_test_x' } });
    expect(seen.map((c) => c.path)).toEqual(['/v1/client/sessions/sess_1/tokens', '/v1/client']);
    expect(seen[0]!.auth).toBeNull();
    expect(seen[0]!.dpop).toBeTruthy();
    expect(seen[1]!.auth).toBe(`Bearer ${fresh}`);
    expect(JSON.parse(slot.value!).refreshToken).toBe('rt_2');

    seen.length = 0;
    await f('https://fapi.example.com/v1/client', { headers: { authorization: `Bearer ${fresh}` } });
    expect(seen.map((c) => c.path)).toEqual(['/v1/client']);
  });

  it('warns once in development, naming the reason and the guide, when the refresh token is withheld', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const inner = (async () => json({ jwt: jwt('s'), refresh_token: null, refresh_token_withheld: { reason: 'mfa_required', message: 'Verify a second factor.', docs_url: 'https://atlasauth.net/docs/native-device-bound-sessions' } })) as unknown as typeof fetch;
    const f = withDeviceBoundSession(inner, { deviceKey: createWebCryptoDeviceKey(), slot: memSlot() });
    await f('https://fapi.example.com/v1/client/tickets/exchange', { method: 'POST', body: '{}' });
    warnRefreshTokenWithheld({ reason: 'mfa_required' });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain('mfa_required');
    expect(String(warn.mock.calls[0]![0])).toContain('native-device-bound-sessions');
    warn.mockRestore();
  });
});

describe('native session binding', () => {
  it('parses old sessions and round-trips the binding', () => {
    const old = JSON.stringify({ sessionToken: 'a', refreshToken: 'b', sessionId: 's', expiresInSeconds: 60 });
    expect(parseNativeSession(old)).toEqual({ sessionToken: 'a', refreshToken: 'b', sessionId: 's', expiresInSeconds: 60 });
    const bound = { sessionToken: 'a', refreshToken: 'b', sessionId: 's', expiresInSeconds: 60, binding: 'device_key' as const, deviceKeyId: 'k' };
    expect(parseNativeSession(serializeNativeSession(bound))).toEqual(bound);
  });

  it('refreshNativeSession retries once on a nonce challenge and refuses a bound session with no key', async () => {
    const key = createWebCryptoDeviceKey();
    let calls = 0;
    const nonces: string[] = [];
    const fetchImpl = (async (_u: string, init: RequestInit) => {
      calls += 1;
      const n = dec(new Headers(init.headers).get('DPoP')!.split('.')[1]!).nonce;
      if (n) nonces.push(n);
      return calls === 1 ? json({}, 401, { 'DPoP-Nonce': 'nx' }) : json({ jwt: 'j', refresh_token: 'rt2', expires_in: 60 }, 200, { 'DPoP-Nonce': 'ny' });
    }) as unknown as typeof fetch;
    let kept = '';
    const out = await refreshNativeSession({ baseUrl: 'https://fapi.example.com', publishableKey: 'pk', sessionId: 's', refreshToken: 'rt', fetchImpl, deviceKey: key, binding: 'device_key', deviceKeyId: 'k', onNonce: (n) => (kept = n) });
    expect(out).toMatchObject({ refreshToken: 'rt2', binding: 'device_key', deviceKeyId: 'k' });
    expect(nonces).toEqual(['nx']);
    expect(kept).toBe('ny');
    expect(await refreshNativeSession({ baseUrl: 'https://fapi.example.com', publishableKey: 'pk', sessionId: 's', refreshToken: 'rt', fetchImpl, binding: 'device_key' })).toBeNull();
  });

  it('exchangeTicketForNativeSession returns a bound session', async () => {
    const key = createWebCryptoDeviceKey();
    const fetchImpl = (async () => json({ jwt: jwt('sess_9'), refresh_token: 'rt', binding: 'device_key', expires_in: 60 })) as unknown as typeof fetch;
    const s = await exchangeTicketForNativeSession({ baseUrl: 'https://fapi.example.com', publishableKey: 'pk', attemptId: 'a', ticket: 't', deviceKey: key, fetchImpl });
    expect(s).toMatchObject({ sessionId: 'sess_9', refreshToken: 'rt', binding: 'device_key', deviceKeyId: await key.thumbprint() });
  });
});

describe('withDeviceBoundSession on a device that keeps cookies', () => {
  it('refreshes with the rotated token every time, whatever cookies the server set', async () => {
    const key = createWebCryptoDeviceKey();
    const slot = memSlot();
    slot.value = JSON.stringify({ refreshToken: 'rt_0', sessionId: 'sess_1', binding: 'device_key' });
    // The server: rotates the refresh token on every refresh and also sets it as a cookie; prefers a cookie token over the
    // body's; answers only the current token with a proof made for exactly that token; hands the new token back in the
    // body only to a caller that sent no cookie. Anything else is 401.
    let current = 'rt_0';
    let n = 0;
    const server = (async (_url: string, init: RequestInit) => {
      const headers = new Headers(init.headers);
      const cookie = /(?:^|; )__atlas_rt=([^;]+)/.exec(headers.get('cookie') ?? '')?.[1];
      const presented = cookie ?? (JSON.parse(String(init.body)) as { refresh_token?: string }).refresh_token;
      const proof = headers.get('DPoP');
      const ath = proof ? dec(proof.split('.')[1]!).ath : null;
      if (!presented || presented !== current || ath !== (await sha256Base64Url(presented))) return json({ code: 'UNAUTHENTICATED' }, 401, { 'DPoP-Nonce': 'n' });
      current = `rt_${++n}`;
      return json({ jwt: jwt('sess_1'), ...(cookie ? {} : { refresh_token: current }) }, 200, { 'DPoP-Nonce': 'n', 'set-cookie': `__atlas_rt=${current}` });
    }) as unknown as typeof fetch;
    // The platform's HTTP stack: keeps Set-Cookie and sends it back unless the request says credentials: 'omit'.
    let jar = '';
    const device = (async (url: string, init: RequestInit) => {
      const headers = new Headers(init.headers);
      if (jar && init.credentials !== 'omit') headers.set('cookie', jar);
      const res = await server(url, { ...init, headers });
      const set = res.headers.get('set-cookie');
      if (set && init.credentials !== 'omit') jar = set;
      return res;
    }) as unknown as typeof fetch;
    // The sign-in itself leaves the cookie behind, as on a device.
    jar = '__atlas_rt=rt_0';

    const f = withDeviceBoundSession(device, { deviceKey: key, slot });
    const statuses: number[] = [];
    for (let i = 0; i < 3; i++) statuses.push((await f('https://fapi.example.com/v1/client/sessions/sess_1/tokens', { method: 'POST', credentials: 'include' })).status);
    expect(statuses).toEqual([200, 200, 200]);
    expect(JSON.parse(slot.value!).refreshToken).toBe('rt_3');
  });
});
