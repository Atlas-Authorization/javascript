import { describe, expect, it, vi } from 'vitest';
import { FapiClient } from './fapi';
import { deviceKeyMessage, registerDeviceKey, signInWithDeviceKey, webCryptoSigner } from './device-key';

function scripted() {
  const calls: { path: string; body: Record<string, unknown> | null }[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    calls.push({ path, body });
    const out = path.endsWith('/challenge') ? { nonce: 'n1', expires_at: 1 } : { id: 'dvk_1', status: 'complete' };
    return new Response(JSON.stringify(out), { status: 201, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { client: new FapiClient({ publishableKey: 'pk_test_x', baseUrl: 'https://f.example', fetchImpl, referral: false }), calls };
}

describe('device key flows', () => {
  it('registers with a proof-of-possession signature over the register message', async () => {
    const { client, calls } = scripted();
    const signer = webCryptoSigner();
    const res = await registerDeviceKey({ client, signer, instanceId: 'ins_1', label: 'Pixel', platform: 'android' });
    expect(res.ok).toBe(true);
    const post = calls[1]!;
    expect(post.path).toBe('/v1/client/me/device_keys');
    const jwk = post.body!.public_key as { x: string };
    const sig = post.body!.signature as string;
    // Verify the signature the way the server does.
    const key = await crypto.subtle.importKey('jwk', { ...jwk, kty: 'EC', crv: 'P-256' } as JsonWebKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    const msg = new TextEncoder().encode(deviceKeyMessage({ purpose: 'register', instanceId: 'ins_1', keyId: jwk.x, nonce: 'n1' }));
    const raw = Uint8Array.from(atob(sig.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
    expect(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, raw, msg)).toBe(true);
  });

  it('signs in with challenge then finish', async () => {
    const { client, calls } = scripted();
    const signer = webCryptoSigner();
    await signer.createKey({ biometric: false });
    await signInWithDeviceKey({ client, signer, instanceId: 'ins_1', deviceKeyId: 'dvk_1' });
    expect(calls.map((c) => c.path)).toEqual(['/v1/client/sign_ins/device_key/challenge', '/v1/client/sign_ins/device_key/finish']);
    expect(calls[1]!.body).toMatchObject({ device_key_id: 'dvk_1', nonce: 'n1' });
  });
});
