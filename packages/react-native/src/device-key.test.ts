import { describe, expect, it } from 'vitest';
import { p256 } from '@noble/curves/p256';
import { sha256 } from '@noble/hashes/sha256';
import { deviceProof, type FapiClient } from '@atlasauth/js';
import { createSecureDeviceKey, splitDeviceStorage } from './device-key';
import { createInMemoryStorage } from './storage';
import { createAtlasStore } from './store';

const b64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

describe('createSecureDeviceKey', () => {
  it('signs raw 64-byte r||s that verify against the public JWK, and keeps one key across loads', async () => {
    const storage = createInMemoryStorage();
    const key = createSecureDeviceKey({ storage });
    const jwk = await key.publicJwk();
    expect(jwk).toMatchObject({ kty: 'EC', crv: 'P-256' });
    const data = new TextEncoder().encode('hello');
    const sig = await key.sign(data);
    expect(sig.length).toBe(64);
    const pub = new Uint8Array([4, ...b64u(jwk.x), ...b64u(jwk.y)]);
    expect(p256.verify(sig, sha256(data), pub)).toBe(true);
    // A fresh object over the same storage is the same device.
    const again = createSecureDeviceKey({ storage });
    expect(await again.publicJwk()).toEqual(jwk);
    expect(await again.thumbprint()).toBe(await key.thumbprint());
  });

  it('produces a proof whose signature verifies', async () => {
    const key = createSecureDeviceKey({ storage: createInMemoryStorage() });
    const proof = await deviceProof(key, 'POST', 'https://fapi.example.test/v1/client/sessions/s/tokens', { refreshToken: 'rt', nonce: 'n' });
    const [h, p, s] = proof.split('.');
    const jwk = await key.publicJwk();
    const pub = new Uint8Array([4, ...b64u(jwk.x), ...b64u(jwk.y)]);
    expect(p256.verify(b64u(s!), sha256(new TextEncoder().encode(`${h}.${p}`)), pub)).toBe(true);
  });

  it('uses the injected random source', async () => {
    const storage = createInMemoryStorage();
    const key = createSecureDeviceKey({ storage, random: (n) => new Uint8Array(n).fill(7) });
    await key.publicJwk();
    expect(await storage.getToken()).toBe('07'.repeat(32));
  });
});

describe('splitDeviceStorage', () => {
  it('keeps two values in one slot and clears one at a time', async () => {
    const storage = createInMemoryStorage();
    const { key, session } = splitDeviceStorage(storage);
    await Promise.all([key.setToken('k'), session.setToken('s')]);
    expect([await key.getToken(), await session.getToken()]).toEqual(['k', 's']);
    await session.clearToken();
    expect([await key.getToken(), await session.getToken()]).toEqual(['k', null]);
  });
});

describe('store wiring', () => {
  it('turns device binding on only when deviceStorage is given', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl = (async (_u: string, init: RequestInit) => {
      if (typeof init.body === 'string') bodies.push(JSON.parse(init.body));
      return new Response('{}', { status: 400, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const mk = (extra: object) => (createAtlasStore({ publishableKey: 'pk_test_x', frontendApi: 'https://fapi.example.test', fetchImpl, ...extra }) as unknown as { client: FapiClient });
    await mk({}).client.post('/v1/client/tickets/exchange', { attempt_id: 'a', ticket: 't' });
    expect(bodies[0]).toEqual({ attempt_id: 'a', ticket: 't' });
    await mk({ deviceStorage: createInMemoryStorage() }).client.post('/v1/client/tickets/exchange', { attempt_id: 'a', ticket: 't' });
    expect(bodies[1]).toMatchObject({ return_refresh_token: true, device_key: { kty: 'EC', crv: 'P-256' } });
  });
});
