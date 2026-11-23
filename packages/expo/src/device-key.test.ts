import { describe, expect, it, vi } from 'vitest';
import { withDeviceBoundSession } from '@atlasauth/js';
import { createExpoDeviceKey, DEFAULT_DEVICE_KEY } from './device-key';
import { createCacheFetch } from './cache-fetch';
import { createInMemoryTokenCache, tokenStorageFor } from './token-cache';

// `react-native` itself cannot load in node: take only the device-key module of `@atlasauth/react-native`.
vi.mock('@atlasauth/react-native', async () => {
  const { createSecureDeviceKey } = await import('@atlasauth/react-native/dist/device-key.js');
  return { createSecureDeviceKey };
});

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const jwt = `h.${btoa(JSON.stringify({ sid: 'sess_1' })).replace(/=+$/, '')}.s`;

describe('createExpoDeviceKey', () => {
  it('keeps the private key only in the cache, under the default key, and reuses it', async () => {
    const cache = createInMemoryTokenCache();
    const a = createExpoDeviceKey({ cache });
    const jwk = await a.publicJwk();
    expect(await cache.getToken(DEFAULT_DEVICE_KEY)).toMatch(/^[0-9a-f]{64}$/);
    expect(await createExpoDeviceKey({ cache }).publicJwk()).toEqual(jwk);
    expect((await a.sign(new TextEncoder().encode('x'))).length).toBe(64);
  });
});

describe('default wiring (device key under the cache fetch)', () => {
  it('signs in bound and refreshes with a proof, with no app code', async () => {
    const cache = createInMemoryTokenCache();
    const seen: Array<{ path: string; body: Record<string, unknown>; dpop: string | null; auth: string | null }> = [];
    const server = (async (url: string, init: RequestInit) => {
      const path = new URL(url).pathname;
      const h = new Headers(init.headers);
      seen.push({ path, body: JSON.parse(String(init.body)), dpop: h.get('DPoP'), auth: h.get('authorization') });
      return path.endsWith('/exchange')
        ? json({ jwt, refresh_token: 'rt_1', binding: 'device_key' }, 200, { 'DPoP-Nonce': 'n1' })
        : json({ jwt, refresh_token: 'rt_2' });
    }) as unknown as typeof fetch;
    const bound = withDeviceBoundSession(server, { deviceKey: createExpoDeviceKey({ cache }), slot: tokenStorageFor(cache, 'atlas.device-session') });
    const f = createCacheFetch({ cache, key: 'atlas.session', fetchImpl: bound });

    await f('https://fapi.example.test/v1/client/tickets/exchange', { method: 'POST', body: JSON.stringify({ attempt_id: 'a', ticket: 't' }) });
    expect(seen[0]!.body).toMatchObject({ return_refresh_token: true, device_key: { kty: 'EC', crv: 'P-256' } });
    await new Promise((r) => setTimeout(r, 0));
    await f('https://fapi.example.test/v1/client/sessions/sess_1/tokens', { method: 'POST', body: '{}' });
    expect(seen[1]!.body).toEqual({ refresh_token: 'rt_1' });
    expect(seen[1]!.dpop).toBeTruthy();
    expect(seen[1]!.auth).toBe(`Bearer ${jwt}`);
    expect(JSON.parse((await cache.getToken('atlas.device-session'))!).refreshToken).toBe('rt_2');
  });
});
