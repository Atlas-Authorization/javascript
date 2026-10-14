import { describe, expect, it, vi } from 'vitest';
import { AtlasBackend } from './verify';
import { createTestIssuer } from './testing';

/**
 * §1.3(c): a customer's CI must validate Atlas-minted test session JWTs with NO
 * network call to a JWKS URL. Every test here runs fully offline — the fetch
 * these back-ends are handed throws if anything ever reaches for the network.
 */

/** A fetch that fails the test the instant the "offline" path touches it. */
const forbiddenFetch = vi.fn(async () => {
  throw new Error('network call attempted during hermetic verification');
}) as unknown as typeof fetch;

describe('createTestIssuer — hermetic offline verification', () => {
  it('verifies a fixture-minted token via the static jwks (ok:true), no fetch', async () => {
    const fx = await createTestIssuer();
    const atlas = new AtlasBackend({
      jwks: fx.jwks,
      issuer: fx.issuer,
      fetchImpl: forbiddenFetch,
    });

    const result = await atlas.verify(await fx.mintSession({ sub: 'user_x' }));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.claims.sub).toBe('user_x');
      // The §13.1 session marker the minted token carries.
      expect(result.claims.token_use).toBe('session');
    }
    expect((forbiddenFetch as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });

  it('rejects a token minted for a different issuer', async () => {
    const fx = await createTestIssuer();
    const atlas = new AtlasBackend({ jwks: fx.jwks, issuer: fx.issuer });

    const forged = await fx.mintSession({ iss: 'https://evil.fapi.atlas.local' });
    expect(await atlas.verify(forged)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('rejects a tampered token', async () => {
    const fx = await createTestIssuer();
    const atlas = new AtlasBackend({ jwks: fx.jwks, issuer: fx.issuer });

    // Flip the last three signature chars — the signature no longer matches.
    const tampered = (await fx.mintSession()).slice(0, -3) + 'aaa';
    expect(await atlas.verify(tampered)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('honours the azp allowlist against the fixture default azp', async () => {
    const fx = await createTestIssuer({ issuer: 'https://tenant.fapi.atlas.local' });
    const atlas = new AtlasBackend({
      jwks: fx.jwks,
      issuer: fx.issuer,
      authorizedParties: ['https://app.customer.com'],
    });

    // Default azp is the issuer, which is not in the allowlist → refused.
    expect(await atlas.verify(await fx.mintSession())).toEqual({
      ok: false,
      reason: 'unauthorized_party',
    });
    // Override azp to an allowed origin → accepted.
    const ok = await atlas.verify(await fx.mintSession({ azp: 'https://app.customer.com' }));
    expect(ok.ok).toBe(true);
  });

  it('rejects an expired token minted with a back-dated clock', async () => {
    const fx = await createTestIssuer({ now: () => 1_000_000_000_000 });
    // Verifier's clock is well past the 60 s lifetime + 5 s skew.
    const atlas = new AtlasBackend({
      jwks: fx.jwks,
      issuer: fx.issuer,
      now: () => 1_000_000_000_000 + 120_000,
    });

    expect(await atlas.verify(await fx.mintSession())).toEqual({ ok: false, reason: 'invalid' });
  });

  it('refuses two key sources (no key source now means discovery)', async () => {
    const fx = await createTestIssuer();
    expect(() => new AtlasBackend({ issuer: fx.issuer })).not.toThrow();
    expect(
      () =>
        new AtlasBackend({
          issuer: fx.issuer,
          jwks: fx.jwks,
          jwksUrl: 'https://x/.well-known/jwks.json',
        }),
    ).toThrow(/not both/);
  });
});

/**
 * Regression: the fixture and the static-jwks option must not change the
 * fetch-from-URL path. The same fixture keypair, served over a mocked JWKS
 * endpoint, still verifies exactly as before.
 */
describe('createTestIssuer — the jwksUrl path still works', () => {
  it('verifies through a fetched JWKS', async () => {
    const fx = await createTestIssuer();
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify(fx.jwks), { status: 200 }),
    ) as unknown as typeof fetch;

    const atlas = new AtlasBackend({
      jwksUrl: `${fx.issuer}/.well-known/jwks.json`,
      issuer: fx.issuer,
      fetchImpl,
    });

    const result = await atlas.verify(await fx.mintSession({ sub: 'user_url' }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.claims.sub).toBe('user_url');
    // The URL path did fetch — exactly once.
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });
});
