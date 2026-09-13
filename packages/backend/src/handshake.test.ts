import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createPkcePair, readHandshakeParams, redeemHandshake } from './handshake';

/**
 * PKCE binding of the cross-domain handshake (security review HIGH). The nonce
 * rides a return URL; on its own it would be a bearer credential. The redeeming
 * server generates a PKCE pair, sends only the SHA-256 `challenge` to the
 * handshake, keeps the `verifier` server-side, and proves possession of it at
 * redeem. A stolen nonce alone is then inert.
 */
describe('createPkcePair', () => {
  it('produces a verifier and challenge = base64url(sha256(verifier))', async () => {
    const { verifier, challenge } = await createPkcePair();
    expect(verifier.length).toBeGreaterThanOrEqual(43); // >= 32 bytes base64url
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/); // base64url, no padding
    // The challenge is exactly what the server will recompute and compare.
    const expected = createHash('sha256').update(verifier).digest('base64url');
    expect(challenge).toBe(expected);
  });

  it('produces a fresh, unguessable verifier each call', async () => {
    const a = await createPkcePair();
    const b = await createPkcePair();
    expect(a.verifier).not.toBe(b.verifier);
    expect(a.challenge).not.toBe(b.challenge);
  });
});

describe('redeemHandshake — PKCE proof', () => {
  const base = {
    fapiOrigin: 'https://id.atlasauth.net',
    publishableKey: 'pk_test_123',
    userId: 'user_abc',
    nonce: 'nonce_xyz',
    codeVerifier: 'the-secret-verifier',
  };

  it('sends the code_verifier (proof of possession) in the redeem body', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({ jwt: 'j', refresh_token: 'r', session_id: 's', expires_in: 60 }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    ) as unknown as typeof fetch;

    const session = await redeemHandshake({ ...base, fetchImpl });
    expect(session).toEqual({ jwt: 'j', refreshToken: 'r', sessionId: 's', expiresIn: 60 });

    const call = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call).toBeTruthy();
    const init = call![1] as RequestInit;
    const body = JSON.parse(init.body as string);
    expect(body.code_verifier).toBe('the-secret-verifier');
    expect(body.nonce).toBe('nonce_xyz');
  });

  it('returns null (signed-out signal, never throws) on a rejected proof', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 401 })) as unknown as typeof fetch;
    await expect(redeemHandshake({ ...base, fetchImpl })).resolves.toBeNull();
  });
});

describe('readHandshakeParams', () => {
  it('reads userId and nonce from an ok handshake return URL', () => {
    const parsed = readHandshakeParams('https://app.example.com/back?__atlas_hs=ok&__atlas_hu=user_1&__atlas_hn=n1');
    expect(parsed).toEqual({ userId: 'user_1', nonce: 'n1' });
  });

  it('returns null when the handshake did not complete ok', () => {
    expect(readHandshakeParams('?__atlas_hs=signed_out')).toBeNull();
    expect(readHandshakeParams('?__atlas_hs=error')).toBeNull();
  });
});
